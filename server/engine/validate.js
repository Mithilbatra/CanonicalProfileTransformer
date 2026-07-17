'use strict';

const E164 = /^\+[1-9]\d{6,14}$/;
const YYYY_MM = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO2 = /^[A-Z]{2}$/;

function validateCanonical(record) {
  const errors = [];
  const e = (m) => errors.push(m);

  if (typeof record.candidate_id !== 'string' || !record.candidate_id) e('candidate_id must be a non-empty string');
  if (record.full_name != null && typeof record.full_name !== 'string') e('full_name must be string|null');

  if (!Array.isArray(record.emails)) e('emails must be an array');
  if (!Array.isArray(record.phones)) e('phones must be an array');
  else record.phones.forEach((p, i) => { if (!E164.test(p)) e(`phones[${i}] "${p}" not E.164`); });

  if (record.location != null) {
    if (typeof record.location !== 'object') e('location must be object|null');
    else if (record.location.country != null && !ISO2.test(record.location.country)) {
      e(`location.country "${record.location.country}" not ISO-3166 alpha-2`);
    }
  }

  if (typeof record.links !== 'object' || record.links == null) e('links must be an object');
  if (record.years_experience != null && typeof record.years_experience !== 'number') e('years_experience must be number|null');

  if (!Array.isArray(record.skills)) e('skills must be an array');
  else record.skills.forEach((s, i) => {
    if (typeof s.name !== 'string') e(`skills[${i}].name must be string`);
    if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) e(`skills[${i}].confidence out of range`);
    if (!Array.isArray(s.sources)) e(`skills[${i}].sources must be array`);
  });

  if (!Array.isArray(record.experience)) e('experience must be an array');
  else record.experience.forEach((x, i) => {
    if (x.start != null && !YYYY_MM.test(x.start)) e(`experience[${i}].start "${x.start}" not YYYY-MM`);
    if (x.end != null && !YYYY_MM.test(x.end)) e(`experience[${i}].end "${x.end}" not YYYY-MM`);
  });

  if (!Array.isArray(record.education)) e('education must be an array');
  else record.education.forEach((x, i) => {
    if (x.end_year != null && (typeof x.end_year !== 'number')) e(`education[${i}].end_year must be number|null`);
  });

  if (!Array.isArray(record.projects)) e('projects must be an array');
  else record.projects.forEach((p, i) => {
    if (typeof p.name !== 'string' || !p.name) e(`projects[${i}].name must be a non-empty string`);
    if (!Array.isArray(p.technologies)) e(`projects[${i}].technologies must be an array`);
  });
  if (!Array.isArray(record.certifications)) e('certifications must be an array');
  else record.certifications.forEach((c, i) => {
    if (typeof c.name !== 'string' || !c.name) e(`certifications[${i}].name must be a non-empty string`);
  });
  if (!Array.isArray(record.activities)) e('activities must be an array');
  else record.activities.forEach((a, i) => { if (typeof a !== 'string') e(`activities[${i}] must be a string`); });
  if (!Array.isArray(record.coursework)) e('coursework must be an array');
  else record.coursework.forEach((c, i) => { if (typeof c !== 'string') e(`coursework[${i}] must be a string`); });

  if (!Array.isArray(record.provenance)) e('provenance must be an array');
  if (typeof record.overall_confidence !== 'number' || record.overall_confidence < 0 || record.overall_confidence > 1) {
    e('overall_confidence must be a number in [0,1]');
  }

  return { valid: errors.length === 0, errors };
}

function validateProjection(output, config) {
  const errors = [];
  for (const field of config.fields || []) {
    const present = Object.prototype.hasOwnProperty.call(output, field.path) && output[field.path] != null;
    if (field.required && !present) {
      errors.push(`required output field "${field.path}" is missing or null`);
      continue;
    }
    if (!present) continue;
    const v = output[field.path];
    if (!typeOk(v, field.type)) errors.push(`output field "${field.path}" failed type "${field.type}"`);
  }
  return { valid: errors.length === 0, errors };
}

function typeOk(v, type) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'string[]': return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'object': return typeof v === 'object' && v != null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case undefined: return true;
    default: return true;
  }
}

module.exports = { validateCanonical, validateProjection };
