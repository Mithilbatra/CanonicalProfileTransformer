'use strict';

// Labeled evaluation set for the extraction + entity-resolution engine.
//
// Each case feeds a set of sources through detect → extract → merge and then
// checks the resolved candidate records against hand-labeled expectations.
// This turns engine quality into a measured number, so a change to the fuzzy
// thresholds, the confidence weights, or an extractor can be judged by whether
// accuracy went up or down — not by eyeballing one resume.
//
// A case's `expect` is a list of checks; each check is a boolean assertion.
// See benchmark/run.js for the scorer. Add cases here as new scenarios appear.

const fs = require('fs');
const path = require('path');
const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');

// A compact, LaTeX-PDF-style résumé (glued columns, dangling bullets, a glued
// email caption, a project date glued onto the last tech) — the hard case the
// resume extractor exists to survive.
const GLUED_RESUME = `SATYAM KUMAR
+91 8810397089⋄official.satyam@gmail.comLinkedIn⋄GitHub
EDUCATION
National Institute of Technology, Delhi2023 – Present
B.Tech.  in Computer Science and EngineeringCGPA: 8.93
SKILLS
ProgrammingJava, Python, C++, JavaScript
DatabasesPostgreSQL, MongoDB
WORK EXPERIENCE
HSBC :Software Engineering InternJune 2026 – Present
•
Built an internal chatbot for tax queries.
PROJECTS
Compiler Project|C++, Compiler Design, AssemblyJanuary 2025
•
Designed and built a compiler in C++.
`;

module.exports = [
  {
    name: 'multi-source conflict (recruiter + ATS + github + notes)',
    sources: [
      { name: 'recruiter.csv', content: read('recruiter.csv') },
      { name: 'ats.json', content: read('ats.json') },
      { name: 'github.json', content: read('github.json') },
      { name: 'recruiter_notes.txt', content: read('recruiter_notes.txt') },
    ],
    expect: (recs) => {
      const jordan = byEmail(recs, 'jordan.rivera@example.com');
      const casey = byEmail(recs, 'casey.tan@example.com');
      return [
        ['resolves exactly 2 people', recs.length === 2],
        ['jordan found by email', !!jordan],
        ['casey found by email (kept separate)', !!casey && casey !== jordan],
        ['jordan name normalized', jordan && /Jordan/.test(jordan.full_name || '')],
        ['jordan phone E.164', jordan && jordan.phones.includes('+14155550132')],
        ['jordan has Python', jordan && skillNames(jordan).includes('Python')],
        ['jordan has Kubernetes', jordan && skillNames(jordan).includes('Kubernetes')],
        ['github merged via link (github in a skill source)', jordan && jordan.skills.some((s) => (s.sources || []).includes('github'))],
        ['no invented location for casey', casey && casey.location === null],
      ];
    },
  },
  {
    name: 'fuzzy merge: typo name + shared company',
    sources: [
      { name: 'a.csv', content: 'Full Name,Current Company\nJordan Rivera,Northwind Labs\n' },
      { name: 'b.json', content: JSON.stringify({ candidateName: 'Jordn Rivera', workHistory: [{ company: 'Northwind Labs' }] }) },
    ],
    expect: (recs) => [['spelling drift + same company merges to 1', recs.length === 1]],
  },
  {
    name: 'fuzzy refuse: same name, conflicting emails',
    sources: [
      { name: 'a.csv', content: 'Full Name,E-mail,Current Company\nJordan Rivera,jordan@a.com,Northwind Labs\n' },
      { name: 'b.json', content: JSON.stringify({ candidateName: 'Jordn Rivera', emailAddress: 'other@b.com', workHistory: [{ company: 'Northwind Labs' }] }) },
    ],
    expect: (recs) => [['conflicting contact keeps them separate', recs.length === 2]],
  },
  {
    name: 'resume: glued PDF text (email caption, column glue, project date)',
    sources: [{ name: 'resume.pdf', content: GLUED_RESUME }],
    expect: (recs) => {
      const r = recs[0];
      const skills = r ? skillNames(r) : [];
      const dated = skills.filter((s) => /\d{4}|january|february|december/i.test(s));
      return [
        ['resolves 1 candidate', recs.length === 1],
        ['name recovered (title-cased)', r && /Satyam Kumar/i.test(r.full_name || '')],
        ['glued email caption trimmed', r && r.emails.includes('official.satyam@gmail.com')],
        ['no date leaked into skills', dated.length === 0],
        ['PostgreSQL extracted (column glue split)', skills.includes('PostgreSQL')],
        ['experience: HSBC intern', r && r.experience.some((e) => /HSBC/i.test(e.company || ''))],
        ['project extracted, not fragmented', r && r.projects.length === 1],
      ];
    },
  },
  {
    name: 'link-only merge (github blob, no email)',
    sources: [
      { name: 'ats.json', content: JSON.stringify({ candidateName: 'Dana Lee', emailAddress: 'dana@example.com', links: ['https://github.com/danalee'] }) },
      { name: 'github.json', content: JSON.stringify({ user: { login: 'danalee', name: 'Dana Lee', html_url: 'https://github.com/danalee' }, repos: [{ language: 'Go' }] }) },
    ],
    expect: (recs) => [
      ['github merges via shared profile link', recs.length === 1],
      ['skills gained from github', recs[0] && skillNames(recs[0]).includes('Go')],
    ],
  },
];

function byEmail(recs, email) {
  return recs.find((r) => r.emails.includes(email));
}
function skillNames(r) {
  return (r.skills || []).map((s) => s.name);
}
