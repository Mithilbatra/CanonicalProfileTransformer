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

// Hiring pipeline stages, in funnel order. A candidate starts at 'new'.
const STAGES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];
const DEFAULT_META = { stage: 'new', tags: [], note: null };

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

function listCandidates(orgId, { q, skill, stage, tag } = {}) {
  const rows = db
    .prepare('SELECT candidate_id, record, field_confidence, updated_at FROM candidates WHERE org_id = ?')
    .all(orgId);
  const metaMap = metaForOrg(orgId);
  let items = rows.map((r) => ({ ...rowToCandidate(r), meta: metaMap.get(r.candidate_id) || { ...DEFAULT_META } }));

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
  if (stage) items = items.filter((c) => c.meta.stage === stage);
  if (tag) {
    const needle = String(tag).toLowerCase();
    items = items.filter((c) => c.meta.tags.some((t) => t.toLowerCase() === needle));
  }

  items.sort((a, b) => (a.record.full_name || '~').localeCompare(b.record.full_name || '~'));
  return items;
}

function getCandidate(orgId, candidateId) {
  const row = db
    .prepare('SELECT candidate_id, record, field_confidence, updated_at FROM candidates WHERE org_id = ? AND candidate_id = ?')
    .get(orgId, candidateId);
  if (!row) return null;
  return { ...rowToCandidate(row), meta: getMeta(orgId, candidateId) };
}

// ---- workflow metadata: pipeline stage, tags, private note --------------

function metaForOrg(orgId) {
  const map = new Map();
  for (const row of db.prepare('SELECT candidate_id, stage, tags, note FROM candidate_meta WHERE org_id = ?').all(orgId)) {
    map.set(row.candidate_id, { stage: row.stage, tags: JSON.parse(row.tags), note: row.note });
  }
  return map;
}

function getMeta(orgId, candidateId) {
  const row = db.prepare('SELECT stage, tags, note FROM candidate_meta WHERE org_id = ? AND candidate_id = ?').get(orgId, candidateId);
  return row ? { stage: row.stage, tags: JSON.parse(row.tags), note: row.note } : { ...DEFAULT_META };
}

// Upsert one field of the metadata row without disturbing the others.
function upsertMeta(orgId, candidateId, patch, updatedBy) {
  if (!getCandidate(orgId, candidateId)) throw httpError(404, 'candidate not found');
  const current = getMeta(orgId, candidateId);
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO candidate_meta (org_id, candidate_id, stage, tags, note, updated_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, candidate_id) DO UPDATE SET stage = excluded.stage, tags = excluded.tags,
       note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(orgId, candidateId, next.stage, JSON.stringify(next.tags), next.note, updatedBy || null);
  return getCandidate(orgId, candidateId);
}

function setStage(orgId, candidateId, stage, updatedBy) {
  if (!STAGES.includes(stage)) throw httpError(400, `stage must be one of: ${STAGES.join(', ')}`);
  return upsertMeta(orgId, candidateId, { stage }, updatedBy);
}

function setTags(orgId, candidateId, tags, updatedBy) {
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw httpError(400, 'tags must be an array of strings');
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 30);
  return upsertMeta(orgId, candidateId, { tags: clean }, updatedBy);
}

function setNote(orgId, candidateId, note, updatedBy) {
  if (note != null && typeof note !== 'string') throw httpError(400, 'note must be a string or null');
  const clean = note ? String(note).slice(0, 2000) : null;
  return upsertMeta(orgId, candidateId, { note: clean }, updatedBy);
}

// Bulk stage change; returns how many candidates were updated.
function setStageBulk(orgId, candidateIds, stage, updatedBy) {
  if (!STAGES.includes(stage)) throw httpError(400, `stage must be one of: ${STAGES.join(', ')}`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of candidateIds) {
      if (db.prepare('SELECT 1 FROM candidates WHERE org_id = ? AND candidate_id = ?').get(orgId, id)) {
        upsertMeta(orgId, id, { stage }, updatedBy);
        n++;
      }
    }
  });
  tx();
  return n;
}

function deleteCandidates(orgId, candidateIds) {
  let n = 0;
  for (const id of candidateIds) {
    try { deleteCandidate(orgId, id); n++; } catch { /* already gone — skip */ }
  }
  return n;
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
    db.prepare('DELETE FROM candidate_meta WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
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

// ---- saved JD templates (reusable job-description text) -----------------

function listJdTemplates(orgId) {
  return db.prepare('SELECT id, name, jd, created_by FROM jd_templates WHERE org_id = ? ORDER BY name').all(orgId);
}

function saveJdTemplate(orgId, name, jd, createdBy) {
  name = String(name || '').trim();
  if (!name || name.length > 80) throw httpError(400, 'template name must be 1-80 characters');
  if (!jd || !String(jd).trim()) throw httpError(400, 'template jd text is required');
  db.prepare(
    `INSERT INTO jd_templates (org_id, name, jd, created_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, name) DO UPDATE SET jd = excluded.jd, created_by = excluded.created_by`
  ).run(orgId, name, String(jd).slice(0, 20000), createdBy || null);
  return listJdTemplates(orgId).find((t) => t.name === name);
}

function deleteJdTemplate(orgId, id) {
  const info = db.prepare('DELETE FROM jd_templates WHERE org_id = ? AND id = ?').run(orgId, id);
  if (!info.changes) throw httpError(404, 'template not found');
}

// ---- backup / restore (data durability) -------------------------------

// A full, portable snapshot of one org's candidate data. Subjects are the
// source of truth; candidates rebuild from them, so the backup carries raw
// subjects plus the human layers (meta, views, JD templates).
function exportOrg(orgId) {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    subjects: db.prepare('SELECT source_id, source_type, subject FROM subjects WHERE org_id = ? ORDER BY id').all(orgId),
    meta: db.prepare('SELECT candidate_id, stage, tags, note FROM candidate_meta WHERE org_id = ?').all(orgId),
    views: db.prepare('SELECT name, q, skill, created_by FROM views WHERE org_id = ?').all(orgId),
    jd_templates: db.prepare('SELECT name, jd, created_by FROM jd_templates WHERE org_id = ?').all(orgId),
  };
}

// Import a snapshot into an org (appends; identical subjects re-merge by
// identity into the same candidates, so meta keyed by candidate_id reattaches).
function importOrg(orgId, data) {
  if (!data || !Array.isArray(data.subjects)) throw httpError(400, 'invalid backup: missing subjects[]');
  const insertSubject = db.prepare('INSERT INTO subjects (org_id, source_id, source_type, subject) VALUES (?, ?, ?, ?)');
  const insertKey = db.prepare('INSERT INTO subject_keys (org_id, subject_id, key) VALUES (?, ?, ?)');

  db.transaction(() => {
    for (const s of data.subjects) {
      const parsed = typeof s.subject === 'string' ? JSON.parse(s.subject) : s.subject;
      const id = insertSubject.run(orgId, s.source_id, s.source_type, JSON.stringify(parsed)).lastInsertRowid;
      for (const key of subjectKeys(parsed)) insertKey.run(orgId, id, key);
    }
    for (const v of data.views || []) {
      db.prepare('INSERT OR IGNORE INTO views (org_id, name, q, skill, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(orgId, v.name, v.q || null, v.skill || null, v.created_by || null);
    }
    for (const t of data.jd_templates || []) {
      db.prepare('INSERT OR IGNORE INTO jd_templates (org_id, name, jd, created_by) VALUES (?, ?, ?, ?)')
        .run(orgId, t.name, t.jd, t.created_by || null);
    }
  })();

  rebuild(orgId); // materialize candidates from the imported subjects

  // meta reattaches only for candidate_ids that actually exist after the merge
  for (const m of data.meta || []) {
    if (db.prepare('SELECT 1 FROM candidates WHERE org_id = ? AND candidate_id = ?').get(orgId, m.candidate_id)) {
      db.prepare(
        `INSERT INTO candidate_meta (org_id, candidate_id, stage, tags, note) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, candidate_id) DO UPDATE SET stage = excluded.stage, tags = excluded.tags, note = excluded.note`
      ).run(orgId, m.candidate_id, m.stage || 'new', typeof m.tags === 'string' ? m.tags : JSON.stringify(m.tags || []), m.note || null);
    }
  }
  return { subjects: data.subjects.length, candidates: countCandidates(orgId) };
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
  deleteCandidates,
  getMeta,
  setStage,
  setTags,
  setNote,
  setStageBulk,
  listViews,
  saveView,
  deleteView,
  listJdTemplates,
  saveJdTemplate,
  deleteJdTemplate,
  exportOrg,
  importOrg,
  OVERRIDABLE,
  STAGES,
};
