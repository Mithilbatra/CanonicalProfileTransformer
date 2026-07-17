'use strict';

const { db } = require('./db');
const { resolveEntities, buildRecord, subjectKeys } = require('./engine/merge');
const { overallConfidence } = require('./engine/confidence');

// The candidate store. The source of truth is the `subjects` table (raw
// extracted observations); `candidates` is a materialization of it.
//
// EVERY function is scoped to an org_id. Subjects, candidates, overrides,
// views and the subject_keys index all carry org_id, and no query crosses it,
// so organizations are fully isolated — including the merge: two orgs holding
// the same email never collapse into one candidate.
//
// Merging is INCREMENTAL: a new upload only re-resolves the subjects it could
// possibly connect to (the transitive closure over shared identity keys within
// the org, widened to whole existing clusters). resolveEntities remains the
// single source of truth for who merges with whom.

// Fields a recruiter may manually correct, with a light type check each.
const OVERRIDABLE = {
  full_name: (v) => typeof v === 'string' && v.trim().length > 0,
  headline: (v) => typeof v === 'string',
  years_experience: (v) => Number.isInteger(v) && v >= 0 && v <= 60,
  emails: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  phones: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  location: (v) => v === null || (typeof v === 'object' && !Array.isArray(v)),
};

function ingestSources(orgId, sourceResults) {
  const insertSubject = db.prepare('INSERT INTO subjects (org_id, source_id, source_type, subject) VALUES (?, ?, ?, ?)');
  const insertKey = db.prepare('INSERT INTO subject_keys (org_id, subject_id, key) VALUES (?, ?, ?)');

  const newIds = db.transaction(() => {
    const ids = [];
    for (const sr of sourceResults) {
      if (!sr.ok) continue;
      for (const s of sr.subjects) {
        const id = insertSubject.run(orgId, sr.sourceId, sr.sourceType, JSON.stringify(s)).lastInsertRowid;
        for (const key of subjectKeys(s)) insertKey.run(orgId, id, key);
        ids.push(id);
      }
    }
    return ids;
  })();

  if (newIds.length) remerge(orgId, affectedClosure(orgId, newIds));
  return { subjectsAdded: newIds.length, totalCandidates: countCandidates(orgId) };
}

// All subject ids in this org that could share a cluster with the seeds:
// expand over shared identity keys until stable, then widen to complete
// clusters. The key join is filtered to the org so a shared key can never
// pull in another tenant's subjects.
function affectedClosure(orgId, seedIds) {
  const affected = new Set(seedIds);
  let frontier = [...seedIds];
  while (frontier.length) {
    const marks = frontier.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT b.subject_id AS id FROM subject_keys a
         JOIN subject_keys b ON b.key = a.key AND b.org_id = a.org_id
         WHERE a.org_id = ? AND a.subject_id IN (${marks})`
      )
      .all(orgId, ...frontier);
    frontier = rows.map((r) => r.id).filter((id) => !affected.has(id));
    frontier.forEach((id) => affected.add(id));
  }

  for (const row of db.prepare('SELECT subject_ids FROM candidates WHERE org_id = ?').all(orgId)) {
    const ids = JSON.parse(row.subject_ids);
    if (ids.some((id) => affected.has(id))) ids.forEach((id) => affected.add(id));
  }
  return [...affected];
}

// Re-resolve exactly the given subjects within an org: drop the candidate rows
// they were part of, run entity resolution over the set, write fresh records.
function remerge(orgId, subjectIds) {
  if (!subjectIds.length) return;
  const affected = new Set(subjectIds);

  const staleCandidates = db
    .prepare('SELECT candidate_id, subject_ids FROM candidates WHERE org_id = ?')
    .all(orgId)
    .filter((row) => JSON.parse(row.subject_ids).some((id) => affected.has(id)))
    .map((row) => row.candidate_id);

  const marks = subjectIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, subject FROM subjects WHERE org_id = ? AND id IN (${marks}) ORDER BY id`)
    .all(orgId, ...subjectIds);
  const subjects = rows.map((r) => ({ ...JSON.parse(r.subject), _dbId: r.id }));
  const clusters = resolveEntities(subjects);

  db.transaction(() => {
    const del = db.prepare('DELETE FROM candidates WHERE org_id = ? AND candidate_id = ?');
    for (const id of staleCandidates) del.run(orgId, id);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO candidates (org_id, candidate_id, record, field_confidence, subject_ids) VALUES (?, ?, ?, ?, ?)'
    );
    for (const cluster of clusters) {
      const record = buildRecord(cluster);
      const fieldConf = { ...(record.__fieldConfidence || {}) };
      applyOverrides(orgId, record, fieldConf);
      insert.run(
        orgId,
        record.candidate_id,
        JSON.stringify(record),
        JSON.stringify(fieldConf),
        JSON.stringify(cluster.map((s) => s._dbId))
      );
    }
  })();
}

// Full rebuild of one org: refresh its key index and re-merge all its subjects.
function rebuild(orgId) {
  const rows = db.prepare('SELECT id, subject FROM subjects WHERE org_id = ? ORDER BY id').all(orgId);
  db.transaction(() => {
    db.prepare('DELETE FROM subject_keys WHERE org_id = ?').run(orgId);
    const insertKey = db.prepare('INSERT INTO subject_keys (org_id, subject_id, key) VALUES (?, ?, ?)');
    for (const r of rows) {
      for (const key of subjectKeys(JSON.parse(r.subject))) insertKey.run(orgId, r.id, key);
    }
    db.prepare('DELETE FROM candidates WHERE org_id = ?').run(orgId);
  })();
  remerge(orgId, rows.map((r) => r.id));
  return countCandidates(orgId);
}

// Rebuild every org. Used at startup to backfill databases that were just
// migrated (candidates/subject_keys were dropped) or predate the key index.
function rebuildAll() {
  for (const { id } of db.prepare('SELECT id FROM orgs').all()) rebuild(id);
}

// On load, if any org has subjects but no key index (fresh migration or a
// pre-index database), rebuild everything so the store is consistent.
function ensureConsistent() {
  const subjects = db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n;
  const keys = db.prepare('SELECT COUNT(*) AS n FROM subject_keys').get().n;
  const candidates = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
  if (subjects > 0 && (keys === 0 || candidates === 0)) rebuildAll();
}

// Overlay manual corrections on a freshly merged record. An override always
// wins, gets confidence 1.0, and shows up in provenance as a human decision.
function applyOverrides(orgId, record, fieldConf) {
  const rows = db
    .prepare('SELECT field, value, updated_by FROM overrides WHERE org_id = ? AND candidate_id = ?')
    .all(orgId, record.candidate_id);
  for (const row of rows) {
    record[row.field] = JSON.parse(row.value);
    fieldConf[row.field] = 1.0;
    record.provenance = record.provenance.filter((p) => p.field !== row.field);
    record.provenance.push({
      field: row.field,
      source: 'human',
      method: row.updated_by ? `manual_override:${row.updated_by}` : 'manual_override',
    });
  }
  if (rows.length) record.overall_confidence = overallConfidence(record, fieldConf);
}

function listCandidates(orgId, { q, skill } = {}) {
  const rows = db
    .prepare('SELECT candidate_id, record, field_confidence, updated_at FROM candidates WHERE org_id = ?')
    .all(orgId);
  let items = rows.map(rowToCandidate);

  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter((c) => {
      const r = c.record;
      return (
        (r.full_name || '').toLowerCase().includes(needle) ||
        r.emails.some((e) => e.includes(needle)) ||
        (r.headline || '').toLowerCase().includes(needle) ||
        r.experience.some((e) => (e.company || '').toLowerCase().includes(needle))
      );
    });
  }
  if (skill) {
    const needle = String(skill).toLowerCase();
    items = items.filter((c) => c.record.skills.some((s) => s.name.toLowerCase() === needle));
  }

  items.sort((a, b) => (a.record.full_name || '~').localeCompare(b.record.full_name || '~'));
  return items;
}

function getCandidate(orgId, candidateId) {
  const row = db
    .prepare('SELECT candidate_id, record, field_confidence, updated_at FROM candidates WHERE org_id = ? AND candidate_id = ?')
    .get(orgId, candidateId);
  return row ? rowToCandidate(row) : null;
}

function setOverride(orgId, candidateId, field, value, updatedBy) {
  if (!(field in OVERRIDABLE)) {
    throw httpError(400, `field "${field}" cannot be overridden (allowed: ${Object.keys(OVERRIDABLE).join(', ')})`);
  }
  if (!OVERRIDABLE[field](value)) throw httpError(400, `invalid value for "${field}"`);
  if (!getCandidate(orgId, candidateId)) throw httpError(404, 'candidate not found');

  db.prepare(
    `INSERT INTO overrides (org_id, candidate_id, field, value, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, candidate_id, field) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(orgId, candidateId, field, JSON.stringify(value), updatedBy || null);

  remergeCandidate(orgId, candidateId);
  return getCandidate(orgId, candidateId);
}

function clearOverride(orgId, candidateId, field) {
  db.prepare('DELETE FROM overrides WHERE org_id = ? AND candidate_id = ? AND field = ?').run(orgId, candidateId, field);
  remergeCandidate(orgId, candidateId);
  return getCandidate(orgId, candidateId);
}

// Overrides don't change WHO merges — only record contents — so only this
// candidate's own cluster needs re-merging.
function remergeCandidate(orgId, candidateId) {
  const row = db.prepare('SELECT subject_ids FROM candidates WHERE org_id = ? AND candidate_id = ?').get(orgId, candidateId);
  if (row) remerge(orgId, JSON.parse(row.subject_ids));
}

function deleteCandidate(orgId, candidateId) {
  const row = db.prepare('SELECT subject_ids FROM candidates WHERE org_id = ? AND candidate_id = ?').get(orgId, candidateId);
  if (!row) throw httpError(404, 'candidate not found');
  const ids = JSON.parse(row.subject_ids);
  db.transaction(() => {
    const delKeys = db.prepare('DELETE FROM subject_keys WHERE org_id = ? AND subject_id = ?');
    const delSubject = db.prepare('DELETE FROM subjects WHERE org_id = ? AND id = ?');
    for (const id of ids) {
      delKeys.run(orgId, id); // keys reference subjects — remove them first
      delSubject.run(orgId, id);
    }
    db.prepare('DELETE FROM overrides WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
    db.prepare('DELETE FROM candidates WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
  })();
}

// ---- saved views (named q/skill filter combinations) -------------------

function listViews(orgId) {
  return db.prepare('SELECT id, name, q, skill, created_by FROM views WHERE org_id = ? ORDER BY name').all(orgId);
}

function saveView(orgId, name, q, skill, createdBy) {
  name = String(name || '').trim();
  if (!name || name.length > 60) throw httpError(400, 'view name must be 1-60 characters');
  db.prepare(
    `INSERT INTO views (org_id, name, q, skill, created_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, name) DO UPDATE SET q = excluded.q, skill = excluded.skill, created_by = excluded.created_by`
  ).run(orgId, name, q || null, skill || null, createdBy || null);
  return listViews(orgId).find((v) => v.name === name);
}

function deleteView(orgId, id) {
  const info = db.prepare('DELETE FROM views WHERE org_id = ? AND id = ?').run(orgId, id);
  if (!info.changes) throw httpError(404, 'view not found');
}

function countCandidates(orgId) {
  return db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE org_id = ?').get(orgId).n;
}

function rowToCandidate(row) {
  return {
    candidate_id: row.candidate_id,
    record: JSON.parse(row.record),
    field_confidence: JSON.parse(row.field_confidence),
    updated_at: row.updated_at,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

ensureConsistent();

module.exports = {
  ingestSources,
  rebuild,
  rebuildAll,
  listCandidates,
  getCandidate,
  setOverride,
  clearOverride,
  deleteCandidate,
  listViews,
  saveView,
  deleteView,
  OVERRIDABLE,
};
