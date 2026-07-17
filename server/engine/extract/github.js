'use strict';

const { obs, subject } = require('./_common');
const { fetchJson } = require('../../lib/fetcher');

function extractGithub(data, sourceId = 'github') {
  if (!data || typeof data !== 'object') {
    return { sourceId, sourceType: 'github', ok: false, error: 'empty source', subjects: [] };
  }
  const user = data.user || data;
  const repos = Array.isArray(data.repos) ? data.repos : [];
  const languages = data.languages && typeof data.languages === 'object' ? data.languages : null;

  if (!user.login && !user.name) {
    return { sourceId, sourceType: 'github', ok: false, error: 'no profile', subjects: [] };
  }

  const observations = [];
  if (user.name) observations.push(obs('full_name', user.name, 'github:name'));
  if (user.email) observations.push(obs('email', user.email, 'github:public_email'));
  if (user.bio) observations.push(obs('headline', user.bio, 'github:bio'));
  if (user.location) observations.push(obs('location', user.location, 'github:location'));
  if (user.html_url) observations.push(obs('link', user.html_url, 'github:profile_url'));
  if (user.blog) observations.push(obs('link', user.blog, 'github:blog'));

  if (languages) {
    Object.keys(languages).forEach((lang) => {
      observations.push(obs('skill', lang, 'github:repo_languages'));
    });
  } else {
    const seen = new Set();
    repos.forEach((r) => {
      if (r && r.language && !seen.has(r.language)) {
        seen.add(r.language);
        observations.push(obs('skill', r.language, 'github:repo_language'));
      }
    });
  }

  return {
    sourceId,
    sourceType: 'github',
    ok: true,
    error: null,
    subjects: observations.length ? [subject(sourceId, 'github', observations)] : [],
  };
}

async function fetchGithub(usernameOrUrl) {
  const username = String(usernameOrUrl)
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  if (!username) throw new Error('could not parse github username');

  const headers = { 'User-Agent': 'profile-transformer', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  // fetchJson adds timeout, retry-with-backoff and a short TTL cache,
  // so repeated runs against the same handle don't hang or burn rate limits.
  const user = await fetchJson(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers });

  let repos = [];
  try {
    repos = await fetchJson(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`,
      { headers }
    );
    if (!Array.isArray(repos)) repos = [];
  } catch (_) {
    /* best-effort */
  }

  const languages = {};
  for (const r of repos.slice(0, 15)) {
    if (r && r.language) languages[r.language] = (languages[r.language] || 0) + 1;
  }
  return { user, repos, languages };
}

module.exports = { extractGithub, fetchGithub };
