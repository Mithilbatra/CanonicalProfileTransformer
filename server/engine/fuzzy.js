'use strict';

// Fuzzy string matching for entity resolution.
// Jaro-Winkler gives a 0..1 similarity that is forgiving of typos and
// small spelling drift ("Jordan Rivera" vs "Jordn Rivera"), and the
// name-aware wrapper below handles token order and middle names/initials
// ("Jordan A. Rivera" vs "Rivera, Jordan").

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const matchWindow = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const aMatched = new Array(la).fill(false);
  const bMatched = new Array(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(lb - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;

  // count transpositions among matched characters
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

function jaroWinkler(a, b) {
  const j = jaro(a, b);
  // Winkler boost: common prefix (up to 4 chars) pulls similar strings closer.
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

function nameTokens(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Similarity between two person names, 0..1.
// Compares first+last tokens so "Jordan A. Rivera" ~ "Rivera, Jordan" ~ "Jordan Rivera".
function nameSimilarity(nameA, nameB) {
  const ta = nameTokens(nameA);
  const tb = nameTokens(nameB);
  if (!ta.length || !tb.length) return 0;

  // For each token in the shorter name, find its best match in the other name.
  // Single-letter tokens (initials) match a token starting with that letter.
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set();
  let total = 0;
  for (const tok of short) {
    let best = 0, bestIdx = -1;
    long.forEach((other, i) => {
      if (used.has(i)) return;
      const score =
        tok.length === 1 || other.length === 1
          ? (tok[0] === other[0] ? 0.9 : 0)
          : jaroWinkler(tok, other);
      if (score > best) { best = score; bestIdx = i; }
    });
    if (bestIdx >= 0) used.add(bestIdx);
    total += best;
  }
  return total / short.length;
}

module.exports = { jaroWinkler, nameSimilarity };
