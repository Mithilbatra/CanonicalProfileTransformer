'use strict';

// Minimal structured logger. Emits one JSON line per event so logs are
// grep-able and aggregator-friendly in production, with a compact readable
// line in dev. Optional error monitoring: if SENTRY_DSN is set and
// @sentry/node is installed, captured errors are also forwarded to Sentry —
// lazy-loaded (like nodemailer in the mailer), so it stays zero-config by
// default and adds no hard dependency.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;
const isProd = process.env.NODE_ENV === 'production';

let _sentry = null;
let _sentryTried = false;
function sentry() {
  if (_sentryTried) return _sentry;
  _sentryTried = true;
  if (!process.env.SENTRY_DSN) return null;
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
    _sentry = Sentry;
  } catch {
    process.stderr.write('[logger] SENTRY_DSN is set but @sentry/node is not installed; error monitoring disabled\n');
    _sentry = null;
  }
  return _sentry;
}

function format(level, msg, fields = {}) {
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  if (isProd) return JSON.stringify(rec);
  const extra = Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
    : '';
  return `[${level}] ${msg}${extra}`;
}

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < MIN) return;
  if (process.env.SILENCE_LOGS === '1') return;
  const line = format(level, msg, fields);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

const logger = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),

  // Report an exception to logs (+ Sentry when configured). Never throws.
  captureError(err, fields = {}) {
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : undefined;
    emit('error', message, { ...fields, stack });
    const s = sentry();
    if (s) { try { s.captureException(err, { extra: fields }); } catch { /* monitoring must never break the app */ } }
  },

  format, // exported for tests
};

module.exports = logger;
