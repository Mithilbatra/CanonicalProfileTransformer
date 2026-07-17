'use strict';

const crypto = require('crypto');
const { db } = require('./db');

// Token-based auth, deliberately boring: scrypt password hashes (built into
// Node, no extra dependency) and random bearer tokens stored server-side so
// they can be revoked. No JWT — sessions in the DB are simpler to reason
// about and to log out.
//
// Multi-tenant: registering creates a fresh organization and makes the
// registrant its admin. An admin can invite teammates into the same org with
// a role (admin | recruiter | viewer); everyone in an org shares its
// candidate pool, and no query ever crosses org boundaries.

const SESSION_DAYS = 7;
const SCRYPT_N = 16384;
const ROLES = ['admin', 'recruiter', 'viewer'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N }).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N }).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateCredentials(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'invalid email');
  if (String(password || '').length < 8) throw httpError(400, 'password must be at least 8 characters');
  return email;
}

// New sign-up: create an organization and its first (admin) user.
function register(email, password, orgName) {
  email = validateCredentials(email, password);
  const create = db.transaction(() => {
    const org = String(orgName || '').trim() || `${email.split('@')[0]}'s workspace`;
    const orgId = db.prepare('INSERT INTO orgs (name) VALUES (?)').run(org).lastInsertRowid;
    const userId = db
      .prepare('INSERT INTO users (email, password_hash, org_id, role) VALUES (?, ?, ?, ?)')
      .run(email, hashPassword(password), orgId, 'admin').lastInsertRowid;
    return { userId, orgId };
  });
  let ids;
  try {
    ids = create();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw httpError(409, 'an account with this email already exists');
    throw err;
  }
  return createSession(ids.userId);
}

// Admin invites a teammate into their own org.
function invite(orgId, email, password, role) {
  email = validateCredentials(email, password);
  if (!ROLES.includes(role)) throw httpError(400, `role must be one of: ${ROLES.join(', ')}`);
  try {
    db.prepare('INSERT INTO users (email, password_hash, org_id, role) VALUES (?, ?, ?, ?)')
      .run(email, hashPassword(password), orgId, role);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw httpError(409, 'an account with this email already exists');
    throw err;
  }
  return { email, role };
}

function listMembers(orgId) {
  return db.prepare('SELECT email, role, created_at FROM users WHERE org_id = ? ORDER BY created_at').all(orgId);
}

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  // same error for unknown email and wrong password — don't leak which
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw httpError(401, 'invalid email or password');
  }
  return createSession(user.id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  const me = profile(userId);
  return { token, expires_at: expires, ...me };
}

function profile(userId) {
  return db
    .prepare(
      `SELECT u.email, u.role, u.org_id, o.name AS org_name
       FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ?`
    )
    .get(userId);
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.role, u.org_id, o.name AS org_name
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token);
  return row || null;
}

// Express middleware: requires a valid bearer token, puts the user (with its
// org_id and role) on req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = userForToken(token);
  if (!user) return res.status(401).json({ error: 'authentication required' });
  req.user = user;
  req.token = token;
  next();
}

// Middleware factory: gate a route to the given roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { register, login, logout, invite, listMembers, requireAuth, requireRole, userForToken, ROLES };
