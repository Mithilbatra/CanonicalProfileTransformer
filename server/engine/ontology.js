'use strict';

// A small, deterministic skill ontology: "knowing X implies knowing Y".
// Using React means you know JavaScript; using PyTorch means you do ML. This
// lets JD matching credit a candidate for a required skill they demonstrate
// through a more specific one — the explainable alternative to embeddings.
// Every edge here is a near-certain implication a human would agree with; we
// deliberately avoid loose "related to" links that would let the score drift.

const IMPLIES = {
  // JS ecosystem
  TypeScript: ['JavaScript'],
  'Node.js': ['JavaScript'],
  React: ['JavaScript'],
  'Vue.js': ['JavaScript'],
  Angular: ['TypeScript', 'JavaScript'],
  'Next.js': ['React', 'JavaScript'],
  Express: ['Node.js', 'JavaScript'],
  'Tailwind CSS': ['CSS'],
  // Python ecosystem
  Django: ['Python'],
  Flask: ['Python'],
  PyTorch: ['Python', 'Machine Learning'],
  TensorFlow: ['Python', 'Machine Learning'],
  'Deep Learning': ['Machine Learning'],
  // JVM
  'Spring Boot': ['Java'],
  // data stores
  PostgreSQL: ['SQL'],
  MySQL: ['SQL'],
  // infra
  Kubernetes: ['Docker'],
};

// Transitive closure of everything `skill` implies (not including itself).
// Next.js -> React -> JavaScript, so expandSkill('Next.js') includes JavaScript.
const impliedCache = new Map();
function impliedSkills(skill) {
  if (impliedCache.has(skill)) return impliedCache.get(skill);
  const out = new Set();
  const stack = [...(IMPLIES[skill] || [])];
  while (stack.length) {
    const s = stack.pop();
    if (out.has(s)) continue;
    out.add(s);
    for (const next of IMPLIES[s] || []) stack.push(next);
  }
  impliedCache.set(skill, out);
  return out;
}

// Does the candidate cover a required skill, directly or by implication?
// Returns { via, direct } where `via` is the candidate skill that satisfied
// it (equal to the requirement when direct), or null if uncovered.
// `candidateSkillNames` is an array of the candidate's skill names.
function coverage(reqSkill, candidateSkillNames) {
  const have = new Set(candidateSkillNames);
  if (have.has(reqSkill)) return { via: reqSkill, direct: true };
  // find a candidate skill whose implications include the requirement;
  // prefer a stable, deterministic pick (alphabetical) when several qualify
  const satisfiers = candidateSkillNames
    .filter((name) => impliedSkills(name).has(reqSkill))
    .sort();
  return satisfiers.length ? { via: satisfiers[0], direct: false } : null;
}

module.exports = { impliedSkills, coverage, IMPLIES };
