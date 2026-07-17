'use strict';

const SOURCE_BASE = {
  ats: 0.92,
  csv: 0.85,
  github: 0.80,
  linkedin: 0.75,
  resume: 0.70,
  notes: 0.55,
};

const FIELD_AFFINITY = {
  ats:    { contact: 1.0, skills: 0.95, experience: 1.0, education: 1.0, links: 0.9 },
  csv:    { contact: 1.0, name: 1.0, experience: 0.85, skills: 0.7 },
  github: { skills: 1.0, links: 1.0, name: 0.9, contact: 0.6, location: 0.85, headline: 0.9 },
  linkedin: { experience: 1.0, headline: 1.0, education: 0.95, skills: 0.85 },
  resume: { experience: 0.9, education: 0.9, skills: 0.85, contact: 0.8, projects: 0.9, certifications: 0.9, activities: 0.85, coursework: 0.9 },
  notes:  { skills: 0.5, contact: 0.7, name: 0.6, experience: 0.5 },
};

const FIELD_GROUP = {
  full_name: 'name',
  email: 'contact', emails: 'contact',
  phone: 'contact', phones: 'contact',
  location: 'location',
  headline: 'headline',
  years_experience: 'yoe',
  skill: 'skills', skills: 'skills',
  experience_entry: 'experience', experience: 'experience',
  education_entry: 'education', education: 'education',
  link: 'links', links: 'links',
  project_entry: 'projects', projects: 'projects',
  certification_entry: 'certifications', certifications: 'certifications',
  activity: 'activities', activities: 'activities',
  coursework: 'coursework',
};

function sourceWeight(sourceType, field) {
  const base = SOURCE_BASE[sourceType] ?? 0.5;
  const group = FIELD_GROUP[field] || field;
  const aff = (FIELD_AFFINITY[sourceType] && FIELD_AFFINITY[sourceType][group]) ?? 1.0;
  return round(base * aff);
}

function scalarConfidence(winnerWeight, agreeingWeights = []) {
  let c = winnerWeight;
  for (const w of agreeingWeights) {
    c = c + (1 - c) * (0.5 * w);
  }
  return clamp(round(c));
}

function skillConfidence(weights, known) {
  if (!weights.length) return 0;
  const sorted = [...weights].sort((a, b) => b - a);
  let c = sorted[0];
  for (const w of sorted.slice(1)) c = c + (1 - c) * (0.5 * w);
  if (!known) c *= 0.8;
  return clamp(round(c));
}

function overallConfidence(record, fieldConfidences) {
  const vals = Object.values(fieldConfidences).filter((v) => typeof v === 'number');
  const meanConf = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  const coreFields = ['full_name', 'emails', 'phones', 'location', 'headline', 'skills', 'experience'];
  let present = 0;
  for (const f of coreFields) {
    const v = record[f];
    if (Array.isArray(v) ? v.length > 0 : v != null) present++;
  }
  const completeness = present / coreFields.length;
  return clamp(round(0.6 * meanConf + 0.4 * completeness));
}

function clamp(x) {
  return Math.max(0, Math.min(1, x));
}
function round(x) {
  return Math.round(x * 100) / 100;
}

module.exports = {
  SOURCE_BASE,
  sourceWeight,
  scalarConfidence,
  skillConfidence,
  overallConfidence,
};
