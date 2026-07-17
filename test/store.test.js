'use strict';

// Each test file runs in its own process, so pointing DB_PATH at an
// in-memory database here cannot leak into the real data/app.db.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractSources } = require('../server/engine/pipeline');
const store = require('../server/store');
const auth = require('../server/auth');
const audit = require('../server/audit');

const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');

// One organization is the backdrop for the single-tenant behavior tests.
const ORG = auth.register('owner@acme.test', 'longpassword', 'Acme').org_id;

test('store: uploads on different days still merge into one candidate', async () => {
  const day1 = await extractSources([{ name: 'recruiter.csv', content: read('recruiter.csv') }]);
  const r1 = store.ingestSources(ORG, day1.sourceResults);
  assert.equal(r1.totalCandidates, 2);

  const day2 = await extractSources([{ name: 'ats.json', content: read('ats.json') }]);
  const r2 = store.ingestSources(ORG, day2.sourceResults);
  assert.equal(r2.totalCandidates, 2);

  const jordan = store.listCandidates(ORG, { q: 'jordan' })[0];
  assert.ok(jordan, 'jordan should be findable');
  assert.ok(jordan.record.emails.includes('jordan.rivera@example.com'));
  assert.ok(jordan.record.skills.length > 0, 'ats skills got merged in');
});

test('store: search and skill filters', () => {
  assert.equal(store.listCandidates(ORG, { q: 'casey' }).length, 1);
  assert.equal(store.listCandidates(ORG, { q: 'nobody-by-this-name' }).length, 0);
  assert.equal(store.listCandidates(ORG, { skill: 'python' }).length, 1);
});

test('store: manual override wins, is human-attributed, survives rebuilds', () => {
  const jordan = store.listCandidates(ORG, { q: 'jordan' })[0];
  const updated = store.setOverride(ORG, jordan.candidate_id, 'headline', 'Staff Engineer', 'recruiter@co.com');

  assert.equal(updated.record.headline, 'Staff Engineer');
  assert.equal(updated.field_confidence.headline, 1.0);
  assert.equal(updated.record.provenance.find((p) => p.field === 'headline').source, 'human');

  store.rebuild(ORG); // full re-merge; override must still hold
  assert.equal(store.getCandidate(ORG, jordan.candidate_id).record.headline, 'Staff Engineer');

  const cleared = store.clearOverride(ORG, jordan.candidate_id, 'headline');
  assert.notEqual(cleared.record.headline, 'Staff Engineer');
});

test('store: override validation rejects bad fields and bad values', () => {
  const jordan = store.listCandidates(ORG, { q: 'jordan' })[0];
  assert.throws(() => store.setOverride(ORG, jordan.candidate_id, 'candidate_id', 'x'), /cannot be overridden/);
  assert.throws(() => store.setOverride(ORG, jordan.candidate_id, 'years_experience', 'ten'), /invalid value/);
  assert.throws(() => store.setOverride(ORG, 'cand_missing', 'headline', 'x'), /not found/);
});

test('incremental merge equals full rebuild', async () => {
  const extra = await extractSources([
    { name: 'linkedin.json', content: fs.readFileSync(path.join(__dirname, '..', 'samples2', 'linkedin.json'), 'utf8') },
    { name: 'ats.json', content: fs.readFileSync(path.join(__dirname, '..', 'samples2', 'ats.json'), 'utf8') },
  ]);
  store.ingestSources(ORG, extra.sourceResults);
  const incremental = store.listCandidates(ORG).map((c) => JSON.stringify([c.candidate_id, c.record]));

  store.rebuild(ORG);
  const full = store.listCandidates(ORG).map((c) => JSON.stringify([c.candidate_id, c.record]));
  assert.deepEqual(incremental, full);
});

test('incremental merge only touches affected candidates', async () => {
  const jordanBefore = store.listCandidates(ORG).find((c) => (c.record.full_name || '').includes('Jordan'));
  assert.ok(jordanBefore);

  const stranger = await extractSources([{
    name: 'stranger.csv',
    content: 'Full Name,E-mail\nTotally Unrelated,unrelated@nowhere.example\n',
  }]);
  store.ingestSources(ORG, stranger.sourceResults);

  const jordanAfter = store.listCandidates(ORG).find((c) => (c.record.full_name || '').includes('Jordan'));
  assert.equal(jordanAfter.updated_at, jordanBefore.updated_at); // row not rewritten
  assert.equal(jordanAfter.candidate_id, jordanBefore.candidate_id);
});

test('store: deleting a candidate removes it and its raw subjects', () => {
  const casey = store.listCandidates(ORG, { q: 'casey' })[0];
  store.deleteCandidate(ORG, casey.candidate_id);
  assert.equal(store.listCandidates(ORG, { q: 'casey' }).length, 0);
  store.rebuild(ORG);
  assert.equal(store.listCandidates(ORG, { q: 'casey' }).length, 0);
});

test('saved views are per-org: create, upsert, list, delete', () => {
  const v = store.saveView(ORG, 'python folks', null, 'python', 'me@x.com');
  assert.equal(v.skill, 'python');
  store.saveView(ORG, 'python folks', 'jordan', 'python', 'me@x.com'); // upsert by name
  const views = store.listViews(ORG);
  assert.equal(views.length, 1);
  assert.equal(views[0].q, 'jordan');
  store.deleteView(ORG, views[0].id);
  assert.equal(store.listViews(ORG).length, 0);
  assert.throws(() => store.saveView(ORG, '', null, null, null), /1-60 characters/);
});

test('MULTI-TENANCY: two orgs with the same candidate stay fully isolated', async () => {
  const orgB = auth.register('owner@globex.test', 'longpassword', 'Globex').org_id;
  assert.notEqual(orgB, ORG);

  // the same person (same email) uploaded into a different org
  const jordanCsv = { name: 'r.csv', content: read('recruiter.csv') };
  const b = await extractSources([jordanCsv]);
  store.ingestSources(orgB, b.sourceResults);

  // org B sees its own Jordan; must NOT merge with org A's Jordan
  const jordanA = store.listCandidates(ORG, { q: 'jordan' })[0];
  const jordanB = store.listCandidates(orgB, { q: 'jordan' })[0];
  assert.ok(jordanA && jordanB);
  // same identity hash, but they are distinct rows in distinct orgs
  assert.equal(jordanA.candidate_id, jordanB.candidate_id);

  // org A's override on Jordan is invisible to org B
  store.setOverride(ORG, jordanA.candidate_id, 'headline', 'ACME-ONLY', 'a@a.com');
  assert.equal(store.getCandidate(ORG, jordanA.candidate_id).record.headline, 'ACME-ONLY');
  assert.notEqual(store.getCandidate(orgB, jordanB.candidate_id).record.headline, 'ACME-ONLY');

  // deleting in org B leaves org A untouched
  store.deleteCandidate(orgB, jordanB.candidate_id);
  assert.equal(store.listCandidates(orgB, { q: 'jordan' }).length, 0);
  assert.equal(store.listCandidates(ORG, { q: 'jordan' }).length, 1);

  // cross-org access returns nothing, never another tenant's data
  assert.equal(store.getCandidate(orgB, jordanA.candidate_id), null);
});

test('AUDIT: entries are recorded and scoped to their org', () => {
  const orgB = store.listCandidates; // noop ref to keep lints quiet
  audit.record(ORG, 'a@acme.test', 'candidate.delete', 'cand_x', { reason: 'test' });
  audit.record(ORG, 'a@acme.test', 'candidates.export', 'csv', { rows: 3 });
  const entries = audit.list(ORG);
  assert.ok(entries.length >= 2);
  assert.equal(entries[0].action, 'candidates.export'); // most recent first
  assert.deepEqual(entries[0].detail, { rows: 3 });
  assert.equal(audit.list(ORG, { action: 'candidate.delete' })[0].target, 'cand_x');

  // a different org sees none of it
  const other = auth.register('audit-other@x.test', 'longpassword').org_id;
  assert.equal(audit.list(other).length, 0);
});

test('ROLES: admin can invite; duplicate email and bad role are rejected', () => {
  const admin = auth.register('admin@roles.test', 'longpassword', 'Roles Inc');
  const member = auth.invite(admin.org_id, 'viewer@roles.test', 'longpassword', 'viewer');
  assert.equal(member.role, 'viewer');

  const members = auth.listMembers(admin.org_id);
  assert.deepEqual(members.map((m) => m.role).sort(), ['admin', 'viewer']);

  // the invited user logs in and lands in the SAME org with their role
  const session = auth.login('viewer@roles.test', 'longpassword');
  assert.equal(session.org_id, admin.org_id);
  assert.equal(session.role, 'viewer');

  assert.throws(() => auth.invite(admin.org_id, 'viewer@roles.test', 'longpassword', 'viewer'), /already exists/);
  assert.throws(() => auth.invite(admin.org_id, 'x@roles.test', 'longpassword', 'superuser'), /role must be/);
});

test('auth: register, login, token lifecycle', () => {
  const session = auth.register('user@example.com', 'longpassword');
  assert.ok(session.token);
  assert.equal(session.role, 'admin'); // first user of a new org
  assert.equal(auth.userForToken(session.token).email, 'user@example.com');

  assert.throws(() => auth.register('user@example.com', 'longpassword'), /already exists/);
  assert.throws(() => auth.register('not-an-email', 'longpassword'), /invalid email/);
  assert.throws(() => auth.register('short@pw.com', 'short'), /at least 8/);

  assert.throws(() => auth.login('user@example.com', 'wrongpassword'), /invalid email or password/);
  assert.throws(() => auth.login('ghost@example.com', 'longpassword'), /invalid email or password/);
  assert.ok(auth.login('user@example.com', 'longpassword').token);

  auth.logout(session.token);
  assert.equal(auth.userForToken(session.token), null);
});
