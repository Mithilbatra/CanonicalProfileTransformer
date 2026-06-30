'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const N = require('../server/engine/normalize');
const { canonicalizeSkill } = require('../server/engine/skills');

test('phones normalize to E.164 or null (never a mangled string)', () => {
  assert.equal(N.normalizePhone('(415) 555-0132', 'US'), '+14155550132');
  assert.equal(N.normalizePhone('+14155550132'), '+14155550132');
  assert.equal(N.normalizePhone('+44 20 7946 0991'), '+442079460991');
  assert.equal(N.normalizePhone('not a phone'), null);
  assert.equal(N.normalizePhone('12345'), null);
  assert.equal(N.normalizePhone(null), null);
});

test('dates normalize to YYYY-MM across many spellings', () => {
  assert.equal(N.normalizeDate('2021-03'), '2021-03');
  assert.equal(N.normalizeDate('2021/3'), '2021-03');
  assert.equal(N.normalizeDate('03/2021'), '2021-03');
  assert.equal(N.normalizeDate('March 2021'), '2021-03');
  assert.equal(N.normalizeDate('Mar 2021'), '2021-03');
  assert.equal(N.normalizeDate('2021'), '2021-01');
  assert.equal(N.normalizeDate('Present'), null);
  assert.equal(N.normalizeDate('garbage'), null);
});

test('country normalizes to ISO-3166 alpha-2', () => {
  assert.equal(N.normalizeCountry('United States'), 'US');
  assert.equal(N.normalizeCountry('USA'), 'US');
  assert.equal(N.normalizeCountry('India'), 'IN');
  assert.equal(N.normalizeCountry('U.K.'), 'GB');
  assert.equal(N.normalizeCountry('Atlantis'), null);
});

test('location parses city/region/country and infers US from state', () => {
  assert.deepEqual(N.normalizeLocation('San Francisco, CA, USA'), { city: 'San Francisco', region: 'CA', country: 'US' });
  assert.deepEqual(N.normalizeLocation('Austin, TX'), { city: 'Austin', region: 'TX', country: 'US' });
  assert.deepEqual(N.normalizeLocation('Bengaluru, India'), { city: 'Bengaluru', region: null, country: 'IN' });
  assert.equal(N.normalizeLocation(''), null);
});

test('skills canonicalize known aliases and flag unknowns', () => {
  assert.deepEqual(canonicalizeSkill('reactjs'), { name: 'React', known: true });
  assert.deepEqual(canonicalizeSkill('JS'), { name: 'JavaScript', known: true });
  assert.deepEqual(canonicalizeSkill('node'), { name: 'Node.js', known: true });
  assert.equal(canonicalizeSkill('  '), null);
  const unknown = canonicalizeSkill('underwater basket weaving');
  assert.equal(unknown.known, false);
  assert.equal(unknown.name, 'Underwater Basket Weaving');
});

test('links classify and canonicalize', () => {
  assert.deepEqual(N.classifyLink('github.com/jrivera-dev'), { kind: 'github', url: 'https://github.com/jrivera-dev' });
  assert.deepEqual(N.classifyLink('https://www.linkedin.com/in/x/'), { kind: 'linkedin', url: 'https://www.linkedin.com/in/x' });
  assert.equal(N.classifyLink('not a url at all !!'), null);
});
