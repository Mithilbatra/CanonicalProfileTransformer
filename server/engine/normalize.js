'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(raw) {
  if (raw == null) return null;
  const e = String(raw).trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

function normalizePhone(raw, defaultCountry = 'US') {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    const p = parsePhoneNumberFromString(s, defaultCountry);
    if (p && p.isValid()) return p.number; // E.164
  } catch (_) {
    return null;
  }
  return null;
}

const MONTHS = {
  jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
  apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07',
  july: '07', aug: '08', august: '08', sep: '09', sept: '09', september: '09',
  oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
};

function normalizeDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || /present|current|now|ongoing/.test(s)) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
  if (m) return `${m[1]}-${pad2(m[2])}`;

  m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[2]}-${pad2(m[1])}`;

  m = s.match(/^(\d{1,2})[-/.](\d{2})$/);
  if (m) {
    const mm = parseInt(m[1], 10);
    if (mm >= 1 && mm <= 12) {
      const yy = parseInt(m[2], 10);
      const year = yy < 70 ? 2000 + yy : 1900 + yy;
      return `${year}-${pad2(mm)}`;
    }
  }

  m = s.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (m && MONTHS[m[1]]) return `${m[2]}-${MONTHS[m[1]]}`;

  m = s.match(/^(\d{4})\s+([a-z]+)\.?$/);
  if (m && MONTHS[m[2]]) return `${m[1]}-${MONTHS[m[2]]}`;

  m = s.match(/^(\d{4})$/);
  if (m) return `${m[1]}-01`;

  return null;
}

function normalizeYear(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const y = parseInt(m[0], 10);
  const now = new Date().getFullYear();
  return y >= 1950 && y <= now + 8 ? y : null;
}

function pad2(x) {
  return String(parseInt(x, 10)).padStart(2, '0');
}

const COUNTRY = {
  'united states': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', us: 'US',
  america: 'US', 'united states of america': 'US',
  india: 'IN', bharat: 'IN', in: 'IN',
  'united kingdom': 'GB', uk: 'GB', 'u.k.': 'GB', britain: 'GB',
  'great britain': 'GB', england: 'GB', gb: 'GB',
  canada: 'CA', ca: 'CA',
  germany: 'DE', deutschland: 'DE', de: 'DE',
  france: 'FR', fr: 'FR',
  australia: 'AU', au: 'AU',
  singapore: 'SG', sg: 'SG',
  netherlands: 'NL', holland: 'NL', nl: 'NL',
  ireland: 'IE', ie: 'IE',
  spain: 'ES', es: 'ES',
  brazil: 'BR', br: 'BR',
  japan: 'JP', jp: 'JP',
  china: 'CN', cn: 'CN',
};
const US_STATES = new Set(['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy']);

function normalizeCountry(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  return COUNTRY[s] || COUNTRY[s.replace(/\./g, '')] || null;
}

function normalizeLocation(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  const out = { city: null, region: null, country: null };

  if (parts.length === 1) {
    out.city = parts[0];
  } else if (parts.length === 2) {
    out.city = parts[0];
    const second = parts[1];
    const cc = normalizeCountry(second);
    if (cc) {
      out.country = cc;
    } else if (US_STATES.has(second.toLowerCase())) {
      out.region = second.toUpperCase();
      out.country = 'US';
    } else {
      out.region = second;
    }
  } else {
    out.city = parts[0];
    out.region = parts[1];
    out.country = normalizeCountry(parts[parts.length - 1]);
    if (!out.country && US_STATES.has(parts[1].toLowerCase())) {
      out.region = parts[1].toUpperCase();
      out.country = 'US';
    }
  }
  if (!out.city && !out.region && !out.country) return null;
  return out;
}

function normalizeName(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!s || s.length > 120) return null;
  return s;
}

function normalizeUrl(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    let clean = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}`.replace(/\/$/, '');
    return clean;
  } catch (_) {
    return null;
  }
}

function classifyLink(url) {
  const clean = normalizeUrl(url);
  if (!clean) return null;
  const host = clean.toLowerCase();
  if (host.includes('linkedin.com')) return { kind: 'linkedin', url: clean };
  if (host.includes('github.com')) return { kind: 'github', url: clean };
  if (/\b(portfolio|me\.|\.dev|\.io|behance|dribbble)\b/.test(host)) {
    return { kind: 'portfolio', url: clean };
  }
  return { kind: 'other', url: clean };
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  normalizeDate,
  normalizeYear,
  normalizeCountry,
  normalizeLocation,
  normalizeName,
  normalizeUrl,
  classifyLink,
};
