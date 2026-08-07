#!/usr/bin/env node
'use strict';

// Runs the labeled benchmark (benchmark/dataset.js) through the real engine and
// reports per-case and overall accuracy. Usage:
//
//   npm run benchmark            # print the report
//   node benchmark/run.js --json # machine-readable summary
//
// Accuracy = fraction of individual checks that pass, averaged per case then
// across cases (so a big case doesn't dominate a small one). scoreDataset() is
// also imported by test/benchmark.test.js to fail CI on a regression.

const { extractSources } = require('../server/engine/pipeline');
const { mergeAll } = require('../server/engine/merge');
const dataset = require('./dataset');

async function scoreCase(testCase) {
  const { sourceResults } = await extractSources(testCase.sources, {});
  const records = mergeAll(sourceResults);
  const checks = testCase.expect(records).map(([label, pass]) => ({ label, pass: !!pass }));
  const passed = checks.filter((c) => c.pass).length;
  return { name: testCase.name, checks, passed, total: checks.length, score: checks.length ? passed / checks.length : 1 };
}

async function scoreDataset() {
  const cases = [];
  for (const c of dataset) cases.push(await scoreCase(c));
  const overall = cases.length ? cases.reduce((s, c) => s + c.score, 0) / cases.length : 1;
  const totalChecks = cases.reduce((s, c) => s + c.total, 0);
  const passedChecks = cases.reduce((s, c) => s + c.passed, 0);
  return { cases, overall, totalChecks, passedChecks };
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const json = process.argv.includes('--json');
  const result = await scoreDataset();

  if (json) {
    console.log(JSON.stringify({ overall: result.overall, passedChecks: result.passedChecks, totalChecks: result.totalChecks }, null, 2));
    return;
  }

  console.log('\n  Extraction & entity-resolution benchmark\n  ' + '─'.repeat(52));
  for (const c of result.cases) {
    const bar = c.score === 1 ? '✓' : c.score >= 0.5 ? '~' : '✗';
    console.log(`\n  ${bar} ${c.name}  —  ${c.passed}/${c.total} (${pct(c.score)})`);
    for (const check of c.checks) {
      if (!check.pass) console.log(`      ✗ ${check.label}`);
    }
  }
  console.log('\n  ' + '─'.repeat(52));
  console.log(`  Overall accuracy: ${pct(result.overall)}   (${result.passedChecks}/${result.totalChecks} checks)\n`);

  if (result.overall < 1) process.exitCode = 0; // reporting tool: never fail the shell; the test enforces the gate
}

if (require.main === module) main();

module.exports = { scoreDataset };
