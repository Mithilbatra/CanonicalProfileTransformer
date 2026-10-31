'use strict';

process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractSources } = require('../server/engine/pipeline');
const store = require('../server/store');
const auth = require('../server/auth');
const analytics = require('../server/analytics');
const audit = require('../server/audit');
const { extractRequirements, scoreCandidate, estimateTenureYears } = require('../server/engine/match');
const { rateLimit } = require('../server/lib/ratelimit');

const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');

const ORG = auth.register('owner@flow.test', 'longpassword', 'Flow Co').org_id;

async function seed() {
  const r = await extractSources([
    { name: 'recruiter.csv', content: read('recruiter.csv') },
    { name: 'ats.json', content: read('ats.json') },
  ]);
  store.ingestSources(ORG, r.sourceResults);
}

test('pipeline stage: default is "new", settable, validated, on the record', async () => {
  await seed();
  const [a] = store.listCandidates(ORG);
  assert.equal(a.meta.stage, 'new');

  const moved = store.setStage(ORG, a.candidate_id, 'interview', 'me@flow.test');
  assert.equal(moved.meta.stage, 'interview');
  assert.equal(store.getCandidate(ORG, a.candidate_id).meta.stage, 'interview');

  assert.throws(() => store.setStage(ORG, a.candidate_id, 'banana'), /stage must be one of/);
  assert.throws(() => store.setStage(ORG, 'cand_missing', 'offer'), /not found/);

  // filter by stage
  assert.equal(store.listCandidates(ORG, { stage: 'interview' }).length, 1);
  assert.equal(store.listCandidates(ORG, { stage: 'hired' }).length, 0);
});

test('stage survives a re-merge (keyed by candidate_id, like overrides)', () => {
  const jordan = store.listCandidates(ORG).find((c) => (c.record.full_name || '').includes('Jordan'));
  store.setStage(ORG, jordan.candidate_id, 'offer', 'me@flow.test');
  store.rebuild(ORG);
  assert.equal(store.getCandidate(ORG, jordan.candidate_id).meta.stage, 'offer');
});

test('tags and notes: dedupe, trim, cap, and validate', () => {
  const [a] = store.listCandidates(ORG);
  const tagged = store.setTags(ORG, a.candidate_id, ['  Backend ', 'backend', 'Referral', ''], 'me@flow.test');
  assert.deepEqual(tagged.meta.tags, ['Backend', 'backend', 'Referral']); // trimmed, blanks dropped, case-distinct
  assert.equal(store.listCandidates(ORG, { tag: 'referral' }).length, 1); // filter is case-insensitive

  const noted = store.setNote(ORG, a.candidate_id, 'Strong on distributed systems.', 'me@flow.test');
  assert.match(noted.meta.note, /distributed systems/);
  assert.equal(store.setNote(ORG, a.candidate_id, null).meta.note, null);
  assert.throws(() => store.setTags(ORG, a.candidate_id, 'notarray'), /array of strings/);
});

test('bulk stage + bulk delete', async () => {
  const ids = store.listCandidates(ORG).map((c) => c.candidate_id);
  const n = store.setStageBulk(ORG, [...ids, 'cand_ghost'], 'screening', 'me@flow.test');
  assert.equal(n, ids.length); // ghost id skipped
  assert.ok(store.listCandidates(ORG).every((c) => c.meta.stage === 'screening'));

  const deleted = store.deleteCandidates(ORG, ids);
  assert.equal(deleted, ids.length);
  assert.equal(store.listCandidates(ORG).length, 0);
});

test('JD templates: save, upsert, list, delete', () => {
  const t = store.saveJdTemplate(ORG, 'Backend role', 'Senior Backend Engineer, Python, PostgreSQL', 'me@flow.test');
  assert.equal(t.name, 'Backend role');
  store.saveJdTemplate(ORG, 'Backend role', 'updated text', 'me@flow.test'); // upsert by name
  const list = store.listJdTemplates(ORG);
  assert.equal(list.length, 1);
  assert.equal(list[0].jd, 'updated text');
  store.deleteJdTemplate(ORG, list[0].id);
  assert.equal(store.listJdTemplates(ORG).length, 0);
  assert.throws(() => store.saveJdTemplate(ORG, 'x', ''), /jd text is required/);
});

test('weighted requirements: nice-to-have skills are separated and weigh less', () => {
  const jd = 'Backend Engineer. Requirements: Python and PostgreSQL. Nice to have: Docker, AWS.';
  const req = extractRequirements(jd);
  assert.deepEqual(req.required, ['PostgreSQL', 'Python']);
  assert.deepEqual(req.niceToHave, ['AWS', 'Docker']);

  const rec = (skills) => ({
    skills: skills.map((n) => ({ name: n, confidence: 0.9, sources: ['ats'] })),
    years_experience: null, experience: [], headline: null,
  });

  // candidate with both required but neither nice-to-have
  const reqOnly = scoreCandidate(rec(['Python', 'PostgreSQL']), req);
  // candidate with the two nice-to-haves but neither required
  const niceOnly = scoreCandidate(rec(['Docker', 'AWS']), req);

  const skillPart = (r) => r.parts.find((p) => p.component === 'skills').score;
  assert.ok(skillPart(reqOnly) > skillPart(niceOnly), 'required coverage beats preferred coverage');
  assert.deepEqual(reqOnly.missingRequired, []);
  assert.deepEqual(niceOnly.missingRequired.sort(), ['PostgreSQL', 'Python']);
});

test('tenure estimation merges overlapping roles', () => {
  assert.equal(estimateTenureYears([]), null);
  // 2018-01..2021-01 (3y) and an overlapping 2020-01..2023-01 (3y) => 2018..2023 = 5y
  const years = estimateTenureYears([
    { start: '2018-01', end: '2021-01' },
    { start: '2020-01', end: '2023-01' },
  ]);
  assert.equal(years, 5);

  // used as a fallback when years_experience is null
  const rec = { skills: [], years_experience: null, headline: null, experience: [{ start: '2015-01', end: '2020-01' }] };
  const scored = scoreCandidate(rec, extractRequirements('3+ years'));
  const yp = scored.parts.find((p) => p.component === 'years');
  assert.ok(yp.score > 0);
  assert.match(yp.detail, /estimated/);
});

test('insights: funnel, confidence bands, top skills, source mix', async () => {
  const org = auth.register('a@insights.test', 'longpassword', 'Insights').org_id;
  const r = await extractSources([
    { name: 'recruiter.csv', content: read('recruiter.csv') },
    { name: 'ats.json', content: read('ats.json') },
  ]);
  store.ingestSources(org, r.sourceResults);
  const jordan = store.listCandidates(org).find((c) => (c.record.full_name || '').includes('Jordan'));
  store.setStage(org, jordan.candidate_id, 'interview', 'a@insights.test');

  const ins = analytics.insights(org);
  assert.equal(ins.total, 2);
  assert.equal(ins.funnel.reduce((s, f) => s + f.count, 0), 2);
  assert.equal(ins.funnel.find((f) => f.stage === 'interview').count, 1);
  assert.equal(ins.confidenceBands.reduce((s, b) => s + b.count, 0), 2);
  assert.ok(ins.topSkills.some((s) => s.name === 'Python'));
  assert.ok(ins.sourceMix.some((m) => m.type === 'ats'));
  assert.ok(ins.avgConfidence > 0 && ins.avgConfidence <= 1);

  // activity counts every match run, and how many were bias-blind
  audit.record(org, 'a@insights.test', 'candidates.match', null, { blind: true });
  audit.record(org, 'a@insights.test', 'candidates.match', null, { blind: false });
  audit.record(org, 'a@insights.test', 'candidates.match', null, null);
  assert.deepEqual(analytics.insights(org).activity, { matches: 3, blindMatches: 1 });
});

test('rate limiter blocks past the max within the window', () => {
  const prev = process.env.DISABLE_RATE_LIMIT;
  delete process.env.DISABLE_RATE_LIMIT;
  const limiter = rateLimit({ windowMs: 60_000, max: 3 });
  const run = () => {
    let status = 200;
    const req = { ip: '1.2.3.4', headers: {} };
    const res = { setHeader() {}, status(c) { status = c; return this; }, json() { return this; } };
    limiter(req, res, () => { status = 200; });
    return status;
  };
  assert.equal(run(), 200);
  assert.equal(run(), 200);
  assert.equal(run(), 200);
  assert.equal(run(), 429); // 4th request in the window is blocked
  if (prev) process.env.DISABLE_RATE_LIMIT = prev;
});
