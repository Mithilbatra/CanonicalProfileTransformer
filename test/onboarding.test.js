'use strict';

process.env.DB_PATH = ':memory:';
process.env.SILENCE_MAIL = '1';

const test = require('node:test');
const assert = require('node:assert');
const auth = require('../server/auth');
const store = require('../server/store');
const { extractSources } = require('../server/engine/pipeline');
const mailer = require('../server/lib/mailer');
const fs = require('fs');
const path = require('path');

const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');

test('password reset: request → reset → login with the new password', () => {
  const s = auth.register('reset-me@x.test', 'originalpass', 'ResetCo');

  // unknown email yields no token but does not error or reveal anything
  assert.equal(auth.requestPasswordReset('nobody@x.test'), null);

  const { token } = auth.requestPasswordReset('reset-me@x.test');
  assert.ok(token);

  // old password still works until the reset is completed
  assert.ok(auth.login('reset-me@x.test', 'originalpass').token);

  const session = auth.resetPassword(token, 'brandnewpass');
  assert.equal(session.email, 'reset-me@x.test');

  // new password works, old one doesn't, token is single-use
  assert.ok(auth.login('reset-me@x.test', 'brandnewpass').token);
  assert.throws(() => auth.login('reset-me@x.test', 'originalpass'), /invalid email or password/);
  assert.throws(() => auth.resetPassword(token, 'anotherpass'), /invalid or has expired/);

  // resetting also invalidates existing sessions
  assert.equal(auth.userForToken(s.token), null);
});

test('invite by link: create → inspect → accept sets own password and joins the org', () => {
  const admin = auth.register('admin@invite.test', 'longpassword', 'Invite Co');
  const inv = auth.createInvite(admin.org_id, 'newbie@invite.test', 'recruiter', admin.email);
  assert.ok(inv.token);

  const preview = auth.getInvite(inv.token);
  assert.equal(preview.email, 'newbie@invite.test');
  assert.equal(preview.role, 'recruiter');
  assert.equal(preview.org_name, 'Invite Co');

  const session = auth.acceptInvite(inv.token, 'mychosenpass');
  assert.equal(session.org_id, admin.org_id);
  assert.equal(session.role, 'recruiter');

  // the new member can log in with the password THEY chose
  assert.ok(auth.login('newbie@invite.test', 'mychosenpass').token);

  // the invite is single-use and validated
  assert.throws(() => auth.acceptInvite(inv.token, 'again1234'), /already been used/);
  assert.throws(() => auth.getInvite('bogus-token'), /not found/);
  assert.throws(() => auth.createInvite(admin.org_id, 'newbie@invite.test', 'viewer', admin.email), /already exists/);
  assert.throws(() => auth.createInvite(admin.org_id, 'x@invite.test', 'wizard', admin.email), /role must be/);
});

test('org backup / restore round-trips subjects and stage metadata', async () => {
  const a = auth.register('a@backup.test', 'longpassword', 'Backup A').org_id;
  const r = await extractSources([
    { name: 'recruiter.csv', content: read('recruiter.csv') },
    { name: 'ats.json', content: read('ats.json') },
  ]);
  store.ingestSources(a, r.sourceResults);
  const jordan = store.listCandidates(a).find((c) => (c.record.full_name || '').includes('Jordan'));
  store.setStage(a, jordan.candidate_id, 'interview', 'a@backup.test');

  const backup = store.exportOrg(a);
  assert.ok(backup.subjects.length >= 3);
  assert.equal(backup.meta.length, 1);

  // restore into a fresh org reproduces the candidates AND their stage
  const b = auth.register('b@backup.test', 'longpassword', 'Backup B').org_id;
  const result = store.importOrg(b, backup);
  assert.equal(result.candidates, store.listCandidates(a).length);
  const jordanB = store.listCandidates(b).find((c) => (c.record.full_name || '').includes('Jordan'));
  assert.equal(jordanB.candidate_id, jordan.candidate_id); // deterministic id
  assert.equal(jordanB.meta.stage, 'interview');           // stage came across

  // isolation intact — backup A's data never leaked into A from B's import
  assert.equal(store.listCandidates(a).length, store.listCandidates(b).length);
});

test('mailer captures messages in dev (no SMTP configured)', async () => {
  const before = mailer.outbox.length;
  const out = await mailer.send({ to: 'x@y.test', subject: 'hi', text: 'body' });
  assert.equal(out.captured, true);
  assert.equal(mailer.outbox.length, before + 1);
  assert.equal(mailer.outbox[mailer.outbox.length - 1].to, 'x@y.test');
  assert.match(mailer.appUrl('/?reset=abc'), /\/\?reset=abc$/);
});
