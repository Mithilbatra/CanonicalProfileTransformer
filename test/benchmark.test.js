'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scoreDataset } = require('../benchmark/run');

// Quality gate: engine accuracy on the labeled benchmark must not regress
// below this floor. The current baseline is 100% (20/20 checks); the floor is
// set a little lower so unrelated noise doesn't fail CI, but a real drop in
// extraction or entity-resolution quality will. Raise the floor as the engine
// improves; run `npm run benchmark` for the per-check breakdown.
const ACCURACY_FLOOR = 0.9;

test('engine benchmark: extraction + entity resolution stays accurate', async () => {
  const result = await scoreDataset();
  assert.ok(
    result.overall >= ACCURACY_FLOOR,
    `benchmark accuracy ${(result.overall * 100).toFixed(1)}% fell below the ${(ACCURACY_FLOOR * 100)}% floor ` +
      `(${result.passedChecks}/${result.totalChecks} checks) — run "npm run benchmark" to see which checks failed`
  );
});
