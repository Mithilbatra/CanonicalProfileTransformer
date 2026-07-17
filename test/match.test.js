'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { matchCandidates, extractRequirements } = require('../server/engine/match');
const { suggestImprovements } = require('../server/engine/suggest');
const { collectGithubHandles } = require('../server/engine/enrich');
const { extractPdfLinks } = require('../server/lib/filetext');
const { coverage, impliedSkills } = require('../server/engine/ontology');

const JD = `We are hiring a Senior Backend Engineer.
Requirements: 4+ years of experience with Python, PostgreSQL and Kubernetes.
Nice to have: Docker, AWS.`;

function candidate(id, name, skills, years, headline) {
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
      experience: [], education: [], projects: [], certifications: [], activities: [], coursework: [],
      provenance: [], overall_confidence: 0.8,
    },
    field_confidence: {},
  };
}

test('JD requirements: skills, years, and role words are read from free text', () => {
  const req = extractRequirements(JD);
  assert.deepEqual(req.skills, ['AWS', 'Docker', 'Kubernetes', 'PostgreSQL', 'Python']);
  assert.equal(req.minYears, 4);
  assert.ok(req.titleWords.includes('engineer'));
  assert.ok(req.titleWords.includes('senior'));
});

test('matching ranks the better-fitting candidate first, with explainable parts', () => {
  const strong = candidate('cand_a', 'Fits Well', [['Python', 0.9], ['PostgreSQL', 0.9], ['Kubernetes', 0.8], ['Docker', 0.7], ['AWS', 0.7]], 6, 'Senior Backend Engineer');
  const weak = candidate('cand_b', 'Fits Less', [['Python', 0.5]], null, 'Product Designer');

  const { results } = matchCandidates(JD, [weak, strong]);
  assert.equal(results[0].candidate_id, 'cand_a');
  assert.ok(results[0].score > results[1].score);

  // explainability: matched/missing lists and per-component breakdown
  assert.equal(results[0].missing.length, 0);
  assert.deepEqual(results[1].missing.sort(), ['AWS', 'Docker', 'Kubernetes', 'PostgreSQL']);
  const parts = results[0].parts.map((p) => p.component);
  assert.deepEqual(parts, ['skills', 'years', 'title']);
  // unknown years scores 0, never guessed
  const weakYears = results[1].parts.find((p) => p.component === 'years');
  assert.equal(weakYears.score, 0);
  assert.match(weakYears.detail, /unknown/);
});

test('ontology: implications are transitive and directional', () => {
  assert.ok(impliedSkills('Next.js').has('JavaScript')); // Next.js -> React -> JavaScript
  assert.ok(impliedSkills('Next.js').has('React'));
  assert.ok(impliedSkills('PostgreSQL').has('SQL'));
  assert.ok(!impliedSkills('JavaScript').has('React')); // not the other way around
  assert.equal(impliedSkills('COBOL').size, 0); // unknown skill implies nothing
});

test('ontology coverage: direct hit vs stand-in vs miss', () => {
  assert.deepEqual(coverage('JavaScript', ['JavaScript']), { via: 'JavaScript', direct: true });
  assert.deepEqual(coverage('JavaScript', ['React']), { via: 'React', direct: false });
  assert.equal(coverage('Rust', ['React', 'Python']), null);
});

test('matching credits a required skill demonstrated via a more specific one', () => {
  // JD wants JavaScript; candidate lists React (which implies it) at 0.9.
  // Covered at the implied discount (0.8), and the "via" is surfaced.
  const jd = 'Frontend role needing JavaScript.';
  const c = candidate('cand_r', 'Reacter', [['React', 0.9]], null, 'Frontend Engineer');
  const { results } = matchCandidates(jd, [c]);
  const m = results[0].matched.find((x) => x.name === 'JavaScript');
  assert.ok(m, 'JavaScript requirement is covered');
  assert.equal(m.via, 'React');
  assert.equal(m.confidence, 0.72); // 0.9 * 0.8
  assert.equal(results[0].missing.length, 0);
});

test('bias-blind matching redacts identity but keeps the score identical', () => {
  const c = candidate('cand_abcd1234', 'Jane Doe', [['Python', 0.9]], 5, 'Engineer');
  c.record.location = { city: 'SF', region: 'CA', country: 'US' };
  const open = matchCandidates('Python role, 3+ years, engineer', [c]);
  const blind = matchCandidates('Python role, 3+ years, engineer', [c], { blind: true });

  assert.equal(open.blind, false);
  assert.equal(blind.blind, true);
  // identity redacted...
  assert.equal(blind.results[0].full_name, null);
  assert.equal(blind.results[0].location, null);
  assert.match(blind.results[0].alias, /^Candidate /);
  assert.deepEqual(blind.results[0].redacted, ['full_name', 'location']);
  // ...but the score and its breakdown are unchanged (identity never fed it)
  assert.equal(blind.results[0].score, open.results[0].score);
});

test('a JD with no recognizable requirements produces empty requirement sets', () => {
  const { requirements, results } = matchCandidates('We want nice people.', [candidate('cand_c', 'X', [], null, null)]);
  assert.deepEqual(requirements.skills, []);
  assert.equal(requirements.minYears, null);
  assert.equal(results[0].score, 0);
});

test('suggestions flag missing fields with severity and honest gains', () => {
  const sparse = candidate('cand_d', 'Sparse Person', [['Python', 0.5]], null, null).record;
  const suggestions = suggestImprovements(sparse, {});
  const fields = suggestions.map((s) => s.field);

  assert.ok(fields.includes('emails'));
  assert.ok(fields.includes('phones'));
  assert.ok(fields.includes('headline'));
  assert.ok(fields.includes('location'));
  assert.ok(fields.includes('experience'));
  assert.ok(fields.includes('years_experience'));

  // ordering: high severity first; core fields carry the completeness gain
  assert.equal(suggestions[0].severity, 'high');
  const headline = suggestions.find((s) => s.field === 'headline');
  assert.equal(headline.estimated_gain, 0.06);
});

test('a complete profile draws few suggestions', () => {
  const full = candidate('cand_e', 'Complete Person', [['Python', 0.9], ['Go', 0.9]], 5, 'Backend Engineer').record;
  full.emails = ['x@y.com'];
  full.phones = ['+14155550132'];
  full.location = { city: 'SF', region: null, country: 'US' };
  full.links.github = 'https://github.com/x';
  full.links.linkedin = 'https://linkedin.com/in/x';
  full.experience = [{ company: 'Acme', title: 'Engineer', start: '2020-01', end: null, summary: 'work' }];
  full.education = [{ institution: 'MIT', degree: 'BS', field: 'CS', end_year: 2019 }];
  full.projects = [{ name: 'Thing', technologies: ['Go'], summary: 'x' }];
  full.certifications = [{ name: 'Cert', issuer: 'Org', summary: null }];
  full.skills = full.skills.map((s) => ({ ...s, sources: ['ats', 'github'] }));

  const suggestions = suggestImprovements(full, {});
  assert.equal(suggestions.filter((s) => s.severity === 'high').length, 0);
});

test('github enrichment collects profile handles but never repo links', () => {
  const sr = [{
    ok: true,
    sourceType: 'resume',
    sourceId: 'r.pdf',
    subjects: [{
      sourceId: 'r.pdf', sourceType: 'resume',
      identity: { emails: [], phones: [], names: [] },
      observations: [
        { field: 'link', value: 'https://github.com/Mithilbatra', method: 't' },
        { field: 'link', value: 'https://github.com/Mithilbatra/resolvr', method: 't' },
        { field: 'link', value: 'https://linkedin.com/in/someone', method: 't' },
      ],
    }],
  }];
  assert.deepEqual(collectGithubHandles(sr), ['mithilbatra']);
});

test('pdf /URI annotations are recovered from raw and deflated streams', () => {
  const zlib = require('zlib');
  const inner = zlib.deflateSync(Buffer.from('<< /Type /Annot /A << /URI (https://github.com/testuser) >> >>', 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.5\n/URI (mailto:a@b.com)\nstream\n', 'latin1'),
    inner,
    Buffer.from('\nendstream\n%%EOF', 'latin1'),
  ]);
  const links = extractPdfLinks(pdf);
  assert.ok(links.includes('mailto:a@b.com'));
  assert.ok(links.includes('https://github.com/testuser'));
});
