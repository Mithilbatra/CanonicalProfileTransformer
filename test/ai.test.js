'use strict';

// Force the deterministic local drafts so the AI layer is exercised end-to-end
// with no network and no API key (mock mode). This is the same code path a
// no-key deployment runs, so these assertions also pin the fallback behavior.
process.env.DB_PATH = ':memory:';
process.env.SILENCE_MAIL = '1';
process.env.AI_MOCK = '1';
delete process.env.ANTHROPIC_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractSources } = require('../server/engine/pipeline');
const store = require('../server/store');
const auth = require('../server/auth');
const ai = require('../server/ai');

const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');

const ORG = auth.register('owner@ai.test', 'longpassword', 'AI Co').org_id;
let candidates;

function synth(id, name, skills, years, headline, extra = {}) {
  return {
    candidate_id: id,
    record: {
      candidate_id: id,
      full_name: name,
      emails: [], phones: [], location: null,
      links: { github: null, linkedin: null, portfolio: null, other: [] },
      headline,
      years_experience: years,
      skills: skills.map(([n, c]) => ({ name: n, confidence: c, sources: ['ats'] })),
      experience: [], education: [], projects: [], certifications: [],
      provenance: [], overall_confidence: 0.8,
      ...extra,
    },
  };
}

test('setup: mock mode active, seed real candidates', async () => {
  assert.equal(ai.mode(), 'mock');
  const r = await extractSources([
    { name: 'recruiter.csv', content: read('recruiter.csv') },
    { name: 'ats.json', content: read('ats.json') },
    { name: 'github.json', content: read('github.json') },
  ]);
  store.ingestSources(ORG, r.sourceResults);
  candidates = store.listCandidates(ORG);
  assert.ok(candidates.length >= 1);
});

test('summary: grounded brief with strengths and gaps, no crash on real records', async () => {
  for (const c of candidates) {
    const out = await ai.summarize(c.record);
    assert.equal(out.mode, 'mock');
    assert.equal(typeof out.summary, 'string');
    assert.ok(out.summary.length > 0);
    assert.ok(Array.isArray(out.strengths));
    assert.ok(Array.isArray(out.gaps));
    // Grounding: the brief names the person it is about.
    if (c.record.full_name) assert.ok(out.summary.includes(c.record.full_name.split(' ')[0]));
  }
});

test('summary: a thin profile yields gaps and does not invent strengths', async () => {
  const thin = synth('THIN', 'Dana Blank', [], null, null).record;
  const out = await ai.summarize(thin);
  assert.ok(out.gaps.length > 0, 'a thin profile should surface gaps');
  assert.equal(out.strengths.length, 0, 'no skills/sources -> no fabricated strengths');
});

test('interview kit: questions reference the candidate\'s real skills', async () => {
  const rec = synth('K1', 'Kit Person', [['Python', 0.9], ['Kubernetes', 0.8]], 5, 'Backend Engineer').record;
  const out = await ai.interviewKit(rec);
  assert.ok(out.groups.length > 0);
  const all = out.groups.flatMap((g) => g.questions).join(' ');
  assert.ok(/Python|Kubernetes/.test(all), 'kit should mention a real skill');
});

test('interview kit: a job description adds a gap-probe for missing required skills', async () => {
  const rec = synth('K2', 'Gap Person', [['Python', 0.9]], 3, 'Engineer').record;
  const out = await ai.interviewKit(rec, { jobText: 'Requirements: Python and Kubernetes and Go.' });
  const all = out.groups.flatMap((g) => g.questions).join(' ');
  assert.ok(/Kubernetes|Go/.test(all), 'kit should probe a required skill the candidate lacks');
});

test('outreach: personalized draft with the sender placeholder', async () => {
  const rec = synth('O1', 'Omar Vance', [['React', 0.9]], 4, 'Frontend Engineer').record;
  const out = await ai.outreach(rec, { jobTitle: 'Senior Frontend Engineer' });
  assert.equal(typeof out.subject, 'string');
  assert.ok(out.body.includes('Omar'), 'greets by first name');
  assert.ok(out.body.includes('{{your name}}'), 'leaves a sender placeholder to fill in');
});

test('search: parses the query and ranks deterministically, explaining every hit', async () => {
  const pool = [
    synth('A', 'Asha Rao', [['Python', 0.9], ['Kubernetes', 0.8]], 6, 'Senior Backend Engineer'),
    synth('B', 'Ben Cole', [['JavaScript', 0.9], ['React', 0.8]], 1, 'Frontend Developer'),
  ];
  const out = await ai.search('senior backend engineer with 5+ years of Python and Kubernetes', pool, { limit: 10 });

  assert.equal(out.mode, 'mock');
  assert.ok(out.parsed.skills.includes('Python') && out.parsed.skills.includes('Kubernetes'));
  assert.equal(out.parsed.minYears, 5);
  assert.equal(out.results.length, 2);
  // The Python/Kubernetes backend engineer must rank first, and every result
  // carries an explanation of why.
  assert.equal(out.results[0].candidate_id, 'A');
  assert.ok(out.results[0].relevance > out.results[1].relevance);
  assert.ok(out.results[0].why.length > 0);
  assert.ok(out.results[0].why.some((w) => /skills? covered/.test(w)));
});

test('search: an empty query is rejected', async () => {
  await assert.rejects(() => ai.search('   ', [], {}), /query is required/);
});
