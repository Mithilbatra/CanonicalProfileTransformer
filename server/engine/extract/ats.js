'use strict';

const { obs, subject } = require('./_common');

function asObject(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return undefined; // malformed
    }
  }
  return raw;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = getPath(obj, k);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function getPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    const realKey = Object.keys(cur).find((k) => k.toLowerCase() === p.toLowerCase());
    if (realKey === undefined) return undefined;
    cur = cur[realKey];
  }
  return cur;
}

function extractOne(cand, sourceId, idx) {
  const observations = [];

  const name = pick(cand, ['candidateName', 'full_name', 'name', 'applicant.name']);
  if (name) observations.push(obs('full_name', name, 'ats:candidateName'));

  const emailVal = pick(cand, ['emailAddress', 'email', 'contact.email', 'emails']);
  toArray(emailVal).forEach((e) => observations.push(obs('email', e, 'ats:emailAddress')));

  const phoneVal = pick(cand, ['phoneNumber', 'phone', 'contact.phone', 'mobile']);
  toArray(phoneVal).forEach((p) => observations.push(obs('phone', p, 'ats:phoneNumber')));

  const loc = pick(cand, ['location', 'city', 'address.city', 'geo']);
  if (loc) observations.push(obs('location', loc, 'ats:location'));

  const headline = pick(cand, ['currentTitle', 'headline', 'professionalHeadline', 'title']);
  if (headline) observations.push(obs('headline', headline, 'ats:currentTitle'));

  const yoe = pick(cand, ['yearsOfExperience', 'years_experience', 'experienceYears', 'totalExperience']);
  if (yoe !== undefined) observations.push(obs('years_experience', yoe, 'ats:yearsOfExperience'));

  const skills = pick(cand, ['skillSet', 'skills', 'competencies', 'tags']);
  toArray(skills).forEach((s) => {
    const sName = typeof s === 'object' && s ? (s.name || s.skill || s.label) : s;
    if (sName) observations.push(obs('skill', sName, 'ats:skillSet'));
  });

  const work = pick(cand, ['workHistory', 'experience', 'positions', 'employment']);
  toArray(work).forEach((w) => {
    if (!w || typeof w !== 'object') return;
    observations.push(
      obs('experience_entry', {
        company: w.company || w.employer || w.organization || w.companyName || null,
        title: w.title || w.role || w.position || w.jobTitle || null,
        start: w.startDate || w.start || w.from || null,
        end: w.endDate || w.end || w.to || null,
        summary: w.summary || w.description || null,
      }, 'ats:workHistory')
    );
  });

  const edu = pick(cand, ['education', 'schools', 'academics']);
  toArray(edu).forEach((ed) => {
    if (!ed || typeof ed !== 'object') return;
    observations.push(
      obs('education_entry', {
        institution: ed.school || ed.institution || ed.university || ed.college || null,
        degree: ed.degree || ed.qualification || null,
        field: ed.field || ed.fieldOfStudy || ed.major || null,
        end_year: ed.endYear || ed.graduationYear || ed.year || ed.end || null,
      }, 'ats:education')
    );
  });

  const links = pick(cand, ['links', 'socialProfiles', 'urls', 'profiles']);
  toArray(links).forEach((l) => {
    const url = typeof l === 'object' && l ? (l.url || l.href || l.link) : l;
    if (url) observations.push(obs('link', url, 'ats:socialProfiles'));
  });
  ['linkedin', 'linkedinUrl', 'github', 'githubUrl', 'portfolio'].forEach((k) => {
    const v = pick(cand, [k]);
    if (v) observations.push(obs('link', v, `ats:${k}`));
  });

  return observations.length ? subject(`${sourceId}#${idx}`, 'ats', observations) : null;
}

function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.includes(',')) return v.split(',').map((x) => x.trim());
  return [v];
}

function extractAts(raw, sourceId = 'ats_json') {
  const parsed = asObject(raw);
  if (parsed === undefined) {
    return { sourceId, sourceType: 'ats', ok: false, error: 'malformed JSON', subjects: [] };
  }
  if (parsed == null) {
    return { sourceId, sourceType: 'ats', ok: false, error: 'empty source', subjects: [] };
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [parsed];

  const subjects = [];
  candidates.forEach((c, i) => {
    const s = extractOne(c, sourceId, i);
    if (s) subjects.push(s);
  });

  return { sourceId, sourceType: 'ats', ok: true, error: null, subjects };
}

module.exports = { extractAts };
