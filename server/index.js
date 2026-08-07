'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Papa = require('papaparse');
const { runPipeline, extractSources, DEFAULT_CONFIG } = require('./engine/pipeline');
const { bufferToText } = require('./lib/filetext');
const { matchCandidates } = require('./engine/match');
const { suggestImprovements } = require('./engine/suggest');
const { insights } = require('./analytics');
const { rateLimit } = require('./lib/ratelimit');
const mailer = require('./lib/mailer');
const auth = require('./auth');
const store = require('./store');
const audit = require('./audit');

// roles allowed to mutate candidate data (viewers are read-only)
const canWrite = auth.requireRole('admin', 'recruiter');
// throttle credential endpoints against stuffing / signup spam
const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const CONFIGS = path.join(ROOT, 'configs');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 20, fileSize: 8 * 1024 * 1024 },
});

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---- auth ------------------------------------------------------------

app.post('/api/auth/register', authLimiter, (req, res) => {
  try {
    const { email, password, orgName } = req.body || {};
    const session = auth.register(email, password, orgName);
    audit.record(session.org_id, session.email, 'org.create', session.org_name);
    res.json(session);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json(auth.login(email, password));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
  auth.logout(req.token);
  res.json({ ok: true });
});

// Forgot password: always reports success (don't leak whether the email is
// registered). When it is, we email a reset link; in dev the link is returned
// so a solo developer can use it without a mail server.
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  const result = auth.requestPasswordReset(email);
  if (result) {
    const link = mailer.appUrl(`/?reset=${result.token}`);
    await mailer.send({
      to: result.email,
      subject: 'Reset your Profile Transformer password',
      text: `Open this link to set a new password (valid 30 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    });
    if (!mailer.isProd) return res.json({ ok: true, devLink: link });
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', authLimiter, (req, res) => {
  try {
    const { token, password } = req.body || {};
    res.json(auth.resetPassword(token, password));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- teammate invites by link ----------------------------------------

app.get('/api/invites/:token', (req, res) => {
  try {
    res.json(auth.getInvite(req.params.token));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/invites/:token/accept', authLimiter, (req, res) => {
  try {
    res.json(auth.acceptInvite(req.params.token, (req.body || {}).password));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  const { email, role, org_id, org_name } = req.user;
  res.json({ email, role, org_id, org_name });
});

// ---- organization: members (admin) and audit log (admin) --------------

app.get('/api/org/members', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json({ members: auth.listMembers(req.user.org_id) });
});

app.post('/api/org/members', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    const member = auth.invite(req.user.org_id, email, password, role);
    audit.record(req.user.org_id, req.user.email, 'member.invite', member.email, { role: member.role });
    res.json(member);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Invite a teammate by link: they open it and set their own password (no
// admin-chosen password). Emails the link; returns it directly in dev.
app.post('/api/org/invites', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const { email, role } = req.body || {};
    const inv = auth.createInvite(req.user.org_id, email, role, req.user.email);
    const link = mailer.appUrl(`/?invite=${inv.token}`);
    await mailer.send({
      to: inv.email,
      subject: `You're invited to ${req.user.org_name} on Profile Transformer`,
      text: `${req.user.email} invited you to join ${req.user.org_name} as ${inv.role}.\n\nAccept and set your password here:\n\n${link}`,
    });
    audit.record(req.user.org_id, req.user.email, 'member.invite', inv.email, { role: inv.role });
    res.json({ email: inv.email, role: inv.role, link, devLink: mailer.isProd ? undefined : link });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/audit', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json({ entries: audit.list(req.user.org_id, { limit: req.query.limit, action: req.query.action }) });
});

// Full org backup (download) and restore (upload) — data durability.
app.get('/api/org/backup', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  audit.record(req.user.org_id, req.user.email, 'org.backup', null);
  res.setHeader('Content-Disposition', 'attachment; filename="candidate-db-backup.json"');
  res.json(store.exportOrg(req.user.org_id));
});

app.post('/api/org/restore', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  try {
    const result = store.importOrg(req.user.org_id, req.body || {});
    audit.record(req.user.org_id, req.user.email, 'org.restore', null, result);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- stateless playground (no auth, nothing stored) ------------------

app.get('/api/samples', (_req, res) => {
  const files = [
    { name: 'recruiter.csv', type: 'csv' },
    { name: 'ats.json', type: 'ats' },
    { name: 'github.json', type: 'github' },
    { name: 'recruiter_notes.txt', type: 'notes' },
    { name: 'broken.json', type: 'ats' },
  ].map((f) => ({ ...f, content: readIf(path.join(SAMPLES, f.name)) || '' }));

  const configs = {
    default: JSON.parse(readIf(path.join(CONFIGS, 'default.json')) || '{}'),
    recruiter_shortlist: JSON.parse(readIf(path.join(CONFIGS, 'custom.example.json')) || '{}'),
  };

  res.json({ sources: files, configs });
});

app.post('/api/transform', async (req, res) => {
  try {
    const { sources, config, allowNetwork } = req.body || {};
    if (!Array.isArray(sources)) {
      return res.status(400).json({ error: 'body.sources must be an array of { name, content, type? }' });
    }
    const cfg = config && Object.keys(config).length ? config : DEFAULT_CONFIG;
    const result = await runPipeline(sources, cfg, { allowNetwork: !!allowNetwork });
    res.json(result);
  } catch (err) {
    if (err && err.code === 'PROJECTION_MISSING_FIELD') {
      return res.status(422).json({ error: err.message, code: err.code, field: err.field });
    }
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// ---- candidate database (auth required, persisted) --------------------

// Upload source files (CSV / JSON / TXT / PDF / DOCX resumes). Each file is
// extracted, stored, and merged against every subject already in the DB.
app.post('/api/upload', auth.requireAuth, canWrite, upload.array('files'), async (req, res) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'no files uploaded (multipart field name: "files")' });
    }
    const sources = [];
    for (const f of req.files) {
      const { text, links } = await bufferToText(f.buffer, f.originalname);
      sources.push({ name: f.originalname, content: text, links });
    }
    const allowNetwork = req.body.allowNetwork === 'true';
    const { sourceResults, sourceReport } = await extractSources(sources, { allowNetwork });
    const { subjectsAdded, totalCandidates } = store.ingestSources(req.user.org_id, sourceResults);
    audit.record(req.user.org_id, req.user.email, 'candidates.upload', null, {
      files: sourceReport.map((s) => s.source), subjectsAdded, totalCandidates,
    });
    res.json({ sources: sourceReport, subjectsAdded, totalCandidates });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Seed the caller's org with the built-in sample candidates so a new account
// has something to explore in one click.
app.post('/api/demo/seed', auth.requireAuth, canWrite, async (req, res) => {
  try {
    const files = ['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt'];
    const sources = files
      .map((name) => ({ name, content: readIf(path.join(SAMPLES, name)) }))
      .filter((s) => s.content);
    const { sourceResults } = await extractSources(sources, { allowNetwork: false });
    const { subjectsAdded, totalCandidates } = store.ingestSources(req.user.org_id, sourceResults);
    audit.record(req.user.org_id, req.user.email, 'demo.seed', null, { subjectsAdded, totalCandidates });
    res.json({ subjectsAdded, totalCandidates });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/candidates', auth.requireAuth, (req, res) => {
  const { q, skill, stage, tag } = req.query;
  res.json({ candidates: store.listCandidates(req.user.org_id, { q, skill, stage, tag }), stages: store.STAGES });
});

// Bulk actions across a set of candidate ids. Declared before the :id routes.
app.post('/api/candidates/bulk/stage', auth.requireAuth, canWrite, (req, res) => {
  try {
    const { ids, stage } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'body.ids must be an array' });
    const updated = store.setStageBulk(req.user.org_id, ids, stage, req.user.email);
    audit.record(req.user.org_id, req.user.email, 'candidates.bulk_stage', null, { stage, count: updated });
    res.json({ updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/candidates/bulk/delete', auth.requireAuth, canWrite, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'body.ids must be an array' });
  const deleted = store.deleteCandidates(req.user.org_id, ids);
  audit.record(req.user.org_id, req.user.email, 'candidates.bulk_delete', null, { count: deleted });
  res.json({ deleted });
});

app.get('/api/candidates/:id', auth.requireAuth, (req, res) => {
  const candidate = store.getCandidate(req.user.org_id, req.params.id);
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  res.json(candidate);
});

// Workflow metadata: pipeline stage, tags, private note (one endpoint each).
app.put('/api/candidates/:id/stage', auth.requireAuth, canWrite, (req, res) => {
  try {
    const updated = store.setStage(req.user.org_id, req.params.id, (req.body || {}).stage, req.user.email);
    audit.record(req.user.org_id, req.user.email, 'candidate.stage', req.params.id, { stage: (req.body || {}).stage });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/candidates/:id/tags', auth.requireAuth, canWrite, (req, res) => {
  try {
    res.json(store.setTags(req.user.org_id, req.params.id, (req.body || {}).tags, req.user.email));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/candidates/:id/note', auth.requireAuth, canWrite, (req, res) => {
  try {
    res.json(store.setNote(req.user.org_id, req.params.id, (req.body || {}).note, req.user.email));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Manual correction of a field. Recorded with provenance source "human"
// and confidence 1.0; survives future uploads and re-merges.
app.patch('/api/candidates/:id', auth.requireAuth, canWrite, (req, res) => {
  try {
    const { field, value } = req.body || {};
    const updated = store.setOverride(req.user.org_id, req.params.id, field, value, req.user.email);
    audit.record(req.user.org_id, req.user.email, 'candidate.override', req.params.id, { field });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/candidates/:id/overrides/:field', auth.requireAuth, canWrite, (req, res) => {
  try {
    const result = store.clearOverride(req.user.org_id, req.params.id, req.params.field);
    audit.record(req.user.org_id, req.user.email, 'candidate.override_clear', req.params.id, { field: req.params.field });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/candidates/:id', auth.requireAuth, canWrite, (req, res) => {
  try {
    store.deleteCandidate(req.user.org_id, req.params.id);
    audit.record(req.user.org_id, req.user.email, 'candidate.delete', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Rank stored candidates against a pasted job description. Requirements are
// read from the JD text; every score component is explained in the response.
// Pass blind=true to redact identity from the ranked results (bias-blind).
app.post('/api/match', auth.requireAuth, (req, res) => {
  const { jd, q, skill, blind } = req.body || {};
  if (!jd || !String(jd).trim()) return res.status(400).json({ error: 'body.jd (job description text) is required' });
  const result = matchCandidates(jd, store.listCandidates(req.user.org_id, { q, skill }), { blind: !!blind });
  audit.record(req.user.org_id, req.user.email, 'candidates.match', null, {
    blind: !!blind, skills: result.requirements.skills, candidates: result.results.length,
  });
  res.json(result);
});

// What this candidate could add/fix to raise their profile quality score.
app.get('/api/candidates/:id/suggestions', auth.requireAuth, (req, res) => {
  const candidate = store.getCandidate(req.user.org_id, req.params.id);
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  res.json({ suggestions: suggestImprovements(candidate.record, candidate.field_confidence) });
});

// Screening analytics: funnel, confidence distribution, skill supply, sources.
app.get('/api/insights', auth.requireAuth, (req, res) => {
  res.json(insights(req.user.org_id));
});

// Saved JD templates (reusable job-description text).
app.get('/api/jd-templates', auth.requireAuth, (req, res) => res.json({ templates: store.listJdTemplates(req.user.org_id) }));
app.post('/api/jd-templates', auth.requireAuth, canWrite, (req, res) => {
  try {
    const { name, jd } = req.body || {};
    res.json(store.saveJdTemplate(req.user.org_id, name, jd, req.user.email));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
app.delete('/api/jd-templates/:id', auth.requireAuth, canWrite, (req, res) => {
  try {
    store.deleteJdTemplate(req.user.org_id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- job requisitions -------------------------------------------------

const jobHandler = (fn) => (req, res) => {
  try { res.json(fn(req)); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};

app.get('/api/jobs', auth.requireAuth, jobHandler((req) => ({ jobs: store.listJobs(req.user.org_id), stages: store.STAGES })));

app.post('/api/jobs', auth.requireAuth, canWrite, jobHandler((req) => {
  const job = store.createJob(req.user.org_id, req.body || {}, req.user.email);
  audit.record(req.user.org_id, req.user.email, 'job.create', String(job.id), { title: job.title });
  return job;
}));

app.get('/api/jobs/:id', auth.requireAuth, (req, res) => {
  const job = store.getJob(req.user.org_id, req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

app.patch('/api/jobs/:id', auth.requireAuth, canWrite, jobHandler((req) => {
  const job = store.updateJob(req.user.org_id, req.params.id, req.body || {});
  audit.record(req.user.org_id, req.user.email, 'job.update', String(job.id), { status: job.status });
  return job;
}));

app.delete('/api/jobs/:id', auth.requireAuth, canWrite, jobHandler((req) => {
  store.deleteJob(req.user.org_id, req.params.id);
  audit.record(req.user.org_id, req.user.email, 'job.delete', String(req.params.id));
  return { ok: true };
}));

app.get('/api/jobs/:id/candidates', auth.requireAuth, jobHandler((req) => ({
  candidates: store.listJobCandidates(req.user.org_id, req.params.id),
  stages: store.STAGES,
})));

app.post('/api/jobs/:id/candidates', auth.requireAuth, canWrite, jobHandler((req) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) throw Object.assign(new Error('body.ids must be an array'), { status: 400 });
  const added = store.addCandidatesToJob(req.user.org_id, req.params.id, ids);
  audit.record(req.user.org_id, req.user.email, 'job.add_candidates', String(req.params.id), { added });
  return { added };
}));

app.delete('/api/jobs/:id/candidates/:cid', auth.requireAuth, canWrite, jobHandler((req) => {
  store.removeCandidateFromJob(req.user.org_id, req.params.id, req.params.cid);
  return { ok: true };
}));

app.put('/api/jobs/:id/candidates/:cid/stage', auth.requireAuth, canWrite, jobHandler((req) => {
  store.setJobStage(req.user.org_id, req.params.id, req.params.cid, (req.body || {}).stage);
  audit.record(req.user.org_id, req.user.email, 'job.stage', String(req.params.id), { candidate: req.params.cid, stage: (req.body || {}).stage });
  return { ok: true };
}));

// Rank the whole candidate pool against this job's JD (to add the best fits).
app.post('/api/jobs/:id/match', auth.requireAuth, (req, res) => {
  const job = store.getJob(req.user.org_id, req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!job.description || !job.description.trim()) return res.status(400).json({ error: 'this job has no description to match against' });
  const result = matchCandidates(job.description, store.listCandidates(req.user.org_id), { blind: !!(req.body || {}).blind });
  audit.record(req.user.org_id, req.user.email, 'job.match', String(job.id), { blind: !!(req.body || {}).blind, candidates: result.results.length });
  res.json(result);
});

// Saved views: named q/skill filter combinations.
app.get('/api/views', auth.requireAuth, (req, res) => res.json({ views: store.listViews(req.user.org_id) }));
app.post('/api/views', auth.requireAuth, canWrite, (req, res) => {
  try {
    const { name, q, skill } = req.body || {};
    res.json(store.saveView(req.user.org_id, name, q, skill, req.user.email));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
app.delete('/api/views/:id', auth.requireAuth, canWrite, (req, res) => {
  try {
    store.deleteView(req.user.org_id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Exports of the stored candidate database, respecting the q/skill filters:
// CSV and XLSX as one flattened row per person, JSON as full canonical records.
function flattenForExport({ record: r }) {
  return {
    candidate_id: r.candidate_id,
    full_name: r.full_name,
    primary_email: r.emails[0] || null,
    phone: r.phones[0] || null,
    city: r.location ? r.location.city : null,
    country: r.location ? r.location.country : null,
    headline: r.headline,
    years_experience: r.years_experience,
    skills: r.skills.map((s) => s.name).join('; ') || null,
    github: r.links.github,
    linkedin: r.links.linkedin,
    overall_confidence: r.overall_confidence,
  };
}

app.get('/api/export.csv', auth.requireAuth, (req, res) => {
  const rows = store.listCandidates(req.user.org_id, req.query).map(flattenForExport);
  audit.record(req.user.org_id, req.user.email, 'candidates.export', 'csv', { rows: rows.length });
  const csv = Papa.unparse(rows, { newline: '\n' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="candidates.csv"');
  res.send(csv);
});

app.get('/api/export.json', auth.requireAuth, (req, res) => {
  const records = store.listCandidates(req.user.org_id, req.query).map((c) => c.record);
  audit.record(req.user.org_id, req.user.email, 'candidates.export', 'json', { rows: records.length });
  res.setHeader('Content-Disposition', 'attachment; filename="candidates.json"');
  res.json(records);
});

app.get('/api/export.xlsx', auth.requireAuth, async (req, res) => {
  const ExcelJS = require('exceljs'); // lazy — only loaded when someone exports
  const rows = store.listCandidates(req.user.org_id, req.query).map(flattenForExport);
  audit.record(req.user.org_id, req.user.email, 'candidates.export', 'xlsx', { rows: rows.length });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Candidates');
  ws.columns = [
    { header: 'Candidate ID', key: 'candidate_id', width: 20 },
    { header: 'Name', key: 'full_name', width: 24 },
    { header: 'Email', key: 'primary_email', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'Country', key: 'country', width: 9 },
    { header: 'Headline', key: 'headline', width: 30 },
    { header: 'Years', key: 'years_experience', width: 7 },
    { header: 'Skills', key: 'skills', width: 50 },
    { header: 'GitHub', key: 'github', width: 30 },
    { header: 'LinkedIn', key: 'linkedin', width: 30 },
    { header: 'Confidence', key: 'overall_confidence', width: 11 },
  ];
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="candidates.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// JSON for anything that slipped past a route's own try/catch — notably
// multer limit errors (too many files / file too large), which are thrown
// before the handler body runs.
app.use((err, _req, res, _next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  res.status(status).json({ error: err.message });
});

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .type('text/plain')
      .send('API is up. UI build not found — run `npm run dev` in /web for the interface, or POST /api/transform.'));
}

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`transformer API listening on http://localhost:${PORT}`));
}

module.exports = app;
