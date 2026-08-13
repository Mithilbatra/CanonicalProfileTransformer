'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const Papa = require('papaparse');
const { runPipeline, extractSources, DEFAULT_CONFIG } = require('./engine/pipeline');
const { bufferToText } = require('./lib/filetext');
const { matchCandidates } = require('./engine/match');
const { suggestImprovements } = require('./engine/suggest');
const { insights } = require('./analytics');
const { rateLimit } = require('./lib/ratelimit');
const mailer = require('./lib/mailer');
const logger = require('./lib/logger');
const llm = require('./lib/llm');
const ai = require('./ai');
const auth = require('./auth');
const store = require('./store');
const audit = require('./audit');

// roles allowed to mutate candidate data (viewers are read-only)
const canWrite = auth.requireRole('admin', 'recruiter');
// throttle credential endpoints against stuffing / signup spam
const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
// throttle the AI endpoints — they call an external model and cost real money
const aiLimiter = rateLimit({ windowMs: 60_000, max: 40 });

// Guard for AI routes: when nothing is configured, report a clear 503 rather
// than pretending. (In dev / with AI_MOCK the layer runs deterministic drafts.)
function aiEnabled(_req, res, next) {
  if (llm.mode() === 'off') {
    return res.status(503).json({ error: 'AI features are not configured. Set ANTHROPIC_API_KEY to enable them.' });
  }
  next();
}

// Enforce the per-org daily AI budget. Only live (billable) calls are metered
// — mock/local drafts cost nothing, so they're never capped.
function aiBudgetGuard(req, res, next) {
  if (llm.mode() === 'live') {
    const budget = store.aiBudget(req.user.org_id);
    if (budget.exceeded) {
      return res.status(429).json({
        error: `daily AI limit reached (${budget.cap} requests/day). It resets tomorrow; an admin can raise it in settings.`,
        budget,
      });
    }
  }
  next();
}

// Count a completed AI response against the org's budget when it actually hit
// the model (mode 'live'); fallbacks and mock drafts aren't billable.
function meterAi(req, feature, result) {
  if (result && result.mode === 'live') store.recordAiUsage(req.user.org_id, feature);
}

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const CONFIGS = path.join(ROOT, 'configs');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

const app = express();

// Behind a reverse proxy in production (Render/Fly/nginx), trust the first hop
// so req.ip (used by the rate limiter) and X-Forwarded-Proto are correct.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// Security headers. The CSP is scoped to what this app actually loads:
// same-origin scripts/styles/data, Google Fonts, and same-origin XHR.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    // the app fetches its own API and opens candidate links in new tabs
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// One structured log line per request (method, path, status, duration, org).
// Health checks are skipped to keep the log readable.
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      org: req.user ? req.user.org_id : undefined,
    });
  });
  next();
});

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 20);
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 45000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_UPLOAD_FILES, fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// Bound a slow extraction so one pathological file can't wedge the request.
// The underlying work isn't hard-killed (that needs a worker), but the request
// is freed and the file is reported as failed rather than hanging.
function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

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

// Org settings: data-retention window + AI daily-cost cap (admin only).
app.get('/api/org/settings', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  res.json(store.getOrgSettings(req.user.org_id));
});

app.put('/api/org/settings', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  try {
    const result = store.setOrgSettings(req.user.org_id, req.body || {});
    audit.record(req.user.org_id, req.user.email, 'org.settings', null, result);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Run the retention purge now (in addition to the daily sweep) — admin only.
app.post('/api/org/purge', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  const result = store.purgeExpired(req.user.org_id);
  audit.record(req.user.org_id, req.user.email, 'org.purge', null, result);
  res.json(result);
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
    // Convert each file to text under a timeout. A file that fails (corrupt,
    // scanned PDF, too large to OCR, or too slow) is reported and skipped
    // rather than failing the whole upload.
    const sources = [];
    const failed = [];
    for (const f of req.files) {
      try {
        const { text, links } = await withTimeout(
          bufferToText(f.buffer, f.originalname), EXTRACT_TIMEOUT_MS, `extracting "${f.originalname}" timed out`
        );
        sources.push({ name: f.originalname, content: text, links });
      } catch (err) {
        failed.push({ source: f.originalname, type: 'file', ok: false, error: err.message, subjects: 0 });
      }
    }
    const allowNetwork = req.body.allowNetwork === 'true';
    const { sourceResults, sourceReport } = await extractSources(sources, { allowNetwork });
    const { subjectsAdded, totalCandidates } = store.ingestSources(req.user.org_id, sourceResults);
    const report = [...sourceReport, ...failed];
    audit.record(req.user.org_id, req.user.email, 'candidates.upload', null, {
      files: report.map((s) => s.source), subjectsAdded, totalCandidates,
    });
    res.json({ sources: report, subjectsAdded, totalCandidates });
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
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const { items, total } = store.queryCandidates(req.user.org_id, { q, skill, stage, tag, limit, offset });
  res.json({ candidates: items, total, limit, offset, stages: store.STAGES });
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

// ---- AI layer ---------------------------------------------------------
//
// Additive, attributed AI assists. They never mutate the canonical record —
// each response carries its mode (live | mock | fallback) so the UI can label
// it as a draft to verify. Reads only, so viewers may use them too.

app.get('/api/ai/status', auth.requireAuth, (req, res) => {
  res.json({ mode: llm.mode(), model: llm.MODEL, features: ai.FEATURES, budget: store.aiBudget(req.user.org_id) });
});

// Natural-language candidate search: the model parses the query into a structured
// filter; the deterministic engine ranks. The parsed filter is returned too, so
// the recruiter can see exactly what was searched for.
app.post('/api/ai/search', auth.requireAuth, aiEnabled, aiBudgetGuard, aiLimiter, async (req, res) => {
  try {
    const { query, limit } = req.body || {};
    const cap = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const result = await ai.search(query, store.listCandidates(req.user.org_id), { limit: cap });
    meterAi(req, 'search', result);
    audit.record(req.user.org_id, req.user.email, 'ai.search', null, { mode: result.mode, results: result.count });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// A grounded recruiter brief (summary + strengths + gaps) for one candidate.
app.post('/api/candidates/:id/summary', auth.requireAuth, aiEnabled, aiBudgetGuard, aiLimiter, async (req, res) => {
  const candidate = store.getCandidate(req.user.org_id, req.params.id);
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  try {
    const result = await ai.summarize(candidate.record);
    meterAi(req, 'summary', result);
    audit.record(req.user.org_id, req.user.email, 'ai.summary', req.params.id, { mode: result.mode });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Tailored screening questions, optionally focused by a job's description.
app.post('/api/candidates/:id/interview-kit', auth.requireAuth, aiEnabled, aiBudgetGuard, aiLimiter, async (req, res) => {
  const candidate = store.getCandidate(req.user.org_id, req.params.id);
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  try {
    const jobText = jobContext(req.user.org_id, req.body).description;
    const result = await ai.interviewKit(candidate.record, { jobText });
    meterAi(req, 'interview_kit', result);
    audit.record(req.user.org_id, req.user.email, 'ai.interview_kit', req.params.id, { mode: result.mode });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// A personalized first-contact outreach draft, optionally for a specific job.
app.post('/api/candidates/:id/outreach', auth.requireAuth, aiEnabled, aiBudgetGuard, aiLimiter, async (req, res) => {
  const candidate = store.getCandidate(req.user.org_id, req.params.id);
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  try {
    const job = jobContext(req.user.org_id, req.body);
    const result = await ai.outreach(candidate.record, { jobText: job.description, jobTitle: job.title, tone: (req.body || {}).tone });
    meterAi(req, 'outreach', result);
    audit.record(req.user.org_id, req.user.email, 'ai.outreach', req.params.id, { mode: result.mode });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Resolve optional role context for an AI assist from the request body: a saved
// job (by id) wins; otherwise raw jd text is accepted. Both are optional.
function jobContext(orgId, body) {
  const b = body || {};
  if (b.jobId != null) {
    const job = store.getJob(orgId, b.jobId);
    if (job) return { title: job.title, description: job.description };
  }
  if (b.jd && String(b.jd).trim()) return { title: null, description: String(b.jd) };
  return { title: null, description: null };
}

// ---- duplicate review ------------------------------------------------
// Surface likely-duplicate candidate pairs the engine left apart, and let a
// recruiter confirm a merge (a human link the resolver honors) or dismiss it.

app.get('/api/merge/suggestions', auth.requireAuth, (req, res) => {
  res.json({
    suggestions: store.findMergeSuggestions(req.user.org_id),
    manual: store.listManualMerges(req.user.org_id),
  });
});

app.post('/api/merge', auth.requireAuth, canWrite, (req, res) => {
  try {
    const { a, b } = req.body || {};
    if (!a || !b) return res.status(400).json({ error: 'body.a and body.b (candidate ids) are required' });
    const result = store.mergeCandidates(req.user.org_id, a, b, req.user.email);
    audit.record(req.user.org_id, req.user.email, 'candidates.merge', result.candidate ? result.candidate.candidate_id : null, { from: [a, b] });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/merge/dismiss', auth.requireAuth, canWrite, (req, res) => {
  const { a, b } = req.body || {};
  if (!a || !b) return res.status(400).json({ error: 'body.a and body.b (candidate ids) are required' });
  const result = store.dismissMergePair(req.user.org_id, a, b, req.user.email);
  audit.record(req.user.org_id, req.user.email, 'candidates.merge_dismiss', null, { pair: [a, b] });
  res.json(result);
});

app.post('/api/merge/undo', auth.requireAuth, canWrite, (req, res) => {
  try {
    const { link_id } = req.body || {};
    const result = store.undoMerge(req.user.org_id, link_id);
    audit.record(req.user.org_id, req.user.email, 'candidates.merge_undo', link_id, result);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
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
app.use((err, req, res, _next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) {
    logger.captureError(err, { path: req.path, method: req.method, org: req.user ? req.user.org_id : undefined });
  }
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
  // Enforce data-retention on boot, then once a day. Errors here must never
  // crash the server. The interval is unref'd so it doesn't hold the process.
  const sweep = () => {
    try {
      const { purged } = store.purgeAllOrgs();
      if (purged) logger.info('retention.sweep', { purged });
    } catch (err) {
      logger.captureError(err, { job: 'retention.sweep' });
    }
  };
  sweep();
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();

  app.listen(PORT, () => logger.info('server.start', { port: PORT, ai: llm.mode() }));
}

module.exports = app;
