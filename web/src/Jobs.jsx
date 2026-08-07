import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useToast } from './Toast';
import { confColor } from './bits';

// Job requisitions: create a role with its JD, then run a per-job hiring
// pipeline. A candidate's stage here is scoped to the job (independent of
// their stage on other jobs and of the global candidate-database stage).

const STAGE_LABEL = {
  new: 'New', screening: 'Screening', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected',
};

export default function Jobs() {
  const toast = useToast();
  const [jobs, setJobs] = useState([]);
  const [stages, setStages] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [title, setTitle] = useState('');
  const [jd, setJd] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/api/jobs').then((d) => { setJobs(d.jobs); setStages(d.stages); }).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const job = await api('/api/jobs', { method: 'POST', body: { title, description: jd } });
      toast(`Created "${job.title}"`);
      setTitle(''); setJd('');
      load();
      setOpenId(job.id);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  if (openId) {
    return <JobBoard id={openId} stages={stages} onBack={() => { setOpenId(null); load(); }} />;
  }

  return (
    <section className="jobs">
      <form className="job-create" onSubmit={create}>
        <input className="search" placeholder="new job title — e.g. Senior Backend Engineer" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="job title" />
        <textarea rows={3} placeholder="paste the job description (used to match & rank candidates)…" value={jd} onChange={(e) => setJd(e.target.value)} aria-label="job description" />
        <button className="run" disabled={busy || !title.trim()}>{busy ? 'creating…' : 'Create job'}</button>
      </form>

      {error && <div className="err-banner">{error}</div>}

      {jobs.length === 0 ? (
        <div className="empty-state">No jobs yet — create your first requisition above.</div>
      ) : (
        <div className="job-grid">
          {jobs.map((j) => (
            <button key={j.id} className="job-card" onClick={() => setOpenId(j.id)}>
              <div className="jc-top">
                <span className="jc-title">{j.title}</span>
                <span className={`job-status ${j.status}`}>{j.status}</span>
              </div>
              <div className="jc-sub">{j.candidate_count} candidate{j.candidate_count === 1 ? '' : 's'}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function JobBoard({ id, stages, onBack }) {
  const toast = useToast();
  const [job, setJob] = useState(null);
  const [rows, setRows] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api(`/api/jobs/${id}`).then(setJob).catch((e) => setError(e.message));
    api(`/api/jobs/${id}/candidates`).then((d) => setRows(d.candidates)).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  async function move(cid, stage) {
    setRows((rs) => rs.map((r) => (r.candidate_id === cid ? { ...r, job_stage: stage } : r))); // optimistic
    try {
      await api(`/api/jobs/${id}/candidates/${cid}/stage`, { method: 'PUT', body: { stage } });
    } catch (err) {
      toast(err.message, 'bad');
      load();
    }
  }

  async function remove(cid) {
    try {
      await api(`/api/jobs/${id}/candidates/${cid}`, { method: 'DELETE' });
      setRows((rs) => rs.filter((r) => r.candidate_id !== cid));
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function toggleStatus() {
    const next = job.status === 'open' ? 'closed' : 'open';
    try {
      setJob(await api(`/api/jobs/${id}`, { method: 'PATCH', body: { status: next } }));
      toast(`Job ${next}`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function del() {
    if (!window.confirm(`Delete the job "${job.title}"? Candidates stay in the database.`)) return;
    try {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      toast('Job deleted', 'info');
      onBack();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  if (error) return <div className="err-banner">{error}</div>;
  if (!job) return <div className="jobs"><div className="skeleton sk-detail" /></div>;

  const onJob = new Set(rows.map((r) => r.candidate_id));

  return (
    <section className="jobs">
      <div className="board-head">
        <button className="linklike" onClick={onBack}>← all jobs</button>
        <div className="bh-main">
          <h2 className="bh-title">{job.title} <span className={`job-status ${job.status}`}>{job.status}</span></h2>
          <div className="bh-actions">
            <button className="ghost sm" onClick={() => setAdding((a) => !a)} aria-pressed={adding}>add candidates</button>
            <button className="ghost sm" onClick={toggleStatus}>{job.status === 'open' ? 'close job' : 'reopen'}</button>
            <button className="ghost sm danger-ghost" onClick={del}>delete</button>
          </div>
        </div>
        {job.description && <p className="bh-jd">{job.description}</p>}
      </div>

      {adding && <AddPanel id={id} onJob={onJob} onAdded={() => { setAdding(false); load(); }} />}

      <div className="board">
        {stages.map((s) => {
          const cards = rows.filter((r) => r.job_stage === s);
          return (
            <div className="board-col" key={s}>
              <div className="col-head">{STAGE_LABEL[s] || s}<span className="col-count">{cards.length}</span></div>
              <div className="col-body">
                {cards.map((r) => (
                  <div className="job-cand" key={r.candidate_id}>
                    <div className="jcand-top">
                      <span className="jcand-name">{r.record.full_name || r.record.emails?.[0] || '(unnamed)'}</span>
                      <button className="jcand-x" onClick={() => remove(r.candidate_id)} aria-label="remove from job">×</button>
                    </div>
                    <div className="jcand-sub">{r.record.headline || '—'}</div>
                    <div className="jcand-foot">
                      <span className="jcand-conf" style={{ color: confColor(r.record.overall_confidence) }}>{r.record.overall_confidence.toFixed(2)}</span>
                      <select className="jcand-stage" value={r.job_stage} onChange={(e) => move(r.candidate_id, e.target.value)} aria-label="stage">
                        {stages.map((st) => <option key={st} value={st}>{STAGE_LABEL[st] || st}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
                {cards.length === 0 && <div className="col-empty">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Rank the whole pool against this job's JD and add the ones you pick.
function AddPanel({ id, onJob, onAdded }) {
  const toast = useToast();
  const [results, setResults] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setBusy(true);
    api(`/api/jobs/${id}/match`, { method: 'POST', body: { blind } })
      .then((d) => setResults(d.results))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [id, blind]);

  function toggle(cid) {
    setPicked((p) => { const n = new Set(p); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  }

  async function add() {
    if (!picked.size) return;
    try {
      const { added } = await api(`/api/jobs/${id}/candidates`, { method: 'POST', body: { ids: [...picked] } });
      toast(`Added ${added} candidate${added === 1 ? '' : 's'} to the job`);
      onAdded();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="add-panel">
      <div className="ap-head">
        <span>Ranked against this job's description — pick who to add.</span>
        <label className="switch" title="hide identity while choosing, so screening is on merit">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          <span className="track" /> bias-blind
        </label>
      </div>
      {error && <div className="err-banner">{error}</div>}
      {busy || !results ? (
        <div className="skeleton sk-bar" />
      ) : (
        <>
          <div className="ap-list">
            {results.filter((r) => !onJob.has(r.candidate_id)).map((r) => (
              <label key={r.candidate_id} className="ap-row">
                <input type="checkbox" checked={picked.has(r.candidate_id)} onChange={() => toggle(r.candidate_id)} />
                <span className="ap-name">{blind ? r.alias : (r.full_name || '(unnamed)')}</span>
                <span className="ap-detail">{r.matched.length}/{r.matched.length + r.missing.length} skills</span>
                <span className="ap-score" style={{ color: confColor(r.score) }}>{r.score.toFixed(2)}</span>
              </label>
            ))}
            {results.filter((r) => !onJob.has(r.candidate_id)).length === 0 && <div className="col-empty">every candidate is already on this job</div>}
          </div>
          <button className="run" onClick={add} disabled={!picked.size}>Add {picked.size || ''} to job</button>
        </>
      )}
    </div>
  );
}
