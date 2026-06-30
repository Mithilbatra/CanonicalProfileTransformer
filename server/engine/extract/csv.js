'use strict';

const Papa = require('papaparse');
const { obs, subject } = require('./_common');

const HEADER_ALIASES = {
  full_name: ['name', 'full name', 'fullname', 'candidate', 'candidate name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'contact'],
  company: ['current_company', 'current company', 'company', 'employer', 'organization'],
  title: ['title', 'job title', 'role', 'position', 'current title'],
};

function resolveHeaders(fields) {
  const map = {};
  for (const f of fields) {
    const key = String(f).toLowerCase().trim();
    for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key)) {
        map[canon] = f;
        break;
      }
    }
  }
  return map;
}

function extractCsv(raw, sourceId = 'recruiter_csv') {
  if (raw == null || String(raw).trim() === '') {
    return { sourceId, sourceType: 'csv', ok: false, error: 'empty source', subjects: [] };
  }
  let parsed;
  try {
    parsed = Papa.parse(String(raw), { header: true, skipEmptyLines: true });
  } catch (e) {
    return { sourceId, sourceType: 'csv', ok: false, error: `parse failed: ${e.message}`, subjects: [] };
  }
  if (!parsed.data || parsed.data.length === 0) {
    return { sourceId, sourceType: 'csv', ok: false, error: 'no data rows', subjects: [] };
  }

  const hmap = resolveHeaders(parsed.meta.fields || []);
  const subjects = [];

  parsed.data.forEach((row, i) => {
    const observations = [];
    const get = (canon) => (hmap[canon] ? row[hmap[canon]] : undefined);

    const name = get('full_name');
    if (name && String(name).trim()) observations.push(obs('full_name', name, 'csv:name_column'));

    const email = get('email');
    if (email && String(email).trim()) observations.push(obs('email', email, 'csv:email_column'));

    const phone = get('phone');
    if (phone && String(phone).trim()) observations.push(obs('phone', phone, 'csv:phone_column'));

    const company = get('company');
    const title = get('title');
    if ((company && String(company).trim()) || (title && String(title).trim())) {
      observations.push(
        obs('experience_entry', {
          company: company || null,
          title: title || null,
          start: null,
          end: null,
          summary: null,
        }, 'csv:current_role')
      );
    }

    if (observations.length) {
      subjects.push(subject(`${sourceId}#row${i}`, 'csv', observations));
    }
  });

  return { sourceId, sourceType: 'csv', ok: true, error: null, subjects };
}

module.exports = { extractCsv };
