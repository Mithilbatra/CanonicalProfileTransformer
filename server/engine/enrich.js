'use strict';

const N = require('./normalize');
const { extractGithub, fetchGithub } = require('./extract/github');

// Second-pass enrichment: if the extracted sources mention a GitHub profile
// (typically a hyperlink recovered from a resume PDF), fetch that profile
// live and add it as one more source. The fetched data then flows through
// the normal merge — the shared profile link is a strong key, so it lands on
// the right candidate with github-grade confidence, full provenance, and the
// agreement boost for anything it corroborates.
//
// LinkedIn links are recorded as links but deliberately NOT fetched: there is
// no public API, and scraping violates their terms. Honest gap, not a bug.
//
// Network use is opt-in (allowNetwork), and fetch failures degrade to a
// report entry — an unreachable profile never breaks an upload.

function collectGithubHandles(sourceResults) {
  const handles = new Set();
  for (const sr of sourceResults) {
    if (!sr.ok || sr.sourceType === 'github') continue;
    for (const s of sr.subjects) {
      for (const o of s.observations) {
        if (o.field !== 'link') continue;
        const c = N.classifyLink(o.value);
        if (!c || c.kind !== 'github') continue;
        // profile URLs only ("github.com/user"), not repo links ("user/repo")
        const path = c.url.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
        const segments = path.split('/').filter(Boolean);
        if (segments.length === 1) handles.add(segments[0].toLowerCase());
      }
    }
  }
  return [...handles].sort();
}

async function enrichFromLinks(sourceResults, opts = {}) {
  if (!opts.allowNetwork) return [];

  const alreadyFetched = new Set(
    sourceResults.filter((sr) => sr.sourceType === 'github').map((sr) => sr.sourceId)
  );

  const added = [];
  for (const handle of collectGithubHandles(sourceResults)) {
    const sourceId = `github:${handle}`;
    if (alreadyFetched.has(sourceId)) continue;
    try {
      const data = await fetchGithub(handle);
      added.push(extractGithub(data, sourceId));
    } catch (err) {
      added.push({ sourceId, sourceType: 'github', ok: false, error: `enrichment fetch failed: ${err.message}`, subjects: [] });
    }
  }
  return added;
}

module.exports = { enrichFromLinks, collectGithubHandles };
