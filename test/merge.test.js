'use strict';

process.env.DB_PATH = ':memory:';
process.env.SILENCE_MAIL = '1';
process.env.SILENCE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert');
const { extractSources } = require('../server/engine/pipeline');
const store = require('../server/store');
const auth = require('../server/auth');

const ORG = auth.register('owner@merge.test', 'longpassword', 'Merge Co').org_id;

// Two records the engine deliberately leaves apart: names are similar and the
// employer matches, but the emails differ — so the cautious fuzzy pass refuses
// to merge them. Exactly the case the review UI is for.
const CSV =
  'Full Name,E-mail,Current Company,Job Title\n' +
  'Jonathan Smith,jonathan@northgate-eng.com,Northgate,Backend Engineer\n' +
  'Jon Smith,jsmith@othermail.net,Northgate,Backend Engineer\n';

let a, b;

test('setup: the two similar records are NOT auto-merged', async () => {
  const r = await extractSources([{ name: 'people.csv', content: CSV }]);
  store.ingestSources(ORG, r.sourceResults);
  const list = store.listCandidates(ORG);
  assert.equal(list.length, 2, 'engine keeps them separate (emails conflict)');
  [a, b] = list.map((c) => c.candidate_id);
});

test('suggestions: the pair is surfaced with reasons', () => {
  const { suggestions } = { suggestions: store.findMergeSuggestions(ORG) };
  assert.ok(suggestions.length >= 1, 'at least one duplicate suggestion');
  const hit = suggestions.find((s) => {
    const ids = [s.a.candidate_id, s.b.candidate_id].sort();
    return ids[0] === [a, b].sort()[0] && ids[1] === [a, b].sort()[1];
  });
  assert.ok(hit, 'the Smith pair is suggested');
  assert.ok(hit.score >= 0.7);
  assert.ok(hit.reasons.some((r) => /employer/i.test(r)), 'reasons cite the shared employer');
});

test('merge: confirming folds them into one candidate with both emails', () => {
  const { candidate } = store.mergeCandidates(ORG, a, b, 'owner@merge.test');
  assert.ok(candidate, 'a merged candidate is returned');
  assert.equal(store.listCandidates(ORG).length, 1, 'now a single candidate');
  assert.equal(candidate.record.emails.length, 2, 'both emails are carried onto the merged record');
});

test('merge survives a full rebuild (human link is re-applied)', () => {
  store.rebuild(ORG);
  assert.equal(store.listCandidates(ORG).length, 1, 'still merged after rebuild');
});

test('manual merges are listed and can be undone', () => {
  const manual = store.listManualMerges(ORG);
  assert.equal(manual.length, 1);
  const { unmerged } = store.undoMerge(ORG, manual[0].link_id);
  assert.ok(unmerged >= 2);
  assert.equal(store.listCandidates(ORG).length, 2, 'unmerge re-splits them');
  assert.equal(store.listManualMerges(ORG).length, 0);
});

test('dismiss: a dismissed pair stops being suggested', () => {
  assert.ok(store.findMergeSuggestions(ORG).length >= 1);
  store.dismissMergePair(ORG, a, b, 'owner@merge.test');
  const stillThere = store.findMergeSuggestions(ORG).some((s) => {
    const ids = [s.a.candidate_id, s.b.candidate_id].sort();
    return ids.join() === [a, b].sort().join();
  });
  assert.equal(stillThere, false, 'the dismissed pair is gone');
});

test('blocking: a shared surname and employer alone never pair two people', async () => {
  const org = auth.register('kumar@merge.test', 'longpassword', 'Kumar Co').org_id;
  const csv =
    'Full Name,E-mail,Current Company,Job Title\n' +
    'Rahul Kumar,rahul@bigcorp.example,BigCorp,Engineer\n' +
    'Amit Kumar,amit@bigcorp.example,BigCorp,Engineer\n';
  const r = await extractSources([{ name: 'kumar.csv', content: csv }]);
  store.ingestSources(org, r.sourceResults);
  assert.equal(store.listCandidates(org).length, 2);
  assert.equal(store.findMergeSuggestions(org).length, 0, 'different first names are never compared');
});

test('merge validation: cannot merge a candidate with itself / a missing id', () => {
  assert.throws(() => store.mergeCandidates(ORG, a, a, 'x'), /itself/);
  assert.throws(() => store.mergeCandidates(ORG, a, 'nope', 'x'), /not found/);
});
