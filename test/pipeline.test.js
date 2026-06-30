'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../server/engine/pipeline');
const { project } = require('../server/engine/project');

const S = (name) => ({ name, content: fs.readFileSync(path.join(__dirname, '..', 'samples', name), 'utf8') });
const DEFAULT = require('../configs/default.json');
const CUSTOM = require('../configs/custom.example.json');

async function run(files, config = DEFAULT, opts = {}) {
  return runPipeline(files.map(S), config, opts);
}

test('entity resolution: four sources collapse to one Jordan + one Casey', async () => {
  const { profiles } = await run(['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt']);
  assert.equal(profiles.length, 2);
  const names = profiles.map((p) => p._record.full_name).sort();
  assert.deepEqual(names, ['Casey Tan', 'Jordan A. Rivera']);
});

test('github merges into Jordan via shared profile link (no email on github)', async () => {
  const { profiles } = await run(['ats.json', 'github.json']);
  const jordan = profiles.find((p) => p._record.full_name.includes('Jordan'));
  const skillNames = jordan._record.skills.map((s) => s.name);
  assert.ok(skillNames.includes('Rust'), 'expected GitHub-only skill Rust to merge in');
  assert.equal(jordan._record.links.portfolio, 'https://jordanrivera.dev');
});

test('agreement raises confidence; lone low-trust source stays low', async () => {
  const { profiles } = await run(['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt']);
  const jordan = profiles.find((p) => p._record.full_name.includes('Jordan'));
  const byName = Object.fromEntries(jordan._record.skills.map((s) => [s.name, s.confidence]));
  assert.ok(byName.Python > 0.85, `Python confidence ${byName.Python} should be high`);
  assert.ok(byName.React < 0.4, `React confidence ${byName.React} should be low`);
  assert.ok(byName.Python > byName.React);
});

test('normalization is applied end-to-end (phone, dates, country)', async () => {
  const { profiles } = await run(['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt']);
  const jordan = profiles.find((p) => p._record.full_name.includes('Jordan'))._record;
  assert.deepEqual(jordan.phones, ['+14155550132']);
  assert.equal(jordan.location.country, 'US');
  const initech = jordan.experience.find((e) => e.company === 'Initech');
  assert.equal(initech.start, '2018-06');
  const northwind = jordan.experience.find((e) => e.company === 'Northwind Labs');
  assert.equal(northwind.start, '2021-03');
  assert.equal(northwind.end, null);
});

test('output is schema-valid for default and custom configs', async () => {
  const d = await run(['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt'], DEFAULT);
  for (const p of d.profiles) {
    assert.ok(p.canonical_valid, 'canonical invalid: ' + p.canonical_errors.join('; '));
    assert.ok(p.projection_valid, 'projection invalid: ' + p.projection_errors.join('; '));
  }
  const c = await run(['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt'], CUSTOM);
  for (const p of c.profiles) {
    assert.ok(p.projection_valid, 'custom projection invalid: ' + p.projection_errors.join('; '));
  }
});

test('graceful degradation: malformed source never crashes the run', async () => {
  const { profiles, sources } = await run(['ats.json', 'broken.json']);
  const broken = sources.find((s) => s.source === 'broken.json');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /malformed/i);
  assert.ok(profiles.length >= 1);
  assert.ok(profiles[0].canonical_valid);
});

test('empty input set yields zero profiles, no throw', async () => {
  const { profiles } = await runPipeline([], DEFAULT);
  assert.equal(profiles.length, 0);
});

test('projection on_missing modes: null vs omit vs error', () => {
  const record = {
    full_name: 'Jordan', emails: [], phones: ['+14155550132'], location: null,
    links: { github: null }, skills: [], experience: [], education: [],
    provenance: [], overall_confidence: 0.5,
  };
  const base = { fields: [{ path: 'email', from: 'emails[0]', type: 'string', required: true }] };

  const asNull = project(record, { ...base, on_missing: 'null' });
  assert.equal(asNull.output.email, null);
  assert.ok(asNull.issues.length >= 1);

  const asOmit = project(record, { ...base, on_missing: 'omit' });
  assert.ok(!('email' in asOmit.output));

  assert.throws(() => project(record, { ...base, on_missing: 'error' }), /missing/i);

  assert.throws(
    () => project(record, {
      fields: [{ path: 'email', from: 'emails[0]', type: 'string', required: false }],
      on_missing: 'error',
    }),
    /missing/i
  );
});

test('determinism: identical inputs produce byte-identical output', async () => {
  const files = ['recruiter.csv', 'ats.json', 'github.json', 'recruiter_notes.txt'];
  const a = await run(files);
  const b = await run(files);
  assert.equal(
    JSON.stringify(a.profiles.map((p) => p.output)),
    JSON.stringify(b.profiles.map((p) => p.output))
  );
});

test('linkedin source merges and contributes experience/education/skills', async () => {
  const ats = JSON.stringify({
    candidateName: 'Sam Lee', emailAddress: 'sam@example.com',
    linkedinUrl: 'https://www.linkedin.com/in/sam-lee',
  });
  const linkedin = JSON.stringify({
    profileUrl: 'https://www.linkedin.com/in/sam-lee',
    name: 'Sam Lee', headline: 'Staff Engineer',
    positions: [{ companyName: 'Acme', title: 'Staff Engineer', startDate: { year: 2020, month: 5 }, endDate: null }],
    education: [{ schoolName: 'MIT', degreeName: 'B.S.', fieldOfStudy: 'CS', endDate: { year: 2014 } }],
    skills: ['Rust', 'Distributed Systems'],
  });
  const r = await runPipeline([
    { name: 'ats.json', content: ats },
    { name: 'linkedin.json', content: linkedin },
  ]);
  assert.equal(r.profiles.length, 1);
  const o = r.profiles[0].output;
  assert.equal(o.headline, 'Staff Engineer');
  assert.ok(o.experience.some((e) => e.company === 'Acme' && e.start === '2020-05'));
  assert.ok(o.education.some((e) => e.institution === 'MIT'));
  assert.ok(o.skills.some((s) => s.name === 'Rust'));
});

test('same-company roles with differing titles collapse to one stint', async () => {
  const csv = 'Full Name,E-mail,Current Company,Title\nJo Tan,jo@example.com,Globex,Data Engineer\n';
  const ats = JSON.stringify({
    candidateName: 'Jo Tan', emailAddress: 'jo@example.com',
    workHistory: [{ company: 'Globex', title: 'Senior Data Engineer', startDate: '2021-04', endDate: 'Present' }],
  });
  const r = await runPipeline([
    { name: 'recruiter.csv', content: csv },
    { name: 'ats.json', content: ats },
  ]);
  const o = r.profiles[0].output;
  const globex = o.experience.filter((e) => e.company === 'Globex');
  assert.equal(globex.length, 1);
  assert.equal(globex[0].title, 'Senior Data Engineer');
  assert.equal(globex[0].start, '2021-04');
});
