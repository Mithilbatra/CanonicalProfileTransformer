'use strict';

const crypto = require('crypto');
const N = require('./normalize');
const { canonicalizeSkill } = require('./skills');
const { sourceWeight, scalarConfidence, skillConfidence, overallConfidence } = require('./confidence');

function mergeAll(sourceResults) {
  const subjects = [];
  for (const sr of sourceResults) {
    if (sr && sr.ok && Array.isArray(sr.subjects)) subjects.push(...sr.subjects);
  }
  const clusters = resolveEntities(subjects);
  return clusters.map((cluster) => buildRecord(cluster));
}

function resolveEntities(subjects) {
  const parent = subjects.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const emailIndex = new Map();
  const phoneIndex = new Map();
  const linkIndex = new Map();
  const nameCompanyIndex = new Map();

  subjects.forEach((s, i) => {
    s.identity.emails.map((e) => N.normalizeEmail(e)).filter(Boolean).forEach((e) => addIndex(emailIndex, e, i));
    s.identity.phones.map((p) => N.normalizePhone(p)).filter(Boolean).forEach((p) => addIndex(phoneIndex, p, i));
    s.observations
      .filter((o) => o.field === 'link')
      .map((o) => N.classifyLink(o.value))
      .filter((c) => c && (c.kind === 'github' || c.kind === 'linkedin'))
      .forEach((c) => addIndex(linkIndex, `${c.kind}:${c.url.toLowerCase()}`, i));
    const names = s.identity.names.map((n) => normName(n)).filter(Boolean);
    const companies = s.observations
      .filter((o) => o.field === 'experience_entry' && o.value && o.value.company)
      .map((o) => normName(o.value.company));
    names.forEach((nm) => {
      addIndex(nameCompanyIndex, `name:${nm}`, i);
      companies.forEach((c) => addIndex(nameCompanyIndex, `nc:${nm}|${c}`, i));
    });
  });

  // strong keys
  for (const idx of [emailIndex, phoneIndex, linkIndex]) {
    for (const group of idx.values()) for (let k = 1; k < group.length; k++) union(group[0], group[k]);
  }
  // weak key
  for (const [key, group] of nameCompanyIndex) {
    if (key.startsWith('nc:')) for (let k = 1; k < group.length; k++) union(group[0], group[k]);
  }

  const byRoot = new Map();
  subjects.forEach((s, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(s);
  });
  return [...byRoot.values()];
}

function buildRecord(cluster) {
  const observations = [];
  for (const s of cluster) {
    for (const o of s.observations) {
      observations.push({
        ...o,
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        weight: sourceWeight(s.sourceType, o.field),
      });
    }
  }

  const provenance = [];
  const fieldConf = {};
  const record = {
    candidate_id: null,
    full_name: null,
    emails: [],
    phones: [],
    location: null,
    links: { linkedin: null, github: null, portfolio: null, other: [] },
    headline: null,
    years_experience: null,
    skills: [],
    experience: [],
    education: [],
    provenance,
    overall_confidence: 0,
  };

  const byField = groupBy(observations, (o) => o.field);

  resolveScalar('full_name', byField.full_name, N.normalizeName, record, provenance, fieldConf);
  resolveScalar('headline', byField.headline, (v) => clampStr(v, 160), record, provenance, fieldConf, 'headline');

  if (byField.years_experience) {
    const cands = byField.years_experience
      .map((o) => ({ ...o, norm: toYears(o.value) }))
      .filter((o) => o.norm != null);
    if (cands.length) {
      const winner = pickWinner(cands);
      record.years_experience = winner.norm;
      fieldConf.years_experience = confidenceFor(winner, cands);
      provenance.push({ field: 'years_experience', source: winner.sourceId, method: winner.method });
    }
  }

  resolveList('emails', byField.email, N.normalizeEmail, record, provenance, fieldConf);
  resolveList('phones', byField.phone, (v) => N.normalizePhone(v), record, provenance, fieldConf);

  if (byField.location) {
    const cands = byField.location
      .map((o) => ({ ...o, norm: N.normalizeLocation(o.value) }))
      .filter((o) => o.norm);
    if (cands.length) {
      cands.sort((a, b) => completeness(b.norm) - completeness(a.norm) || b.weight - a.weight);
      const winner = cands[0];
      record.location = winner.norm;
      fieldConf.location = confidenceFor(winner, cands.filter((c) => sameLoc(c.norm, winner.norm)));
      provenance.push({ field: 'location', source: winner.sourceId, method: winner.method });
    }
  }

  if (byField.link) {
    const otherSet = new Set();
    for (const o of byField.link) {
      const c = N.classifyLink(o.value);
      if (!c) continue;
      if (c.kind === 'other') {
        if (!otherSet.has(c.url)) {
          otherSet.add(c.url);
          record.links.other.push(c.url);
          provenance.push({ field: 'links.other', source: o.sourceId, method: o.method });
        }
      } else if (!record.links[c.kind]) {
        record.links[c.kind] = c.url;
        provenance.push({ field: `links.${c.kind}`, source: o.sourceId, method: o.method });
      }
    }
  }

  if (byField.skill) {
    const agg = new Map();
    for (const o of byField.skill) {
      const c = canonicalizeSkill(o.value);
      if (!c) continue;
      if (!agg.has(c.name)) agg.set(c.name, { known: c.known, weights: [], sources: new Set(), methods: new Set() });
      const a = agg.get(c.name);
      a.weights.push(o.weight);
      a.sources.add(o.sourceType);
      a.methods.add(o.method);
    }
    record.skills = [...agg.entries()]
      .map(([name, a]) => ({
        name,
        confidence: skillConfidence(a.weights, a.known),
        sources: [...a.sources].sort(),
      }))
      .sort((x, y) => y.confidence - x.confidence || x.name.localeCompare(y.name));
    for (const sk of record.skills) {
      provenance.push({ field: `skills.${sk.name}`, source: sk.sources.join('+'), method: 'aggregated' });
    }
    if (record.skills.length) {
      fieldConf.skills = round(record.skills.reduce((s, x) => s + x.confidence, 0) / record.skills.length);
    }
  }

  if (byField.experience_entry) {
    const rows = [];
    for (const o of byField.experience_entry) {
      const v = o.value || {};
      const row = {
        company: N.normalizeName(v.company),
        title: v.title ? clampStr(v.title, 120) : null,
        start: N.normalizeDate(v.start),
        end: N.normalizeDate(v.end),
        summary: v.summary ? clampStr(v.summary, 400) : null,
        _src: o.sourceId,
        _method: o.method,
        _weight: o.weight,
      };
      if (row.company || row.title) rows.push(row);
    }
    record.experience = dedupeExperience(rows);
    record.experience.forEach((e) => provenance.push({ field: `experience@${e.company || e.title}`, source: e.__src, method: e.__method }));
    record.experience = record.experience.map(({ __src, __method, __weight, ...rest }) => rest);
    if (record.experience.length) fieldConf.experience = 0.8;
  }

  if (byField.education_entry) {
    const seen = new Set();
    for (const o of byField.education_entry) {
      const v = o.value || {};
      const row = {
        institution: N.normalizeName(v.institution),
        degree: v.degree ? clampStr(v.degree, 120) : null,
        field: v.field ? clampStr(v.field, 120) : null,
        end_year: N.normalizeYear(v.end_year),
      };
      if (!row.institution && !row.degree) continue;
      const key = `${(row.institution || '').toLowerCase()}|${(row.degree || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      record.education.push(row);
      provenance.push({ field: `education@${row.institution || row.degree}`, source: o.sourceId, method: o.method });
    }
    if (record.education.length) fieldConf.education = 0.8;
  }

  record.candidate_id = makeId(record);
  record.overall_confidence = overallConfidence(record, fieldConf);
  Object.defineProperty(record, '__fieldConfidence', { value: fieldConf, enumerable: false });
  return record;
}

function resolveScalar(field, obsList, normFn, record, provenance, fieldConf, group) {
  if (!obsList) return;
  const cands = obsList.map((o) => ({ ...o, norm: normFn(o.value) })).filter((o) => o.norm != null);
  if (!cands.length) return;
  const winner = pickWinner(cands);
  record[field] = winner.norm;
  const agreeing = cands.filter((c) => eq(c.norm, winner.norm));
  fieldConf[field] = confidenceFor(winner, agreeing);
  provenance.push({ field, source: winner.sourceId, method: winner.method });
}

function resolveList(field, obsList, normFn, record, provenance, fieldConf) {
  if (!obsList) return;
  const map = new Map();
  for (const o of obsList) {
    const v = normFn(o.value);
    if (!v) continue;
    if (!map.has(v) || map.get(v).weight < o.weight) map.set(v, o);
  }
  if (!map.size) return;
  record[field] = [...map.keys()];
  for (const [val, o] of map) provenance.push({ field: `${field}[${val}]`, source: o.sourceId, method: o.method });
  const confs = [...map.values()].map((o) => scalarConfidence(o.weight, []));
  fieldConf[field] = Math.max(...confs);
}

function pickWinner(cands) {
  const counts = new Map();
  for (const c of cands) counts.set(key(c.norm), (counts.get(key(c.norm)) || 0) + c.weight);
  return [...cands].sort((a, b) => {
    const w = b.weight - a.weight;
    if (w !== 0) return w;
    const ag = (counts.get(key(b.norm)) || 0) - (counts.get(key(a.norm)) || 0);
    if (ag !== 0) return ag;
    return String(a.sourceId).localeCompare(String(b.sourceId));
  })[0];
}

function confidenceFor(winner, agreeing) {
  const others = agreeing.filter((c) => c.sourceId !== winner.sourceId).map((c) => c.weight);
  return scalarConfidence(winner.weight, others);
}

function dedupeExperience(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${(r.company || '').toLowerCase()}|${(r.title || '').toLowerCase()}`;
    if (!byKey.has(k)) {
      byKey.set(k, { ...r, __src: r._src, __method: r._method, __weight: r._weight || 0 });
    } else {
      const ex = byKey.get(k);
      ex.start = ex.start || r.start;
      ex.end = ex.end || r.end;
      ex.summary = ex.summary || r.summary;
      if ((r._weight || 0) > (ex.__weight || 0)) { ex.__src = r._src; ex.__method = r._method; ex.__weight = r._weight; }
    }
  }
  let merged = [...byKey.values()];

  // collapse stints
  const byCompany = new Map();
  for (const r of merged) {
    const c = (r.company || '').toLowerCase();
    if (!byCompany.has(c)) byCompany.set(c, []);
    byCompany.get(c).push(r);
  }
  const clustered = [];
  for (const [, group] of byCompany) {
    group.sort((a, b) =>
      (b.__weight || 0) - (a.__weight || 0) ||
      datedness(b) - datedness(a) ||
      String(a.title || '').localeCompare(String(b.title || '')));
    const clusters = [];
    for (const r of group) {
      const hit = clusters.find((cl) => sameStint(cl, r));
      if (hit) {
        hit.start = hit.start || r.start;
        hit.end = hit.end || r.end;
        hit.summary = hit.summary || r.summary;
        if (!hit.title && r.title) hit.title = r.title;
      } else {
        clusters.push({ ...r });
      }
    }
    clustered.push(...clusters);
  }

  const companiesWithTitle = new Set(
    clustered.filter((r) => r.title).map((r) => (r.company || '').toLowerCase())
  );
  const out = clustered.filter((r) => {
    if (!r.title && r.company && companiesWithTitle.has(r.company.toLowerCase())) return false;
    return r.company || r.title;
  });

  return out
    .map((r) => { const { _src, _method, _weight, ...rest } = r; return rest; })
    .sort((a, b) => String(b.end || '9999').localeCompare(String(a.end || '9999')));
}

function datedness(r) { return (r.start ? 1 : 0) + (r.end ? 1 : 0); }

function sameStint(a, b) {
  const aUndated = !a.start && !a.end;
  const bUndated = !b.start && !b.end;
  if (aUndated || bUndated) return true;
  const as = a.start || '0000-00', ae = a.end || '9999-99';
  const bs = b.start || '0000-00', be = b.end || '9999-99';
  return as <= be && bs <= ae;
}

function makeId(record) {
  const seed =
    (record.emails[0]) ||
    (record.phones[0]) ||
    (record.full_name ? record.full_name.toLowerCase() + '|' + (record.links.github || '') : null) ||
    contentSeed(record);
  const hash = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 12);
  return `cand_${hash}`;
}

function contentSeed(record) {
  return JSON.stringify({
    links: record.links,
    headline: record.headline,
    skills: record.skills.map((s) => s.name),
    experience: record.experience.map((e) => [e.company, e.title, e.start, e.end]),
    education: record.education.map((e) => [e.institution, e.degree]),
  });
}

function addIndex(map, k, i) { if (!map.has(k)) map.set(k, []); map.get(k).push(i); }
function normName(n) { const v = N.normalizeName(n); return v ? v.toLowerCase().replace(/[^a-z ]/g, '').trim() : null; }
function groupBy(arr, fn) { const m = {}; for (const x of arr) { const k = fn(x); (m[k] = m[k] || []).push(x); } return m; }
function eq(a, b) { return key(a) === key(b); }
function key(v) { return typeof v === 'object' ? JSON.stringify(v) : String(v); }
function clampStr(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; }
function toYears(v) { const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n >= 0 && n <= 60 ? n : null; }
function completeness(loc) { return (loc.city ? 1 : 0) + (loc.region ? 1 : 0) + (loc.country ? 1 : 0); }
function sameLoc(a, b) { return a.city === b.city && a.country === b.country; }
function round(x) { return Math.round(x * 100) / 100; }

module.exports = { mergeAll, resolveEntities, buildRecord };
