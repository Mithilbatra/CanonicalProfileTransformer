'use strict';

const { obs, subject } = require('./_common');
const { CANON } = require('../skills');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;

const SKILL_ALIASES = [];
for (const [canon, aliases] of Object.entries(CANON)) {
  SKILL_ALIASES.push({ alias: canon.toLowerCase(), raw: canon });
  aliases.forEach((a) => SKILL_ALIASES.push({ alias: a, raw: a }));
}

function extractNotes(raw, sourceId = 'recruiter_notes') {
  if (raw == null || String(raw).trim() === '') {
    return { sourceId, sourceType: 'notes', ok: false, error: 'empty source', subjects: [] };
  }
  const text = String(raw);
  const lower = text.toLowerCase();
  const observations = [];

  const labeled = text.match(/\bname\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,2})/);
  if (labeled) {
    observations.push(obs('full_name', labeled[1], 'notes:name_label'));
  } else {
    const top = text.split(/\n/).slice(0, 3).join(' ');
    const guess = top.match(/\b([A-Z][a-z]+\s+[A-Z][a-z'.-]+)\b/);
    if (guess) observations.push(obs('full_name', guess[1], 'notes:name_guess'));
  }

  (text.match(EMAIL_RE) || []).forEach((e) => observations.push(obs('email', e, 'notes:email_regex')));

  (text.match(PHONE_RE) || []).forEach((p) => {
    if ((p.replace(/\D/g, '').length) >= 9) observations.push(obs('phone', p, 'notes:phone_regex'));
  });

  const yoe = lower.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b(?:[^.]*\bexp)?/);
  if (yoe) observations.push(obs('years_experience', yoe[1], 'notes:years_regex'));

  const found = new Set();
  for (const { alias, raw: rawAlias } of SKILL_ALIASES) {
    const re = new RegExp(`(?:^|[^a-z0-9+#.])${escapeRe(alias)}(?:$|[^a-z0-9+#.])`, 'i');
    if (re.test(lower) && !found.has(alias)) {
      found.add(alias);
      observations.push(obs('skill', rawAlias, 'notes:skill_scan'));
    }
  }

  const company = text.match(/\b(?:works?|working|currently)\s+(?:at|@)\s+([A-Z][A-Za-z0-9&\-]*(?:\s+[A-Z][A-Za-z0-9&\-]*)*)/);
  if (company) {
    observations.push(
      obs('experience_entry', { company: company[1].trim(), title: null, start: null, end: null, summary: null }, 'notes:company_phrase')
    );
  }

  return {
    sourceId,
    sourceType: 'notes',
    ok: true,
    error: null,
    subjects: observations.length ? [subject(sourceId, 'notes', observations)] : [],
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { extractNotes };
