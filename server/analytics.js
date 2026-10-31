'use strict';

const store = require('./store');
const { db } = require('./db');

// Screening analytics for one organization: a plain-numbers dashboard a
// recruiter (or a compliance reviewer) can read at a glance. Everything here
// is derived from data we already hold — no protected attributes are collected
// or inferred, which is the point: fairness comes from the bias-blind control,
// and these figures describe the funnel and data quality, not the people.

function insights(orgId) {
  const candidates = store.listCandidates(orgId);
  const total = candidates.length;

  // funnel by pipeline stage, in canonical order
  const stageCounts = Object.fromEntries(store.STAGES.map((s) => [s, 0]));
  for (const c of candidates) stageCounts[c.meta.stage] = (stageCounts[c.meta.stage] || 0) + 1;
  const funnel = store.STAGES.map((stage) => ({ stage, count: stageCounts[stage] }));

  // confidence distribution in five bands
  const bands = [
    { label: '0.0–0.2', min: 0.0, max: 0.2, count: 0 },
    { label: '0.2–0.4', min: 0.2, max: 0.4, count: 0 },
    { label: '0.4–0.6', min: 0.4, max: 0.6, count: 0 },
    { label: '0.6–0.8', min: 0.6, max: 0.8, count: 0 },
    { label: '0.8–1.0', min: 0.8, max: 1.01, count: 0 },
  ];
  let confSum = 0;
  for (const c of candidates) {
    const v = c.record.overall_confidence;
    confSum += v;
    const band = bands.find((b) => v >= b.min && v < b.max);
    if (band) band.count++;
  }
  const avgConfidence = total ? round(confSum / total) : 0;

  // most common skills across the pool (supply)
  const skillCounts = new Map();
  for (const c of candidates) {
    for (const s of c.record.skills) skillCounts.set(s.name, (skillCounts.get(s.name) || 0) + 1);
  }
  const topSkills = [...skillCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 12);

  // where the data came from: clean source types (csv, ats, github, resume,
  // …) read from the subjects behind each candidate — one tally per candidate
  // per distinct source type that fed it.
  const sourceMix = db.prepare(
    `SELECT s.source_type AS type, COUNT(DISTINCT cs.candidate_id) AS count
     FROM candidate_subjects cs JOIN subjects s ON s.org_id = cs.org_id AND s.id = cs.subject_id
     WHERE cs.org_id = ? GROUP BY s.source_type ORDER BY count DESC, type`
  ).all(orgId);

  // activity: how many matches were run, and how many of them bias-blind
  const matchRows = db
    .prepare("SELECT detail FROM audit WHERE org_id = ? AND action = 'candidates.match'")
    .all(orgId);
  let blindMatches = 0;
  for (const row of matchRows) {
    try { if (JSON.parse(row.detail || '{}').blind) blindMatches++; } catch { /* ignore */ }
  }

  return {
    total,
    avgConfidence,
    funnel,
    confidenceBands: bands.map(({ label, count }) => ({ label, count })),
    topSkills,
    sourceMix,
    activity: { matches: matchRows.length, blindMatches },
  };
}

function round(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { insights };
