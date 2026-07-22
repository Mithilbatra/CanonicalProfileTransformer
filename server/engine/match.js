'use strict';

const { CANON } = require('./skills');
const { coverage } = require('./ontology');

// Job-description matching: read requirements out of free JD text, score
// every stored candidate against them, and — in keeping with the rest of the
// engine — explain every point of the score. No embeddings, no black box: a
// recruiter can check each number against the resume.
//
// Score components (renormalized over whichever are present in the JD):
//   skills  0.70  mean coverage of required skills, weighted by confidence
//   years   0.15  candidate years / required years, capped at 1
//   title   0.15  overlap between JD role words and candidate headline/titles
//
// A required skill is "covered" directly, or through the ontology by a more
// specific skill (React covers a JavaScript requirement) at a discount, so the
// score rewards demonstrated ability without inventing it.
//
// Bias-blind mode redacts identity (name, location) from the ranked results so
// screening happens on merit; none of those fields feed the score anyway, and
// this makes that guarantee visible and auditable.

const IMPLIED_DISCOUNT = 0.8;

const ROLE_WORDS = [
  'engineer', 'developer', 'designer', 'manager', 'analyst', 'scientist',
  'architect', 'consultant', 'lead', 'intern', 'senior', 'junior', 'staff',
  'principal', 'frontend', 'backend', 'fullstack', 'full-stack', 'devops', 'data',
];

// Weight of a "nice to have" skill relative to a required one in the score.
const NICE_WEIGHT = 0.4;
// Skills mentioned at or after one of these markers are treated as preferred
// rather than required, so missing them costs far less.
const PREFERRED_MARKER = /nice[-\s]to[-\s]haves?|preferred|bonus|good[-\s]to[-\s]have|desirable|a plus|pluses/i;

function extractRequirements(jdText) {
  const text = String(jdText || '');
  const lower = text.toLowerCase();
  const markerMatch = lower.match(PREFERRED_MARKER);
  const markerAt = markerMatch ? markerMatch.index : Infinity;

  const required = [];
  const niceToHave = [];
  for (const [canon, aliases] of Object.entries(CANON)) {
    let firstAt = Infinity;
    for (const alias of [canon.toLowerCase(), ...aliases]) {
      const re = new RegExp(`(?:^|[^a-z0-9+#.])${escapeRe(alias)}(?:$|[^a-z0-9+#.]|\\.(?=\\s|$))`, 'i');
      const m = lower.match(re);
      if (m) { firstAt = Math.min(firstAt, m.index); }
    }
    if (firstAt === Infinity) continue;
    (firstAt >= markerAt ? niceToHave : required).push(canon);
  }

  const yearsMatch = lower.match(/(\d{1,2})\s*\+?\s*years?/);
  const minYears = yearsMatch ? parseInt(yearsMatch[1], 10) : null;
  const titleWords = ROLE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower));

  // `skills` stays as the full requested set (kept for callers/audit); the
  // required/niceToHave split is what the score actually weighs.
  return {
    skills: [...required, ...niceToHave].sort(),
    required: required.sort(),
    niceToHave: niceToHave.sort(),
    minYears,
    titleWords,
  };
}

// Total years actually spent employed, merged across overlapping roles, used
// as an honest fallback when years_experience wasn't stated on the resume.
function estimateTenureYears(experience = []) {
  const now = new Date();
  const nowM = now.getFullYear() * 12 + now.getMonth() + 1;
  const intervals = [];
  for (const e of experience) {
    const s = toMonths(e.start);
    if (s == null) continue;
    const end = toMonths(e.end) ?? nowM;
    if (end >= s) intervals.push([s, Math.min(end, nowM)]);
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curS, curE] = intervals[0];
  for (const [s, e] of intervals.slice(1)) {
    if (s <= curE) curE = Math.max(curE, e);
    else { months += curE - curS; curS = s; curE = e; }
  }
  months += curE - curS;
  return Math.max(0, Math.round(months / 12));
}

function toMonths(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? parseInt(m[1], 10) * 12 + parseInt(m[2], 10) : null;
}

function scoreCandidate(record, requirements) {
  const parts = [];

  // support both the new required/niceToHave split and a bare skills list
  const required = requirements.required || requirements.skills || [];
  const niceToHave = requirements.niceToHave || [];

  const bySkill = new Map(record.skills.map((s) => [s.name, s]));
  const skillNames = record.skills.map((s) => s.name);
  const matched = [];
  const missing = [];        // names only (strings), required-first
  const missingRequired = []; // subset that were required

  const assess = (req, isRequired) => {
    const cov = coverage(req, skillNames);
    if (!cov) {
      missing.push(req);
      if (isRequired) missingRequired.push(req);
      return { weight: isRequired ? 1 : NICE_WEIGHT, confidence: 0 };
    }
    const src = bySkill.get(cov.via);
    const confidence = round((src ? src.confidence : 0) * (cov.direct ? 1 : IMPLIED_DISCOUNT));
    matched.push({ name: req, required: isRequired, via: cov.direct ? null : cov.via, confidence, sources: src ? src.sources : [] });
    return { weight: isRequired ? 1 : NICE_WEIGHT, confidence };
  };

  const contribs = [
    ...required.map((r) => assess(r, true)),
    ...niceToHave.map((r) => assess(r, false)),
  ];

  if (contribs.length) {
    const wSum = contribs.reduce((s, c) => s + c.weight, 0);
    const skillScore = wSum ? contribs.reduce((s, c) => s + c.weight * c.confidence, 0) / wSum : 0;
    const viaCount = matched.filter((m) => m.via).length;
    const reqCovered = matched.filter((m) => m.required).length;
    parts.push({
      component: 'skills',
      weight: 0.7,
      score: round(skillScore),
      detail:
        `${reqCovered}/${required.length} required` +
        (niceToHave.length ? ` + ${matched.filter((m) => !m.required).length}/${niceToHave.length} preferred` : '') +
        ` skills covered` +
        (viaCount ? ` (${viaCount} via a related skill)` : ''),
    });
  }

  if (requirements.minYears != null) {
    const stated = record.years_experience;
    const estimated = stated == null ? estimateTenureYears(record.experience) : null;
    const years = stated != null ? stated : estimated;
    const yearsScore = years == null ? 0 : Math.min(1, years / requirements.minYears);
    parts.push({
      component: 'years',
      weight: 0.15,
      score: round(yearsScore),
      detail:
        stated != null
          ? `JD asks ${requirements.minYears}+ years; candidate has ${stated}`
          : estimated != null
            ? `JD asks ${requirements.minYears}+ years; ~${estimated} estimated from work history`
            : `JD asks ${requirements.minYears}+ years; candidate's years unknown (scored 0 — honestly-empty, not guessed)`,
    });
  }

  if (requirements.titleWords.length) {
    const haystack = [record.headline || '', ...record.experience.map((e) => e.title || '')]
      .join(' ')
      .toLowerCase();
    const hits = requirements.titleWords.filter((w) => haystack.includes(w));
    parts.push({
      component: 'title',
      weight: 0.15,
      score: round(hits.length / requirements.titleWords.length),
      detail: `role words matched: ${hits.join(', ') || 'none'}`,
    });
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = totalWeight ? round(parts.reduce((s, p) => s + p.weight * p.score, 0) / totalWeight) : 0;

  return { score, matched, missing, missingRequired, parts };
}

// Stable, non-identifying label for blind review, derived from the id.
function aliasFor(candidateId) {
  const tail = String(candidateId).replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
  return `Candidate ${tail || '????'}`;
}

function matchCandidates(jdText, candidates, { blind = false } = {}) {
  const requirements = extractRequirements(jdText);
  const results = candidates
    .map((c) => {
      const scored = scoreCandidate(c.record, requirements);
      if (blind) {
        return {
          candidate_id: c.candidate_id,
          alias: aliasFor(c.candidate_id),
          full_name: null,
          headline: c.record.headline,
          location: null,
          redacted: ['full_name', 'location'],
          ...scored,
        };
      }
      return {
        candidate_id: c.candidate_id,
        full_name: c.record.full_name,
        headline: c.record.headline,
        overall_confidence: c.record.overall_confidence,
        ...scored,
      };
    })
    .sort((a, b) => b.score - a.score || String(a.candidate_id).localeCompare(b.candidate_id));
  return { requirements, blind, results };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function round(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { matchCandidates, extractRequirements, scoreCandidate, aliasFor, estimateTenureYears };
