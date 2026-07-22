'use strict';

// Tiny in-memory rate limiter for sensitive endpoints (login/register). Not a
// distributed solution — it's a per-process guard against credential-stuffing
// and signup spam, keyed by client IP. Buckets are swept lazily so memory
// stays bounded without a timer.

function rateLimit({ windowMs = 60_000, max = 10, message = 'too many requests, slow down' } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  return function limiter(req, res, next) {
    // tests and internal calls opt out
    if (process.env.DISABLE_RATE_LIMIT === '1') return next();

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = hits.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(ip, bucket);
    }
    bucket.count++;

    if (hits.size > 5000) sweep(hits, now); // keep the map from growing unbounded

    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

function sweep(hits, now) {
  for (const [ip, b] of hits) if (b.resetAt <= now) hits.delete(ip);
}

module.exports = { rateLimit };
