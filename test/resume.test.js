'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractResume } = require('../server/engine/extract/resume');
const { nameSimilarity, jaroWinkler } = require('../server/engine/fuzzy');
const { detect } = require('../server/engine/detect');
const { mergeAll } = require('../server/engine/merge');

const SAMPLE_RESUME = `Jordan Rivera
Senior Backend Engineer
San Francisco, CA
jordan.rivera@example.com | (415) 555-0132 | https://github.com/jrivera-dev

EXPERIENCE
Senior Backend Engineer — Northwind Labs    Mar 2021 - Present
- Built the payments platform in Go and Python.
Software Engineer — Initech    Jun 2018 - Feb 2021
- Worked on internal tooling.

EDUCATION
B.Tech in Computer Science, NIT Delhi, 2018

SKILLS
Languages: Python, Go, SQL
Infra: Docker, Kubernetes, AWS
`;

test('resume extractor pulls name, contact, sections', () => {
  const r = extractResume(SAMPLE_RESUME, 'resume.pdf');
  assert.equal(r.ok, true);
  assert.equal(r.subjects.length, 1);
  const fields = {};
  for (const o of r.subjects[0].observations) (fields[o.field] = fields[o.field] || []).push(o.value);

  assert.deepEqual(fields.full_name, ['Jordan Rivera']);
  assert.deepEqual(fields.email, ['jordan.rivera@example.com']);
  assert.ok(fields.phone[0].includes('415'));
  assert.ok(fields.link[0].includes('github.com/jrivera-dev'));
  assert.ok(fields.headline[0].includes('Senior Backend Engineer'));
  assert.ok(fields.skill.includes('Python'));
  assert.ok(fields.skill.includes('Kubernetes'));
  // category labels like "Languages" must not leak in as skills
  assert.ok(!fields.skill.includes('Languages'));

  assert.equal(fields.experience_entry.length, 2);
  const [job1, job2] = fields.experience_entry;
  assert.equal(job1.company, 'Northwind Labs');
  assert.equal(job1.title, 'Senior Backend Engineer');
  assert.match(job1.end, /present/i);
  assert.equal(job2.company, 'Initech');

  assert.equal(fields.education_entry.length, 1);
  assert.match(fields.education_entry[0].institution, /NIT Delhi/);
  assert.equal(fields.education_entry[0].end_year, '2018');
});

// Mimics a LaTeX-generated PDF: ALL-CAPS name, glued columns ("Delhi2023",
// "ProgrammingJava", "InternJune 2026"), two-line education entries with
// CGPA/percentage suffixes, and the extra sections.
const GLUED_PDF_RESUME = `MITHIL BATRA
+91 8810397089⋄mithil.batra05@example.com
EDUCATION
National Institute of Technology, Delhi2023 – Present
B.Tech.  in Computer Science and EngineeringCGPA: 8.93
Stepping Stones School, Chandigarh2022 – 2023
CBSE Board (XII)Percentage:  91.8
SKILLS
ProgrammingJava, Python, C++, JavaScript
DatabasesCassandra, MySQL, PostgreSQL
UI/UXReact, HTML, CSS, Figma
WORK EXPERIENCE
HSBC :Software Engineering InternJune 2026 – Present
•Improving an internal chatbot through better intent recognition.
PROJECTS
Resolvr – Incident Management and Alerting App|Next.js, Tailwind CSS, PostgreSQL
•Built a full-stack web application combining issue tracking and alerting.
•Developed incident timeline and runbook integration for tracking.Github
Pathfinding Optimisation using Google API|Python, JavaScript
•Compared A* and Dijkstra algorithms against API results.
CERTIFICATIONS
•Cassandra  (Udemy)–  Gained  expertise  in  distributed  database  management.
•Azure Services (Microsoft)– Acquired practical experience in cloud solutions.
EXTRA-CURRICULAR ACTIVITIES
•Deputy General Secretary – Google Developer Student Clubs, NIT Delhi
•Won Gold at MST Tournament 2025
•Secured99.467 percentile in JEE Mains, among the top 0.5% of candidates
•Solved800+problems across all coding platforms using es6 and html5
COURSEWORK
Software Engineering, Data Mining, Machine Learning, Quantum Computing
`;

test('glued PDF resume: header, sections and columns all land under the right fields', () => {
  const r = extractResume(GLUED_PDF_RESUME, 'MithilResume.pdf');
  const fields = {};
  for (const o of r.subjects[0].observations) (fields[o.field] = fields[o.field] || []).push(o.value);

  // ALL-CAPS letterhead name is title-cased; a degree line is NOT a headline
  assert.deepEqual(fields.full_name, ['Mithil Batra']);
  assert.equal(fields.headline, undefined);
  assert.ok(fields.phone[0].includes('8810397089'));

  // education: institution lines pair with the degree line beneath them
  assert.equal(fields.education_entry.length, 2);
  const [nit, school] = fields.education_entry;
  assert.equal(nit.institution, 'National Institute of Technology, Delhi');
  assert.equal(nit.degree, 'B.Tech.');
  assert.equal(nit.field, 'Computer Science and Engineering');
  assert.equal(nit.end_year, null); // "2023 – Present" is ongoing
  assert.equal(school.institution, 'Stepping Stones School, Chandigarh');
  assert.equal(school.degree, 'CBSE Board (XII)'); // grade suffix stripped
  assert.equal(school.end_year, '2023');

  // glued category labels are stripped from the first skill of each row
  assert.ok(fields.skill.includes('Java'));
  assert.ok(fields.skill.includes('Cassandra'));
  assert.ok(fields.skill.includes('React'));
  assert.ok(!fields.skill.some((s) => /programming|databases|ui\/ux/i.test(s)));

  // "Company :Title    Month Year – Present" experience shape
  assert.equal(fields.experience_entry.length, 1);
  assert.equal(fields.experience_entry[0].company, 'HSBC');
  assert.equal(fields.experience_entry[0].title, 'Software Engineering Intern');
  assert.equal(fields.experience_entry[0].start, 'June 2026');

  // projects: "Name – tagline | tech list" headers with bullet summaries
  assert.equal(fields.project_entry.length, 2);
  const [resolvr, pathfinding] = fields.project_entry;
  assert.equal(resolvr.name, 'Resolvr – Incident Management and Alerting App');
  assert.deepEqual(resolvr.technologies, ['Next.js', 'Tailwind CSS', 'PostgreSQL']);
  assert.ok(resolvr.summary.includes('issue tracking'));
  assert.ok(resolvr.summary.endsWith('tracking.'), 'glued "Github" link caption is dropped');
  assert.equal(pathfinding.name, 'Pathfinding Optimisation using Google API');
  // project tech doubles as skill evidence
  assert.ok(fields.skill.includes('Tailwind CSS'));

  // the new sections
  assert.deepEqual(fields.certification_entry.map((c) => [c.name, c.issuer]), [
    ['Cassandra', 'Udemy'],
    ['Azure Services', 'Microsoft'],
  ]);
  assert.equal(fields.activity.length, 4);
  assert.ok(fields.activity[0].startsWith('Deputy General Secretary'));

  // font-boundary glue is repaired in prose ("Secured99.467", "Solved800+problems")
  // without touching version-suffixed tech names (es6, html5)
  assert.ok(fields.activity[2].startsWith('Secured 99.467 percentile'));
  assert.ok(fields.activity[3].startsWith('Solved 800+ problems'));
  assert.ok(fields.activity[3].includes('es6 and html5'));
  assert.deepEqual(fields.coursework, ['Software Engineering', 'Data Mining', 'Machine Learning', 'Quantum Computing']);
});

test('new sections flow through merge into the canonical record', () => {
  const records = mergeAll([extractResume(GLUED_PDF_RESUME, 'r.pdf')]);
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.projects.length, 2);
  assert.equal(rec.projects[0].name, 'Resolvr – Incident Management and Alerting App');
  assert.equal(rec.certifications.length, 2);
  assert.equal(rec.certifications[0].issuer, 'Udemy');
  assert.equal(rec.activities.length, 4);
  assert.equal(rec.coursework.length, 4);
  assert.equal(rec.headline, null);
  assert.equal(rec.education[0].end_year, null);
  assert.equal(rec.education[1].end_year, 2023);
});

// Reproduces the damage seen in a real single-column PDF export: the email
// caption glued to the TLD, the project date glued to the last technology,
// and bullets whose glyph sits on its own line with wrapped continuation text.
const GLUED_LINK_RESUME = `Satyam Kumar Chauhan
Kurukshetra, Haryana
officialsatyam9665@gmail.comLinkedIn
GitHub
PROJECTS
Mathematics Club Website|Next.js, Prisma, Docker, PostgreSQLJanuary 2025
•
Developed a mathematics club website showcasing SSR and CSR techniques for
optimized content delivery and user experience.
•
Built database infrastructure with Prisma ORM and PostgreSQL for club data
management.
YAC (Yet Another Compiler)|C++, Compiler Design, AssemblyJanuary 2025
•
Designed and built a full-fledged compiler in C++, implementing lexical
analysis and code generation.
TECHNICAL SKILLS
Programming Languages:Go, JavaScript, Python, C++, HTML5
CERTIFICATIONS & ACHIEVEMENTS
•
Machine Learning Specialization - Stanford University (Coursera)
`;

test('glued email caption is trimmed off the TLD', () => {
  const r = extractResume(GLUED_LINK_RESUME, 'resume_1.pdf');
  const emails = r.subjects[0].observations.filter((o) => o.field === 'email').map((o) => o.value);
  assert.deepEqual(emails, ['officialsatyam9665@gmail.com']);
});

test('project dates do not leak into technologies or become skills', () => {
  const r = extractResume(GLUED_LINK_RESUME, 'resume_1.pdf');
  const fields = {};
  for (const o of r.subjects[0].observations) (fields[o.field] = fields[o.field] || []).push(o.value);

  // exactly two projects — wrapped bullet text must not spawn extra entries
  assert.equal(fields.project_entry.length, 2);
  assert.deepEqual(fields.project_entry[0].technologies, ['Next.js', 'Prisma', 'Docker', 'PostgreSQL']);
  assert.deepEqual(fields.project_entry[1].technologies, ['C++', 'Compiler Design', 'Assembly']);
  assert.ok(/showcasing SSR/.test(fields.project_entry[0].summary));

  // no skill carries a month or year
  const dated = fields.skill.filter((s) => /\d{4}|january|february|december/i.test(s));
  assert.deepEqual(dated, []);
  assert.ok(fields.skill.includes('PostgreSQL'));
  assert.ok(fields.skill.includes('Assembly'));

  // "CERTIFICATIONS & ACHIEVEMENTS" heading is recognized
  assert.ok(fields.certification_entry.some((c) => /Machine Learning Specialization/.test(c.name)));
});

test('resume extractor: empty and garbage inputs fail gracefully', () => {
  assert.equal(extractResume('').ok, false);
  assert.equal(extractResume(null).ok, false);
  const junk = extractResume('%%%%\n@@@@\n1234');
  assert.equal(junk.ok, true); // no crash; whatever was found is returned
});

test('detect recognizes resumes by filename and by shape', () => {
  assert.equal(detect({ name: 'MithilBatra_Resume.pdf', content: '' }), 'resume');
  assert.equal(detect({ name: 'cv.docx', content: '' }), 'resume');
  assert.equal(detect({ name: 'pasted.txt', content: SAMPLE_RESUME }), 'resume');
  // regressions: old detection still wins where it should
  assert.equal(detect({ name: 'recruiter.csv', content: '' }), 'csv');
  assert.equal(detect({ name: 'ats.json', content: '{}' }), 'ats');
});

test('jaro-winkler basics', () => {
  assert.equal(jaroWinkler('rivera', 'rivera'), 1);
  assert.ok(jaroWinkler('rivera', 'rivrea') > 0.9); // transposition
  assert.ok(jaroWinkler('rivera', 'zhang') < 0.5);
});

test('name similarity handles initials, order, and typos', () => {
  assert.ok(nameSimilarity('Jordan Rivera', 'Jordan A. Rivera') > 0.9);
  assert.ok(nameSimilarity('Jordan Rivera', 'Rivera, Jordan') > 0.9);
  assert.ok(nameSimilarity('Jordan Rivera', 'Jordn Rivera') > 0.9);
  assert.ok(nameSimilarity('Jordan Rivera', 'Casey Tan') < 0.6);
});

function subjectOf(sourceType, observations) {
  const emails = observations.filter((o) => o.field === 'email').map((o) => o.value);
  const names = observations.filter((o) => o.field === 'full_name').map((o) => o.value);
  return {
    sourceId: sourceType,
    sourceType,
    identity: { emails, phones: [], names },
    observations,
  };
}

test('fuzzy match merges a typo name when the company corroborates', () => {
  const a = subjectOf('csv', [
    { field: 'full_name', value: 'Jordan Rivera', method: 't' },
    { field: 'experience_entry', value: { company: 'Northwind Labs' }, method: 't' },
  ]);
  const b = subjectOf('ats', [
    { field: 'full_name', value: 'Jordn Rivera', method: 't' }, // typo, no shared email
    { field: 'experience_entry', value: { company: 'Northwind Labs' }, method: 't' },
  ]);
  const records = mergeAll([
    { ok: true, subjects: [a] },
    { ok: true, subjects: [b] },
  ]);
  assert.equal(records.length, 1);
});

test('fuzzy match refuses when emails conflict, and same name alone never merges', () => {
  const a = subjectOf('csv', [
    { field: 'full_name', value: 'Jordan Rivera', method: 't' },
    { field: 'email', value: 'jordan@a.com', method: 't' },
    { field: 'experience_entry', value: { company: 'Northwind Labs' }, method: 't' },
  ]);
  // near-identical name (so only the fuzzy path could merge it — the exact
  // name+company weak key doesn't fire) but a different email: different person
  const conflicting = subjectOf('ats', [
    { field: 'full_name', value: 'Jordn Rivera', method: 't' },
    { field: 'email', value: 'other.jordan@b.com', method: 't' },
    { field: 'experience_entry', value: { company: 'Northwind Labs' }, method: 't' },
  ]);
  assert.equal(
    mergeAll([{ ok: true, subjects: [a] }, { ok: true, subjects: [conflicting] }]).length,
    2
  );

  const bareA = subjectOf('csv', [{ field: 'full_name', value: 'John Smith', method: 't' }]);
  const bareB = subjectOf('ats', [{ field: 'full_name', value: 'John Smith', method: 't' }]);
  assert.equal(
    mergeAll([{ ok: true, subjects: [bareA] }, { ok: true, subjects: [bareB] }]).length,
    2
  );
});
