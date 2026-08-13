'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const { resolveEntities, buildRecord, subjectKeys } = require('./engine/merge');
const { overallConfidence } = require('./engine/confidence');
const { nameSimilarity, nameTokens } = require('./engine/fuzzy');

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

// ---- derived search index -------------------------------------------------
// candidate_index / candidate_skills mirror the candidates table so the list
// can filter and paginate in SQL. They are written by indexCandidate() from
// inside remerge/rebuild and torn down alongside the candidate they describe.

const _insertIndex = db.prepare(
  'INSERT OR REPLACE INTO candidate_index (org_id, candidate_id, sort_name, search_text, overall_confidence) VALUES (?, ?, ?, ?, ?)'
);
const _delIndex = db.prepare('DELETE FROM candidate_index WHERE org_id = ? AND candidate_id = ?');
const _insertSkill = db.prepare('INSERT INTO candidate_skills (org_id, candidate_id, skill) VALUES (?, ?, ?)');
const _delSkills = db.prepare('DELETE FROM candidate_skills WHERE org_id = ? AND candidate_id = ?');

function sortName(record) {
  return (record.full_name || '').trim().toLowerCase() || null;
}

// A lowercased text blob covering everything the list search should match.
function searchText(record) {
  const parts = [
    record.full_name,
    ...(record.emails || []),
    record.headline,
    ...(record.experience || []).flatMap((e) => [e.company, e.title]),
    ...(record.skills || []).map((s) => s.name),
    ...(record.projects || []).map((p) => p.name),
    record.location ? `${record.location.city || ''} ${record.location.country || ''}` : '',
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

// (Re)write the index + skill rows for one candidate. Called for every record
// written by remerge, inside its transaction.
function indexCandidate(orgId, record) {
  const id = record.candidate_id;
  _delSkills.run(orgId, id);
  _insertIndex.run(orgId, id, sortName(record), searchText(record), record.overall_confidence);
  const seen = new Set();
  for (const s of record.skills || []) {
    const nm = String(s.name || '').trim().toLowerCase();
    if (nm && !seen.has(nm)) { seen.add(nm); _insertSkill.run(orgId, id, nm); }
  }
}

function unindexCandidate(orgId, candidateId) {
  _delIndex.run(orgId, candidateId);
  _delSkills.run(orgId, candidateId);
}

function escapeLike(s) {
  return String(s).toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m);
}

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

  // Attach any human-asserted merge links so resolveEntities unions them.
  const linksBySubject = new Map();
  for (const lr of db.prepare(`SELECT subject_id, link_id FROM subject_links WHERE org_id = ? AND subject_id IN (${marks})`).all(orgId, ...subjectIds)) {
    if (!linksBySubject.has(lr.subject_id)) linksBySubject.set(lr.subject_id, []);
    linksBySubject.get(lr.subject_id).push(lr.link_id);
  }
  const subjects = rows.map((r) => ({ ...JSON.parse(r.subject), _dbId: r.id, __links: linksBySubject.get(r.id) || [] }));
  const clusters = resolveEntities(subjects);

  db.transaction(() => {
    const del = db.prepare('DELETE FROM candidates WHERE org_id = ? AND candidate_id = ?');
    for (const id of staleCandidates) { del.run(orgId, id); unindexCandidate(orgId, id); }
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
      indexCandidate(orgId, record); // keep the search index in lockstep
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
    // re-apply human merge links as keys so incremental closures see them
    for (const lr of db.prepare('SELECT subject_id, link_id FROM subject_links WHERE org_id = ?').all(orgId)) {
      insertKey.run(orgId, lr.subject_id, `link:${lr.link_id}`);
    }
    db.prepare('DELETE FROM candidates WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM candidate_index WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM candidate_skills WHERE org_id = ?').run(orgId);
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
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM candidate_index').get().n;
  // Rebuild if a derived table is missing/empty — covers fresh migrations and
  // databases that predate the search index (candidates present, index empty).
  if (subjects > 0 && (keys === 0 || candidates === 0 || indexed === 0)) rebuildAll();
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

// SQL-backed candidate query with optional pagination. Filters (text search,
// exact skill, stage, tag) run against the derived indexes so this stays fast
// as the pool grows. Returns { items, total } — `total` is the count matching
// the filters, independent of limit/offset, so the UI can page.
function queryCandidates(orgId, { q, skill, stage, tag, limit = null, offset = 0 } = {}) {
  const where = ['c.org_id = ?'];
  const params = [orgId];
  if (q) { where.push("ci.search_text LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(q)}%`); }
  if (skill) {
    where.push('EXISTS (SELECT 1 FROM candidate_skills cs WHERE cs.org_id = c.org_id AND cs.candidate_id = c.candidate_id AND cs.skill = ?)');
    params.push(String(skill).toLowerCase());
  }
  if (stage) { where.push("COALESCE(cm.stage, 'new') = ?"); params.push(String(stage)); }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(COALESCE(cm.tags, '[]')) je WHERE lower(je.value) = ?)");
    params.push(String(tag).toLowerCase());
  }

  const from =
    `FROM candidates c
     LEFT JOIN candidate_index ci ON ci.org_id = c.org_id AND ci.candidate_id = c.candidate_id
     LEFT JOIN candidate_meta cm ON cm.org_id = c.org_id AND cm.candidate_id = c.candidate_id
     WHERE ${where.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;

  let sql = `SELECT c.candidate_id, c.record, c.field_confidence, c.updated_at ${from} ORDER BY COALESCE(ci.sort_name, '~'), c.candidate_id`;
  const qp = [...params];
  if (limit != null) { sql += ' LIMIT ? OFFSET ?'; qp.push(limit, offset); }

  const rows = db.prepare(sql).all(...qp);
  const metaMap = metaForOrg(orgId);
  const items = rows.map((r) => ({ ...rowToCandidate(r), meta: metaMap.get(r.candidate_id) || { ...DEFAULT_META } }));
  return { items, total, limit, offset };
}

// Backward-compatible array form: the full filtered list (no pagination), used
// by JD matching, AI search and exports, which all rank/emit the whole pool.
function listCandidates(orgId, filters = {}) {
  return queryCandidates(orgId, { ...filters, limit: null, offset: 0 }).items;
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
    const delLinks = db.prepare('DELETE FROM subject_links WHERE org_id = ? AND subject_id = ?');
    const delSubject = db.prepare('DELETE FROM subjects WHERE org_id = ? AND id = ?');
    for (const id of ids) {
      delKeys.run(orgId, id); // keys reference subjects — remove them first
      delLinks.run(orgId, id);
      delSubject.run(orgId, id);
    }
    db.prepare('DELETE FROM overrides WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
    db.prepare('DELETE FROM candidate_meta WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
    db.prepare('DELETE FROM job_candidates WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
    db.prepare('DELETE FROM candidates WHERE org_id = ? AND candidate_id = ?').run(orgId, candidateId);
    unindexCandidate(orgId, candidateId);
  })();
}

// ---- job requisitions -------------------------------------------------

function listJobs(orgId) {
  return db
    .prepare(
      `SELECT j.id, j.title, j.description, j.status, j.created_by, j.created_at,
              (SELECT COUNT(*) FROM job_candidates jc WHERE jc.job_id = j.id) AS candidate_count
       FROM jobs j WHERE j.org_id = ? ORDER BY j.status, j.created_at DESC`
    )
    .all(orgId);
}

function getJob(orgId, jobId) {
  const job = db.prepare('SELECT id, title, description, status, created_by, created_at FROM jobs WHERE org_id = ? AND id = ?').get(orgId, jobId);
  return job || null;
}

function createJob(orgId, { title, description, status } = {}, createdBy) {
  title = String(title || '').trim();
  if (!title || title.length > 140) throw httpError(400, 'job title must be 1-140 characters');
  const st = status === 'closed' ? 'closed' : 'open';
  const id = db
    .prepare('INSERT INTO jobs (org_id, title, description, status, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(orgId, title, description ? String(description).slice(0, 20000) : null, st, createdBy || null).lastInsertRowid;
  return getJob(orgId, id);
}

function updateJob(orgId, jobId, patch = {}) {
  const job = getJob(orgId, jobId);
  if (!job) throw httpError(404, 'job not found');
  const title = patch.title != null ? String(patch.title).trim() : job.title;
  if (!title || title.length > 140) throw httpError(400, 'job title must be 1-140 characters');
  const description = patch.description !== undefined ? (patch.description ? String(patch.description).slice(0, 20000) : null) : job.description;
  const status = patch.status != null ? (patch.status === 'closed' ? 'closed' : 'open') : job.status;
  db.prepare('UPDATE jobs SET title = ?, description = ?, status = ? WHERE org_id = ? AND id = ?').run(title, description, status, orgId, jobId);
  return getJob(orgId, jobId);
}

function deleteJob(orgId, jobId) {
  const job = getJob(orgId, jobId);
  if (!job) throw httpError(404, 'job not found');
  db.transaction(() => {
    db.prepare('DELETE FROM job_candidates WHERE org_id = ? AND job_id = ?').run(orgId, jobId);
    db.prepare('DELETE FROM jobs WHERE org_id = ? AND id = ?').run(orgId, jobId);
  })();
}

// Attach candidates to a job (skips ones already attached or not in the org).
function addCandidatesToJob(orgId, jobId, candidateIds) {
  if (!getJob(orgId, jobId)) throw httpError(404, 'job not found');
  const insert = db.prepare('INSERT OR IGNORE INTO job_candidates (org_id, job_id, candidate_id, stage) VALUES (?, ?, ?, ?)');
  const exists = db.prepare('SELECT 1 FROM candidates WHERE org_id = ? AND candidate_id = ?');
  let added = 0;
  db.transaction(() => {
    for (const cid of candidateIds || []) {
      if (exists.get(orgId, cid)) added += insert.run(orgId, jobId, cid, 'new').changes;
    }
  })();
  return added;
}

function removeCandidateFromJob(orgId, jobId, candidateId) {
  const info = db.prepare('DELETE FROM job_candidates WHERE org_id = ? AND job_id = ? AND candidate_id = ?').run(orgId, jobId, candidateId);
  if (!info.changes) throw httpError(404, 'candidate is not on this job');
}

function setJobStage(orgId, jobId, candidateId, stage) {
  if (!STAGES.includes(stage)) throw httpError(400, `stage must be one of: ${STAGES.join(', ')}`);
  const info = db.prepare('UPDATE job_candidates SET stage = ? WHERE org_id = ? AND job_id = ? AND candidate_id = ?').run(stage, orgId, jobId, candidateId);
  if (!info.changes) throw httpError(404, 'candidate is not on this job');
}

// The candidates attached to a job, each with its per-job stage.
function listJobCandidates(orgId, jobId) {
  if (!getJob(orgId, jobId)) throw httpError(404, 'job not found');
  const rows = db
    .prepare(
      `SELECT jc.candidate_id, jc.stage AS job_stage, c.record
       FROM job_candidates jc JOIN candidates c ON c.org_id = jc.org_id AND c.candidate_id = jc.candidate_id
       WHERE jc.org_id = ? AND jc.job_id = ? ORDER BY jc.added_at`
    )
    .all(orgId, jobId);
  return rows.map((r) => ({ candidate_id: r.candidate_id, job_stage: r.job_stage, record: JSON.parse(r.record) }));
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

// ---- org settings: data retention + AI budget --------------------------

function aiDefaultCap() {
  const n = parseInt(process.env.AI_DAILY_CAP, 10);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

function getOrgSettings(orgId) {
  const row = db.prepare('SELECT retention_days, ai_daily_cap FROM org_settings WHERE org_id = ?').get(orgId);
  const retention_days = row && row.retention_days != null ? row.retention_days : null;
  const ai_daily_cap = row && row.ai_daily_cap != null ? row.ai_daily_cap : null;
  return { retention_days, ai_daily_cap, ai_effective_cap: ai_daily_cap != null ? ai_daily_cap : aiDefaultCap() };
}

// Patch retention_days and/or ai_daily_cap. A null/empty value clears the
// setting (retention: keep forever; cap: use the env default).
function setOrgSettings(orgId, patch = {}) {
  const cur = getOrgSettings(orgId);
  let retention = cur.retention_days;
  let cap = cur.ai_daily_cap;

  if ('retention_days' in patch) {
    const v = patch.retention_days;
    if (v == null || v === '') retention = null;
    else {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw httpError(400, 'retention_days must be 1–3650, or empty to keep data forever');
      retention = n;
    }
  }
  if ('ai_daily_cap' in patch) {
    const v = patch.ai_daily_cap;
    if (v == null || v === '') cap = null;
    else {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 0 || n > 100000) throw httpError(400, 'ai_daily_cap must be a non-negative number, or empty for the default');
      cap = n;
    }
  }

  db.prepare(
    `INSERT INTO org_settings (org_id, retention_days, ai_daily_cap) VALUES (?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET retention_days = excluded.retention_days,
       ai_daily_cap = excluded.ai_daily_cap, updated_at = datetime('now')`
  ).run(orgId, retention, cap);
  return getOrgSettings(orgId);
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Count one live AI call against today's per-org budget.
function recordAiUsage(orgId, feature) {
  db.prepare(
    `INSERT INTO ai_usage (org_id, day, feature, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(org_id, day, feature) DO UPDATE SET count = count + 1`
  ).run(orgId, utcDay(), String(feature || 'ai'));
}

// Today's AI budget for an org: how many live calls used, the cap, and whether
// it's exceeded. Only live (billable) calls are counted by the routes.
function aiBudget(orgId) {
  const cap = getOrgSettings(orgId).ai_effective_cap;
  const used = db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM ai_usage WHERE org_id = ? AND day = ?').get(orgId, utcDay()).n;
  return { used, cap, remaining: Math.max(0, cap - used), exceeded: used >= cap };
}

// ---- data retention: purge candidates past the org's retention window ----

// Delete candidates whose most recent source data is older than retention_days.
// A candidate with no dated subjects is left alone. Returns the count purged.
function purgeExpired(orgId) {
  const { retention_days } = getOrgSettings(orgId);
  if (!retention_days) return { purged: 0 };
  // Compute the cutoff in SQLite's own datetime format so string comparison
  // against subjects.created_at is valid.
  const cutoff = db.prepare("SELECT datetime('now', ?) AS c").get(`-${retention_days} days`).c;

  const rows = db.prepare('SELECT candidate_id, subject_ids FROM candidates WHERE org_id = ?').all(orgId);
  const expired = [];
  for (const row of rows) {
    const ids = JSON.parse(row.subject_ids);
    if (!ids.length) continue;
    const marks = ids.map(() => '?').join(',');
    const newest = db.prepare(`SELECT MAX(created_at) AS m FROM subjects WHERE org_id = ? AND id IN (${marks})`).get(orgId, ...ids).m;
    if (newest && newest < cutoff) expired.push(row.candidate_id);
  }
  for (const id of expired) { try { deleteCandidate(orgId, id); } catch { /* already gone */ } }
  return { purged: expired.length };
}

// Sweep every org (used by a periodic job at startup).
function purgeAllOrgs() {
  let purged = 0;
  for (const { id } of db.prepare('SELECT id FROM orgs').all()) purged += purgeExpired(id).purged;
  return { purged };
}

// ---- duplicate review: suggest, merge, dismiss, undo -------------------
//
// The deterministic engine keeps candidates apart whenever it isn't sure (a
// wrong merge is worse than a missed one). This surfaces the near-misses for a
// human to decide: pairs with similar names AND a corroborating signal that
// were NOT auto-merged. A confirmed merge is recorded as a human link that the
// resolver honors as its strongest key; it can be undone.

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'live.com',
]);
const SUGGEST_NAME_FLOOR = 0.6; // names must be plausibly the same person
const SUGGEST_SCORE_MIN = 0.7;  // ...and carry at least one corroborating signal

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

function lc(s) { return String(s || '').toLowerCase().trim(); }
function emailDomain(e) { const m = /@(.+)$/.exec(String(e || '')); return m ? m[1].toLowerCase() : null; }
function round2(x) { return Math.round(x * 100) / 100; }

// Similarity of two candidate records for duplicate review: name similarity is
// the base; a shared employer / city / (non-free) email domain / skill overlap
// each adds evidence. Returns the score, the raw name similarity, and reasons.
function scorePair(a, b) {
  const nameSim = nameSimilarity(a.full_name || '', b.full_name || '');
  const reasons = [];
  let score = nameSim;
  if (nameSim >= SUGGEST_NAME_FLOOR) reasons.push(`names ${Math.round(nameSim * 100)}% similar`);

  const compsB = new Set((b.experience || []).map((e) => lc(e.company)).filter(Boolean));
  const sharedComp = (a.experience || []).map((e) => e.company).filter((c) => c && compsB.has(lc(c)));
  if (sharedComp.length) { score += 0.15; reasons.push(`same employer: ${sharedComp[0]}`); }

  const cityA = a.location && a.location.city ? lc(a.location.city) : null;
  const cityB = b.location && b.location.city ? lc(b.location.city) : null;
  if (cityA && cityA === cityB) { score += 0.1; reasons.push(`same city: ${a.location.city}`); }

  const domB = new Set((b.emails || []).map(emailDomain).filter(Boolean));
  const sharedDom = (a.emails || []).map(emailDomain).filter((d) => d && domB.has(d) && !FREE_EMAIL_DOMAINS.has(d));
  if (sharedDom.length) { score += 0.1; reasons.push(`same email domain: ${sharedDom[0]}`); }

  const skB = new Set((b.skills || []).map((s) => lc(s.name)));
  const overlap = (a.skills || []).map((s) => lc(s.name)).filter((s) => skB.has(s)).length;
  if (overlap >= 3) { score += 0.1; reasons.push(`${overlap} shared skills`); }

  return { score: Math.min(1, round2(score)), nameSim, reasons };
}

function reviewSummary(id, rec) {
  return {
    candidate_id: id,
    full_name: rec.full_name,
    headline: rec.headline,
    emails: rec.emails || [],
    location: rec.location || null,
    companies: [...new Set((rec.experience || []).map((e) => e.company).filter(Boolean))].slice(0, 3),
    top_skills: [...(rec.skills || [])].sort((x, y) => (y.confidence || 0) - (x.confidence || 0)).slice(0, 5).map((s) => s.name),
    overall_confidence: rec.overall_confidence,
  };
}

// Candidate pairs worth reviewing as possible duplicates. Bucketed by name-token
// prefix so this stays sub-quadratic on large pools.
function findMergeSuggestions(orgId, { limit = 100 } = {}) {
  const cands = db
    .prepare('SELECT candidate_id, record FROM candidates WHERE org_id = ?')
    .all(orgId)
    .map((r) => ({ id: r.candidate_id, rec: JSON.parse(r.record) }));
  const dismissed = new Set(db.prepare('SELECT pair_key FROM merge_dismissals WHERE org_id = ?').all(orgId).map((r) => r.pair_key));

  const buckets = new Map();
  for (const c of cands) {
    const prefixes = new Set(nameTokens(c.rec.full_name || '').filter((t) => t.length >= 3).map((t) => t.slice(0, 3)));
    for (const p of prefixes) { if (!buckets.has(p)) buckets.set(p, []); buckets.get(p).push(c); }
  }

  const seen = new Set();
  const out = [];
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const A = group[i]; const B = group[j];
        const pk = pairKey(A.id, B.id);
        if (seen.has(pk) || dismissed.has(pk)) continue;
        seen.add(pk);
        const s = scorePair(A.rec, B.rec);
        if (s.nameSim >= SUGGEST_NAME_FLOOR && s.score >= SUGGEST_SCORE_MIN) {
          out.push({ pair_key: pk, score: s.score, reasons: s.reasons, a: reviewSummary(A.id, A.rec), b: reviewSummary(B.id, B.rec) });
        }
      }
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
}

function subjectIdsOf(orgId, candidateId) {
  const row = db.prepare('SELECT subject_ids FROM candidates WHERE org_id = ? AND candidate_id = ?').get(orgId, candidateId);
  return row ? JSON.parse(row.subject_ids) : null;
}

function candidateContaining(orgId, subjectId) {
  for (const row of db.prepare('SELECT candidate_id, subject_ids FROM candidates WHERE org_id = ?').all(orgId)) {
    if (JSON.parse(row.subject_ids).includes(subjectId)) return getCandidate(orgId, row.candidate_id);
  }
  return null;
}

// Force-merge two candidates: record a human link over the union of their
// subjects and re-resolve. Returns the resulting (merged) candidate.
function mergeCandidates(orgId, idA, idB, user) {
  if (String(idA) === String(idB)) throw httpError(400, 'cannot merge a candidate with itself');
  const a = subjectIdsOf(orgId, idA);
  const b = subjectIdsOf(orgId, idB);
  if (!a || !b) throw httpError(404, 'candidate not found');
  const subjectIds = [...new Set([...a, ...b])];
  const linkId = crypto.randomUUID();
  db.transaction(() => {
    const insLink = db.prepare('INSERT INTO subject_links (org_id, link_id, subject_id, created_by) VALUES (?, ?, ?, ?)');
    const insKey = db.prepare('INSERT INTO subject_keys (org_id, subject_id, key) VALUES (?, ?, ?)');
    for (const sid of subjectIds) {
      insLink.run(orgId, linkId, sid, user || null);
      insKey.run(orgId, sid, `link:${linkId}`);
    }
  })();
  remerge(orgId, affectedClosure(orgId, subjectIds));
  return { link_id: linkId, candidate: candidateContaining(orgId, subjectIds[0]) };
}

function dismissMergePair(orgId, idA, idB, user) {
  db.prepare('INSERT OR IGNORE INTO merge_dismissals (org_id, pair_key, created_by) VALUES (?, ?, ?)').run(orgId, pairKey(idA, idB), user || null);
  return { dismissed: pairKey(idA, idB) };
}

// Human merges still in force, each with the candidate they now form.
function listManualMerges(orgId) {
  const links = db
    .prepare('SELECT link_id, COUNT(*) AS subjects, MIN(created_at) AS created_at, MIN(created_by) AS created_by FROM subject_links WHERE org_id = ? GROUP BY link_id')
    .all(orgId);
  return links.map((l) => {
    const anySid = db.prepare('SELECT subject_id FROM subject_links WHERE org_id = ? AND link_id = ? LIMIT 1').get(orgId, l.link_id).subject_id;
    const cand = candidateContaining(orgId, anySid);
    return {
      link_id: l.link_id,
      subjects: l.subjects,
      created_at: l.created_at,
      created_by: l.created_by,
      candidate: cand ? reviewSummary(cand.candidate_id, cand.record) : null,
    };
  });
}

// Undo a manual merge: drop the link and re-resolve, which re-splits the
// candidates unless a real shared key still binds them.
function undoMerge(orgId, linkId) {
  const sids = db.prepare('SELECT subject_id FROM subject_links WHERE org_id = ? AND link_id = ?').all(orgId, linkId).map((r) => r.subject_id);
  if (!sids.length) throw httpError(404, 'merge not found');
  db.transaction(() => {
    db.prepare('DELETE FROM subject_links WHERE org_id = ? AND link_id = ?').run(orgId, linkId);
    db.prepare('DELETE FROM subject_keys WHERE org_id = ? AND key = ?').run(orgId, `link:${linkId}`);
  })();
  remerge(orgId, affectedClosure(orgId, sids));
  return { unmerged: sids.length };
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
  queryCandidates,
  getCandidate,
  getOrgSettings,
  setOrgSettings,
  recordAiUsage,
  aiBudget,
  purgeExpired,
  purgeAllOrgs,
  findMergeSuggestions,
  mergeCandidates,
  dismissMergePair,
  listManualMerges,
  undoMerge,
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
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  addCandidatesToJob,
  removeCandidateFromJob,
  setJobStage,
  listJobCandidates,
  OVERRIDABLE,
  STAGES,
};
