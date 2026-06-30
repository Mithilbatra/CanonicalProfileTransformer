'use strict';

const { obs, subject } = require('./_common');

function asObject(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return undefined; } // malformed
  }
  return raw;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function dateStr(d) {
  if (d == null) return null;
  if (typeof d === 'string' || typeof d === 'number') return String(d);
  if (typeof d === 'object') {
    if (d.year && d.month) return `${d.year}-${d.month}`;
    if (d.year) return String(d.year);
  }
  return null;
}

function extractOne(profile, sourceId, idx) {
  const observations = [];

  const name = pick(profile, ['name', 'fullName', 'full_name', 'displayName']);
  if (name) observations.push(obs('full_name', name, 'linkedin:name'));

  const headline = pick(profile, ['headline', 'title', 'occupation']);
  if (headline) observations.push(obs('headline', headline, 'linkedin:headline'));

  const loc = pick(profile, ['location', 'locationName', 'geoLocation', 'city']);
  if (loc) observations.push(obs('location', loc, 'linkedin:location'));

  const email = pick(profile, ['email', 'emailAddress']);
  if (email) observations.push(obs('email', email, 'linkedin:email'));

  const url = pick(profile, ['profile', 'profileUrl', 'publicProfileUrl', 'url', 'vanityUrl']);
  if (url) observations.push(obs('link', url, 'linkedin:profileUrl'));

  const positions = pick(profile, ['positions', 'experience', 'workExperience', 'jobs']);
  toArray(positions).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    observations.push(
      obs('experience_entry', {
        company: p.companyName || p.company || p.organization || p.employer || null,
        title: p.title || p.role || p.position || null,
        start: dateStr(p.startDate || p.start || p.from || (p.timePeriod && p.timePeriod.startDate)),
        end: dateStr(p.endDate || p.end || p.to || (p.timePeriod && p.timePeriod.endDate)),
        summary: p.description || p.summary || null,
      }, 'linkedin:positions')
    );
  });

  const education = pick(profile, ['education', 'schools', 'educations']);
  toArray(education).forEach((e) => {
    if (!e || typeof e !== 'object') return;
    observations.push(
      obs('education_entry', {
        institution: e.schoolName || e.school || e.institution || e.university || null,
        degree: e.degreeName || e.degree || e.qualification || null,
        field: e.fieldOfStudy || e.field || e.major || null,
        end_year: dateStr(e.endDate || e.end || e.graduationYear || e.year),
      }, 'linkedin:education')
    );
  });

  const skills = pick(profile, ['skills', 'skillSet', 'topSkills']);
  toArray(skills).forEach((s) => {
    const sName = typeof s === 'object' && s ? (s.name || s.skill) : s;
    if (sName) observations.push(obs('skill', sName, 'linkedin:skills'));
  });

  return observations.length ? subject(`${sourceId}#${idx}`, 'linkedin', observations) : null;
}

function extractLinkedin(raw, sourceId = 'linkedin') {
  const parsed = asObject(raw);
  if (parsed === undefined) {
    return { sourceId, sourceType: 'linkedin', ok: false, error: 'malformed JSON', subjects: [] };
  }
  if (parsed == null) {
    return { sourceId, sourceType: 'linkedin', ok: false, error: 'empty source', subjects: [] };
  }
  const list = Array.isArray(parsed) ? parsed : (parsed.profiles || [parsed]);
  const subjects = list.map((p, i) => extractOne(p, sourceId, i)).filter(Boolean);
  return { sourceId, sourceType: 'linkedin', ok: true, subjects };
}

module.exports = { extractLinkedin };
