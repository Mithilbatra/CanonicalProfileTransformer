'use strict';

const { db } = require('./db');

// Append-only activity trail. Every mutating or sensitive action (upload,
// edit, delete, export, match) records who did it, to which candidate, and
// when — the accountability layer a tool handling hiring PII needs.
//
// Recording must never break the action it describes, so failures are
// swallowed (and surfaced to the server log) rather than thrown.

function record(orgId, userEmail, action, target, detail) {
  try {
    db.prepare('INSERT INTO audit (org_id, user_email, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, userEmail || null, action, target || null, detail != null ? JSON.stringify(detail) : null);
  } catch (err) {
    console.error('audit record failed:', err.message);
  }
}

function list(orgId, { limit = 200, action } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const rows = action
    ? db.prepare('SELECT * FROM audit WHERE org_id = ? AND action = ? ORDER BY id DESC LIMIT ?').all(orgId, action, lim)
    : db.prepare('SELECT * FROM audit WHERE org_id = ? ORDER BY id DESC LIMIT ?').all(orgId, lim);
  return rows.map((r) => ({
    id: r.id,
    user_email: r.user_email,
    action: r.action,
    target: r.target,
    detail: r.detail ? JSON.parse(r.detail) : null,
    created_at: r.created_at,
  }));
}

module.exports = { record, list };
