'use strict';

process.env.DB_PATH = ':memory:';
process.env.SILENCE_MAIL = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractSources } = require('../server/engine/pipeline');
const store = require('../server/store');
const auth = require('../server/auth');

const SAMPLES = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');

const ORG = auth.register('owner@jobs.test', 'longpassword', 'Jobs Co').org_id;
let ids;

test('setup: seed two candidates', async () => {
  const r = await extractSources([
    { name: 'recruiter.csv', content: read('recruiter.csv') },
    { name: 'ats.json', content: read('ats.json') },
  ]);
  store.ingestSources(ORG, r.sourceResults);
  ids = store.listCandidates(ORG).map((c) => c.candidate_id);
  assert.equal(ids.length, 2);
});

test('job CRUD: create, read, update, validate', () => {
  const job = store.createJob(ORG, { title: 'Senior Backend Engineer', description: 'Python, PostgreSQL' }, 'owner@jobs.test');
  assert.ok(job.id);
  assert.equal(job.status, 'open');

  assert.deepEqual(store.getJob(ORG, job.id).title, 'Senior Backend Engineer');
  const closed = store.updateJob(ORG, job.id, { status: 'closed' });
  assert.equal(closed.status, 'closed');

  const list = store.listJobs(ORG);
  assert.equal(list.length, 1);
  assert.equal(list[0].candidate_count, 0);

  assert.throws(() => store.createJob(ORG, { title: '' }), /title must be/);
  assert.throws(() => store.updateJob(ORG, 9999, { title: 'x' }), /not found/);
});

test('per-job pipeline: attach, stage is per-job, list, remove', () => {
  const jobA = store.createJob(ORG, { title: 'Job A' }, 'o@jobs.test');
  const jobB = store.createJob(ORG, { title: 'Job B' }, 'o@jobs.test');

  assert.equal(store.addCandidatesToJob(ORG, jobA.id, ids), 2);
  assert.equal(store.addCandidatesToJob(ORG, jobA.id, ids), 0); // idempotent
  assert.equal(store.addCandidatesToJob(ORG, jobB.id, [ids[0]]), 1);

  // the same candidate holds different stages on different jobs
  store.setJobStage(ORG, jobA.id, ids[0], 'interview');
  store.setJobStage(ORG, jobB.id, ids[0], 'rejected');

  const a = store.listJobCandidates(ORG, jobA.id);
  const b = store.listJobCandidates(ORG, jobB.id);
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  assert.equal(a.find((c) => c.candidate_id === ids[0]).job_stage, 'interview');
  assert.equal(b.find((c) => c.candidate_id === ids[0]).job_stage, 'rejected');
  assert.ok(a[0].record.full_name !== undefined); // full candidate record attached

  // the global candidate stage is untouched by per-job stages
  assert.equal(store.getCandidate(ORG, ids[0]).meta.stage, 'new');

  store.removeCandidateFromJob(ORG, jobA.id, ids[1]);
  assert.equal(store.listJobCandidates(ORG, jobA.id).length, 1);
  assert.throws(() => store.setJobStage(ORG, jobA.id, ids[1], 'offer'), /not on this job/);
  assert.throws(() => store.setJobStage(ORG, jobA.id, ids[0], 'banana'), /stage must be/);
});

test('deleting a candidate removes it from every job', () => {
  const job = store.createJob(ORG, { title: 'Cascade' }, 'o@jobs.test');
  store.addCandidatesToJob(ORG, job.id, ids);
  assert.equal(store.listJobCandidates(ORG, job.id).length, 2);

  store.deleteCandidate(ORG, ids[0]);
  assert.equal(store.listJobCandidates(ORG, job.id).length, 1);

  // deleting the job removes its links but not the candidates
  store.deleteJob(ORG, job.id);
  assert.equal(store.getJob(ORG, job.id), null);
  assert.equal(store.listCandidates(ORG).length, 1);
});

test('jobs are org-isolated', () => {
  const other = auth.register('owner@other.test', 'longpassword', 'Other Co').org_id;
  const mine = store.createJob(ORG, { title: 'Mine' }, 'o@jobs.test');
  assert.equal(store.listJobs(other).length, 0);
  assert.equal(store.getJob(other, mine.id), null);
  assert.throws(() => store.addCandidatesToJob(other, mine.id, []), /not found/);
});
