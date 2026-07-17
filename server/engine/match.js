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

function extractRequirements(jdText) {
  const text = String(jdText || '');
  const lower = text.toLowerCase();

  const skills = [];
  for (const [canon, aliases] of Object.entries(CANON)) {
    for (const alias of [canon.toLowerCase(), ...aliases]) {
      const re = new RegExp(`(?:^|[^a-z0-9+#.])${escapeRe(alias)}(?:$|[^a-z0-9+#.]|\\.(?=\\s|$))`, 'i');
      if (re.test(lower)) {
        skills.push(canon);
        break;
      }
    }
  }

  const yearsMatch = lower.match(/(\d{1,2})\s*\+?\s*years?/);
  const minYears = yearsMatch ? parseInt(yearsMatch[1], 10) : null;

  const titleWords = ROLE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower));

  return { skills: skills.sort(), minYears, titleWords };
}

function scoreCandidate(record, requirements) {
  const parts = [];

  const bySkill = new Map(record.skills.map((s) => [s.name, s]));
  const skillNames = record.skills.map((s) => s.name);
  const matched = [];
  const missing = [];

  for (const req of requirements.skills) {
    const cov = coverage(req, skillNames);
    if (!cov) {
      missing.push(req);
      continue;
    }
    const src = bySkill.get(cov.via);
    const confidence = round((src ? src.confidence : 0) * (cov.direct ? 1 : IMPLIED_DISCOUNT));
    matched.push({
      name: req,
      via: cov.direct ? null : cov.via, // the skill that stood in for the requirement
      confidence,
      sources: src ? src.sources : [],
    });
  }

  if (requirements.skills.length) {
    const skillScore = matched.reduce((sum, m) => sum + m.confidence, 0) / requirements.skills.length;
    const viaCount = matched.filter((m) => m.via).length;
    parts.push({
      component: 'skills',
      weight: 0.7,
      score: round(skillScore),
      detail:
        `${matched.length}/${requirements.skills.length} required skills covered, weighted by confidence` +
        (viaCount ? ` (${viaCount} via a related skill)` : ''),
    });
  }

  if (requirements.minYears != null) {
    const years = record.years_experience;
    const yearsScore = years == null ? 0 : Math.min(1, years / requirements.minYears);
    parts.push({
      component: 'years',
      weight: 0.15,
      score: round(yearsScore),
      detail:
        years == null
          ? `JD asks ${requirements.minYears}+ years; candidate's years unknown (scored 0 — honestly-empty, not guessed)`
          : `JD asks ${requirements.minYears}+ years; candidate has ${years}`,
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

  return { score, matched, missing, parts };
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

module.exports = { matchCandidates, extractRequirements, scoreCandidate, aliasFor };
