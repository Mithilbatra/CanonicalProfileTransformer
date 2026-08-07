'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Single SQLite database for everything the app persists.
// DB_PATH can point tests at a throwaway file (or ':memory:').
//
// Multi-tenant: every row of candidate data (subjects, candidates, overrides,
// views, audit) is scoped by org_id, and the store filters every query by it,
// so one organization can never see or merge with another's data.

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const SCHEMA_VERSION = 2;

if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// A v1 database predates multi-tenancy: it has `users` but no `orgs`. Its
// candidate data must be adopted into a default organization. Derived tables
// (candidates, subject_keys) are dropped and rebuilt from subjects; tables
// that hold real data (subjects, overrides, views, users) are migrated in
// place, gaining an org_id.
const isLegacy = tableExists('users') && !tableExists('orgs');
if (isLegacy) {
  db.exec('DROP TABLE IF EXISTS candidates; DROP TABLE IF EXISTS subject_keys;');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    org_id        INTEGER NOT NULL REFERENCES orgs(id),
    role          TEXT NOT NULL DEFAULT 'recruiter',   -- admin | recruiter | viewer
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Raw extracted subjects (one person-shaped blob per source occurrence).
  CREATE TABLE IF NOT EXISTS subjects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL REFERENCES orgs(id),
    source_id   TEXT NOT NULL,
    source_type TEXT NOT NULL,
    subject     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Materialized canonical records, rebuilt from subjects after each change.
  CREATE TABLE IF NOT EXISTS candidates (
    org_id           INTEGER NOT NULL REFERENCES orgs(id),
    candidate_id     TEXT NOT NULL,
    record           TEXT NOT NULL,
    field_confidence TEXT NOT NULL,
    subject_ids      TEXT NOT NULL,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, candidate_id)
  );

  -- Identity index over subjects, scoped by org so a shared key (e.g. the same
  -- email in two orgs) can never bridge a merge across tenants.
  CREATE TABLE IF NOT EXISTS subject_keys (
    org_id     INTEGER NOT NULL,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    key        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subject_keys_key ON subject_keys(org_id, key);
  CREATE INDEX IF NOT EXISTS idx_subject_keys_sid ON subject_keys(subject_id);

  CREATE TABLE IF NOT EXISTS views (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL REFERENCES orgs(id),
    name       TEXT NOT NULL,
    q          TEXT,
    skill      TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (org_id, name)
  );

  CREATE TABLE IF NOT EXISTS overrides (
    org_id       INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    field        TEXT NOT NULL,
    value        TEXT NOT NULL,
    updated_by   TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, candidate_id, field)
  );

  -- Append-only activity trail: who did what to which candidate, when.
  CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL,
    user_email TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_org ON audit(org_id, id DESC);

  -- Workflow metadata layered on a candidate: hiring pipeline stage, free
  -- tags, and a private note. Keyed by candidate_id (stable hash), so it
  -- survives re-merges the same way overrides do.
  CREATE TABLE IF NOT EXISTS candidate_meta (
    org_id       INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    stage        TEXT NOT NULL DEFAULT 'new',   -- new|screening|interview|offer|hired|rejected
    tags         TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
    note         TEXT,
    updated_by   TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, candidate_id)
  );

  -- Saved job-description templates (reusable JD text), like saved views.
  CREATE TABLE IF NOT EXISTS jd_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL,
    name       TEXT NOT NULL,
    jd         TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (org_id, name)
  );

  -- Single-use password-reset tokens (short-lived).
  CREATE TABLE IF NOT EXISTS reset_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Pending teammate invites: a link the invitee opens to set their own
  -- password and join the org. No admin-chosen password required.
  CREATE TABLE IF NOT EXISTS invites (
    token       TEXT PRIMARY KEY,
    org_id      INTEGER NOT NULL,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL,
    invited_by  TEXT,
    accepted_at TEXT,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

if (isLegacy) migrateLegacy();
db.pragma(`user_version = ${SCHEMA_VERSION}`);

function migrateLegacy() {
  const run = db.transaction(() => {
    const orgId = db.prepare('INSERT INTO orgs (name) VALUES (?)').run('Default Organization').lastInsertRowid;

    // users: adopt into the default org; the pre-existing account becomes admin
    if (!columnExists('users', 'org_id')) db.exec('ALTER TABLE users ADD COLUMN org_id INTEGER');
    if (!columnExists('users', 'role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'recruiter'");
    db.prepare('UPDATE users SET org_id = ?, role = ?').run(orgId, 'admin');

    // subjects: adopt into the default org
    if (!columnExists('subjects', 'org_id')) db.exec('ALTER TABLE subjects ADD COLUMN org_id INTEGER');
    db.prepare('UPDATE subjects SET org_id = ? WHERE org_id IS NULL').run(orgId);

    // overrides & views changed their key shape — rebuild with org_id, copying data
    if (tableExists('overrides') && !columnExists('overrides', 'org_id')) {
      db.exec(`
        CREATE TABLE overrides_new (
          org_id INTEGER NOT NULL, candidate_id TEXT NOT NULL, field TEXT NOT NULL,
          value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (org_id, candidate_id, field)
        );`);
      db.prepare(
        `INSERT INTO overrides_new (org_id, candidate_id, field, value, updated_by, updated_at)
         SELECT ?, candidate_id, field, value, updated_by, updated_at FROM overrides`
      ).run(orgId);
      db.exec('DROP TABLE overrides; ALTER TABLE overrides_new RENAME TO overrides;');
    }
    if (tableExists('views') && !columnExists('views', 'org_id')) {
      db.exec(`
        CREATE TABLE views_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, name TEXT NOT NULL,
          q TEXT, skill TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (org_id, name)
        );`);
      db.prepare(
        `INSERT INTO views_new (org_id, name, q, skill, created_by, created_at)
         SELECT ?, name, q, skill, created_by, created_at FROM views`
      ).run(orgId);
      db.exec('DROP TABLE views; ALTER TABLE views_new RENAME TO views;');
    }
    // candidates + subject_keys were dropped; store.rebuildAll() (run on load)
    // regenerates them from the now-org-scoped subjects.
  });
  run();
}

module.exports = { db, DB_PATH, tableExists, columnExists };
