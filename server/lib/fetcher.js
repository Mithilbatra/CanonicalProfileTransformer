'use strict';

// Hardened HTTP fetch for the live source integrations (GitHub).
// Adds what plain fetch() lacks for production use:
//   - a hard timeout so one slow host cannot hang a whole pipeline run
//   - retry with backoff on transient failures (network errors, 5xx, 429)
//   - a small in-memory TTL cache so repeated runs against the same profile
//     do not burn through unauthenticated API rate limits
//   - a minimum gap between outbound requests (crude rate limiting)

const DEFAULTS = {
  timeoutMs: 8000,
  retries: 2,
  backoffMs: 500,
  cacheTtlMs: 5 * 60 * 1000,
  minGapMs: 250,
};

const cache = new Map(); // url -> { expires, body }
let lastRequestAt = 0;

async function fetchJson(url, { headers = {}, ...overrides } = {}) {
  const opts = { ...DEFAULTS, ...overrides };

  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.body;

  let lastError;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(opts.backoffMs * attempt);

    // keep a minimum gap between outbound requests
    const wait = lastRequestAt + opts.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`fetch ${url} -> ${res.status}`);
        continue; // transient — retry
      }
      if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`); // 4xx — no point retrying
      const body = await res.json();
      cache.set(url, { expires: Date.now() + opts.cacheTtlMs, body });
      return body;
    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = new Error(`fetch ${url} timed out after ${opts.timeoutMs}ms`);
        continue;
      }
      if (err.message && err.message.includes('-> 4')) throw err;
      lastError = err; // network-level error — retry
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`fetch ${url} failed`);
}

function clearCache() {
  cache.clear();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { fetchJson, clearCache };
