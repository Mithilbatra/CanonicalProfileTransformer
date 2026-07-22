import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile } from './api';
import { useToast } from './Toast';
import { Meter, ConfTag, Provenance, provIndex, confColor, EMPTY, hasText, CountUp } from './bits';

// The persistent candidate database: upload sources, move candidates through
// the hiring pipeline, tag/annotate them, bulk-act on a selection, match
// against a job description (optionally bias-blind), and export.

const STAGE_LABEL = {
  new: 'New', screening: 'Screening', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected',
};

export default function Candidates() {
  const toast = useToast();
  const [candidates, setCandidates] = useState([]);
  const [stages, setStages] = useState([]);
  const [query, setQuery] = useState('');
  const [skill, setSkill] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [views, setViews] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enrich, setEnrich] = useState(true);
  const [matchOpen, setMatchOpen] = useState(false);
  const [jd, setJd] = useState('');
  const [blind, setBlind] = useState(false);
  const [match, setMatch] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (skill) params.set('skill', skill);
      if (stageFilter) params.set('stage', stageFilter);
      const qs = params.toString();
      const data = await api(`/api/candidates${qs ? '?' + qs : ''}`);
      setCandidates(data.candidates);
      if (data.stages) setStages(data.stages);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query, skill, stageFilter]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    api('/api/views').then((d) => setViews(d.views)).catch(() => {});
    api('/api/jd-templates').then((d) => setTemplates(d.templates)).catch(() => {});
  }, []);

  const clearPicked = () => setPicked(new Set());
  function togglePick(id) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('allowNetwork', String(enrich));
      const res = await api('/api/upload', { method: 'POST', formData: fd });
      setReport(res);
      toast(`Added ${res.subjectsAdded} record${res.subjectsAdded === 1 ? '' : 's'} · ${res.totalCandidates} candidates on file`);
      await load();
    } catch (err) {
      setError(err.message);
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  function exportAs(format) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (skill) params.set('skill', skill);
    if (stageFilter) params.set('stage', stageFilter);
    const qs = params.toString();
    downloadFile(`/api/export.${format}${qs ? '?' + qs : ''}`, `candidates.${format}`)
      .then(() => toast(`Exported ${format.toUpperCase()}`))
      .catch((e) => { setError(e.message); toast(e.message, 'bad'); });
  }

  async function saveCurrentView() {
    const name = window.prompt('Name this view (current search + skill + stage filter):');
    if (!name) return;
    try {
      await api('/api/views', { method: 'POST', body: { name, q: query || null, skill: skill || null } });
      setViews((await api('/api/views')).views);
      toast(`Saved view "${name}"`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function removeView(id) {
    try {
      await api(`/api/views/${id}`, { method: 'DELETE' });
      setViews((v) => v.filter((x) => x.id !== id));
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function runMatch() {
    if (!jd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setMatch(await api('/api/match', { method: 'POST', body: { jd, blind } }));
      clearPicked();
    } catch (err) {
      setError(err.message);
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    if (!jd.trim()) return;
    const name = window.prompt('Name this JD template:');
    if (!name) return;
    try {
      await api('/api/jd-templates', { method: 'POST', body: { name, jd } });
      setTemplates((await api('/api/jd-templates')).templates);
      toast(`Saved template "${name}"`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function removeTemplate(id) {
    try {
      await api(`/api/jd-templates/${id}`, { method: 'DELETE' });
      setTemplates((t) => t.filter((x) => x.id !== id));
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function bulkStage(stage) {
    try {
      const { updated } = await api('/api/candidates/bulk/stage', { method: 'POST', body: { ids: [...picked], stage } });
      toast(`Moved ${updated} candidate${updated === 1 ? '' : 's'} to ${STAGE_LABEL[stage]}`);
      clearPicked();
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function bulkDelete() {
    if (!window.confirm(`Delete ${picked.size} candidate${picked.size === 1 ? '' : 's'} and all their source data?`)) return;
    try {
      const { deleted } = await api('/api/candidates/bulk/delete', { method: 'POST', body: { ids: [...picked] } });
      toast(`Deleted ${deleted} candidate${deleted === 1 ? '' : 's'}`);
      if (selected && picked.has(selected)) setSelected(null);
      clearPicked();
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  const list = match ? match.results : candidates;

  return (
    <section className="db">
      <UploadZone onFiles={uploadFiles} busy={busy} enrich={enrich} setEnrich={setEnrich} />

      {report && (
        <div className="upload-report">
          {report.sources.map((s, i) => (
            <span key={i} className={`rep-item ${s.ok ? 'ok' : 'fail'}`} title={s.error || ''}>
              {s.source} · {s.ok ? `${s.subjects} subject${s.subjects === 1 ? '' : 's'}` : 'failed'}
            </span>
          ))}
          <span className="rep-item total">{report.totalCandidates} candidates in database</span>
        </div>
      )}
      {error && <div className="err-banner">{error}</div>}

      <div className="db-toolbar">
        <input className="search" placeholder="search name, email, company…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="search candidates" />
        <input className="search skill" placeholder="filter by skill (exact)" value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="filter by skill" />
        <select className="role-select" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} aria-label="filter by stage">
          <option value="">all stages</option>
          {stages.map((s) => <option key={s} value={s}>{STAGE_LABEL[s] || s}</option>)}
        </select>
        <button className="ghost" onClick={saveCurrentView} title="save the current filters as a named view">save view</button>
        <button className="ghost" aria-pressed={matchOpen} onClick={() => { setMatchOpen(!matchOpen); setMatch(null); clearPicked(); }}>match a JD</button>
        <span className="export-group">
          {['csv', 'xlsx', 'json'].map((f) => (
            <button key={f} className="ghost sm" onClick={() => exportAs(f)} disabled={!candidates.length}>{f}</button>
          ))}
        </span>
      </div>

      {views.length > 0 && (
        <div className="views-row">
          {views.map((v) => (
            <span key={v.id} className="view-chip">
              <button className="view-apply" onClick={() => { setQuery(v.q || ''); setSkill(v.skill || ''); }} title={`q: ${v.q || '—'} · skill: ${v.skill || '—'}`}>{v.name}</button>
              <button className="view-x" onClick={() => removeView(v.id)} aria-label={`delete view ${v.name}`}>×</button>
            </span>
          ))}
        </div>
      )}

      {matchOpen && (
        <div className="match-panel">
          <textarea
            rows={5}
            placeholder="Paste a job description. Required and nice-to-have skills, years of experience and role words are read from the text; every candidate gets an explainable score."
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            aria-label="job description"
          />
          {templates.length > 0 && (
            <div className="views-row" style={{ margin: '10px 0 0' }}>
              {templates.map((t) => (
                <span key={t.id} className="view-chip">
                  <button className="view-apply" onClick={() => setJd(t.jd)} title="load this template">{t.name}</button>
                  <button className="view-x" onClick={() => removeTemplate(t.id)} aria-label={`delete template ${t.name}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="match-actions">
            <button className="run" onClick={runMatch} disabled={busy || !jd.trim()}>{busy ? 'matching…' : 'Rank candidates'}</button>
            <button className="ghost" onClick={saveTemplate} disabled={!jd.trim()}>save as template</button>
            <label className="switch" title="hide names and locations in the ranked list, so screening is on merit only; identity never feeds the score">
              <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
              <span className="track" /> bias-blind
            </label>
            {match && (
              <span className="match-req">
                required: {match.requirements.required?.join(', ') || match.requirements.skills.join(', ') || 'none'}
                {match.requirements.niceToHave?.length ? ` · nice: ${match.requirements.niceToHave.join(', ')}` : ''}
                {match.requirements.minYears != null && ` · ${match.requirements.minYears}+ yrs`}
                {match.blind && ' · identity hidden'}
              </span>
            )}
          </div>
        </div>
      )}

      {!match && picked.size > 0 && (
        <div className="bulk-bar">
          <span className="bulk-count">{picked.size} selected</span>
          <span className="bulk-actions">
            <label className="bulk-stage">
              move to
              <select className="role-select" defaultValue="" onChange={(e) => { if (e.target.value) { bulkStage(e.target.value); e.target.value = ''; } }} aria-label="move selected to stage">
                <option value="" disabled>stage…</option>
                {stages.map((s) => <option key={s} value={s}>{STAGE_LABEL[s] || s}</option>)}
              </select>
            </label>
            <button className="ghost sm danger-ghost" onClick={bulkDelete}>delete</button>
            <button className="linklike" onClick={clearPicked}>clear</button>
          </span>
        </div>
      )}

      <div className="db-layout">
        <div className="db-list">
          {loading && !candidates.length ? (
            <SkeletonRows />
          ) : list.length === 0 ? (
            <div className="empty-state">
              {match ? 'No candidates matched — try a broader job description.' : 'No candidates yet — upload resumes, CSVs or ATS exports above.'}
            </div>
          ) : match ? (
            match.results.map((r) => (
              <button
                key={r.candidate_id}
                className={`db-row ${selected === r.candidate_id ? 'active' : ''}`}
                onClick={() => setSelected(selected === r.candidate_id ? null : r.candidate_id)}
              >
                <span className="db-name">{match.blind ? r.alias : (r.full_name || '(unnamed)')}</span>
                <span className="db-sub">
                  {r.matched.length}/{r.matched.length + r.missing.length} skills
                  {r.missing.length > 0 && ` · missing: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''}`}
                </span>
                <span className="db-conf" style={{ color: confColor(r.score) }}>{r.score.toFixed(2)}</span>
              </button>
            ))
          ) : (
            candidates.map((c) => (
              <div key={c.candidate_id} className={`db-row-wrap ${selected === c.candidate_id ? 'active' : ''}`}>
                <label className="db-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={picked.has(c.candidate_id)} onChange={() => togglePick(c.candidate_id)} aria-label={`select ${c.record.full_name || 'candidate'}`} />
                </label>
                <button className="db-row" onClick={() => setSelected(selected === c.candidate_id ? null : c.candidate_id)}>
                  <span className="db-name">
                    {c.record.full_name || c.record.emails[0] || '(unnamed)'}
                    <span className={`stage-badge s-${c.meta.stage}`}>{STAGE_LABEL[c.meta.stage] || c.meta.stage}</span>
                  </span>
                  <span className="db-sub">
                    {c.record.headline || '—'}
                    {c.meta.tags.length > 0 && <span className="row-tags"> · {c.meta.tags.slice(0, 2).join(', ')}{c.meta.tags.length > 2 ? '…' : ''}</span>}
                  </span>
                  <span className="db-conf" style={{ color: confColor(c.record.overall_confidence) }}>{c.record.overall_confidence.toFixed(2)}</span>
                </button>
              </div>
            ))
          )}
        </div>

        {selected && (
          <Detail
            id={selected}
            stages={stages}
            matchResult={match ? match.results.find((r) => r.candidate_id === selected) : null}
            blind={!!(match && match.blind)}
            onChanged={load}
            onDeleted={() => { setSelected(null); load(); }}
          />
        )}
      </div>
    </section>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="db-row skeleton-row" key={i}>
          <div className="skeleton sk-name" />
          <div className="skeleton sk-sub" />
        </div>
      ))}
    </>
  );
}

function UploadZone({ onFiles, busy, enrich, setEnrich }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  return (
    <div>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') inputRef.current?.click(); }}
      >
        <input ref={inputRef} type="file" multiple hidden accept=".csv,.json,.txt,.pdf,.docx,.png,.jpg,.jpeg"
          onChange={(e) => { onFiles([...e.target.files]); e.target.value = ''; }} />
        {busy ? 'processing…' : 'drop resumes (pdf/docx/photo), CSVs, ATS exports or notes here — or click to pick files'}
      </div>
      <label className="switch" style={{ marginTop: 8 }} title="follow GitHub profile links found in uploads and pull those profiles in as extra sources (needs network)">
        <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
        <span className="track" /> enrich from discovered GitHub links
      </label>
    </div>
  );
}

// Fields a recruiter can correct by hand, with how to read/write them as text.
const EDITABLE = {
  full_name: { parse: (s) => s.trim(), show: (v) => v || '' },
  headline: { parse: (s) => s.trim(), show: (v) => v || '' },
  years_experience: {
    parse: (s) => { const n = parseInt(s, 10); if (!Number.isInteger(n)) throw new Error('enter a whole number'); return n; },
    show: (v) => (v == null ? '' : String(v)),
  },
  emails: { parse: (s) => s.split(',').map((x) => x.trim()).filter(Boolean), show: (v) => (v || []).join(', ') },
  phones: { parse: (s) => s.split(',').map((x) => x.trim()).filter(Boolean), show: (v) => (v || []).join(', ') },
  location: {
    parse: (s) => {
      const [city, region, country] = s.split(',').map((x) => x.trim() || null);
      return s.trim() ? { city, region: region || null, country: country || null } : null;
    },
    show: (v) => (v ? [v.city, v.region, v.country].filter(Boolean).join(', ') : ''),
  },
};

const IDENTITY_FIELDS = ['full_name', 'emails', 'phones', 'location'];

function Detail({ id, stages, matchResult, blind, onChanged, onDeleted }) {
  const toast = useToast();
  const [candidate, setCandidate] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setRevealed(false); }, [id]);
  const hideIdentity = blind && !revealed;

  const refresh = useCallback(() => {
    api(`/api/candidates/${id}`).then(setCandidate).catch((e) => setError(e.message));
    api(`/api/candidates/${id}/suggestions`).then((d) => setSuggestions(d.suggestions)).catch(() => {});
  }, [id]);

  useEffect(refresh, [refresh]);

  if (error) return <div className="err-banner">{error}</div>;
  if (!candidate) return <div className="card detail"><div className="skeleton sk-detail" /></div>;

  const r = candidate.record;
  const fc = candidate.field_confidence;
  const meta = candidate.meta;
  const prov = provIndex(r.provenance);
  const overridden = (field) => (prov[field] || []).some((p) => p.source === 'human');

  async function save(field, value) {
    await api(`/api/candidates/${id}`, { method: 'PATCH', body: { field, value } });
    toast(`Updated ${field.replace('_', ' ')}`);
    refresh();
    onChanged();
  }

  async function reset(field) {
    await api(`/api/candidates/${id}/overrides/${field}`, { method: 'DELETE' });
    toast(`Reset ${field.replace('_', ' ')} to the merged value`, 'info');
    refresh();
    onChanged();
  }

  async function metaCall(path, body, msg) {
    try {
      const updated = await api(`/api/candidates/${id}/${path}`, { method: 'PUT', body });
      setCandidate(updated);
      if (msg) toast(msg);
      onChanged();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function remove() {
    const label = hideIdentity ? (matchResult ? matchResult.alias : 'this candidate') : (r.full_name || id);
    if (!window.confirm(`Delete ${label} and all its source data?`)) return;
    await api(`/api/candidates/${id}`, { method: 'DELETE' });
    toast('Candidate deleted', 'info');
    onDeleted();
  }

  return (
    <article className="card detail">
      <header className="card-head">
        <div>
          <h3 className="name">
            {hideIdentity ? (matchResult ? matchResult.alias : 'Hidden candidate') : (r.full_name || '(unnamed candidate)')}
          </h3>
          <div className="cid">{r.candidate_id}</div>
        </div>
        <div className="overall">
          <div className="ov-label">overall confidence</div>
          <div className="ov-num" style={{ color: confColor(r.overall_confidence) }}><CountUp value={r.overall_confidence} /></div>
          <Meter value={r.overall_confidence} />
        </div>
      </header>

      {!hideIdentity && (
        <Workflow
          meta={meta}
          stages={stages}
          onStage={(stage) => metaCall('stage', { stage }, `Moved to ${STAGE_LABEL[stage]}`)}
          onTags={(tags) => metaCall('tags', { tags })}
          onNote={(note) => metaCall('note', { note }, 'Note saved')}
        />
      )}

      {hideIdentity && (
        <div className="blind-banner">
          Identity hidden for unbiased review — name, contact and location are concealed while you assess the fit.
          <button className="ghost sm" onClick={() => setRevealed(true)}>reveal identity</button>
        </div>
      )}

      {matchResult && (
        <div className="match-detail">
          <div className="md-score">JD match: <b style={{ color: confColor(matchResult.score) }}>{matchResult.score.toFixed(2)}</b></div>
          {matchResult.parts.map((p, i) => (
            <div className="md-part" key={i}>
              <span className="md-name">{p.component} · {p.score.toFixed(2)}</span>
              <span className="md-why">{p.detail}</span>
            </div>
          ))}
        </div>
      )}

      {suggestions && (
        <AtsPanel score={r.overall_confidence} suggestions={suggestions} record={r} open={showSuggestions} onToggle={() => setShowSuggestions((s) => !s)} onSave={save} />
      )}

      <div className="fields">
        {Object.keys(EDITABLE)
          .filter((field) => !(hideIdentity && IDENTITY_FIELDS.includes(field)))
          .map((field) => (
            <EditableRow key={field} field={field} value={r[field]} confidence={fc[field]} prov={prov[field]} overridden={overridden(field)} onSave={save} onReset={reset} />
          ))}

        <div className="frow">
          <div className="fkey">skills</div>
          <div className="fval">
            {r.skills.length ? (
              <div className="skills">
                {r.skills.map((s, i) => (
                  <span className="skill" key={i} title={(s.sources || []).join(', ')}>
                    <span className="sname">{s.name}</span>
                    <Meter value={s.confidence} size="sm" />
                    <span className="sconf">{s.confidence.toFixed(2)}</span>
                  </span>
                ))}
              </div>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">experience</div>
          <div className="fval">
            {r.experience.length ? (
              <ul className="explist">
                {r.experience.map((e, i) => (
                  <li className="exp" key={i}>
                    <div className="e-top">
                      <span><span className="e-title">{e.title || '(role unknown)'}</span>{e.company && <span className="e-co"> · {e.company}</span>}</span>
                      <span className="e-when">{e.start || '?'} → {e.end || 'present'}</span>
                    </div>
                    {e.summary && <div className="e-sum">{e.summary}</div>}
                  </li>
                ))}
              </ul>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">education</div>
          <div className="fval">
            {r.education.length ? (
              <ul className="explist">
                {r.education.map((e, i) => (
                  <li className="exp edu" key={i}>
                    <div className="e-top">
                      <span><span className="e-title">{[e.degree, e.field].filter(Boolean).join(' ')}</span>{e.institution && <span className="e-co"> · {e.institution}</span>}</span>
                      <span className="e-when">{e.end_year || ''}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">projects</div>
          <div className="fval">
            {(r.projects || []).length ? (
              <ul className="explist">
                {r.projects.map((p, i) => (
                  <li className="exp" key={i}>
                    <div className="e-top"><span className="e-title">{p.name}</span></div>
                    {p.technologies.length > 0 && (
                      <div className="skills" style={{ marginTop: 5 }}>
                        {p.technologies.map((t, j) => (<span className="skill" key={j}><span className="sname">{t}</span></span>))}
                      </div>
                    )}
                    {p.summary && <div className="e-sum">{p.summary}</div>}
                  </li>
                ))}
              </ul>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">certifications</div>
          <div className="fval">
            {(r.certifications || []).length ? (
              <ul className="explist">
                {r.certifications.map((c, i) => (
                  <li className="exp" key={i}>
                    <div className="e-top"><span><span className="e-title">{c.name}</span>{c.issuer && <span className="e-co"> · {c.issuer}</span>}</span></div>
                    {c.summary && <div className="e-sum">{c.summary}</div>}
                  </li>
                ))}
              </ul>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">activities</div>
          <div className="fval">
            {(r.activities || []).length ? (
              <ul className="explist">{r.activities.map((a, i) => (<li className="exp" key={i}><div className="e-sum">{a}</div></li>))}</ul>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">coursework</div>
          <div className="fval">
            {(r.coursework || []).length ? (
              <div className="skills">{r.coursework.map((c, i) => (<span className="skill" key={i}><span className="sname">{c}</span></span>))}</div>
            ) : EMPTY}
          </div>
        </div>

        {!hideIdentity && (
          <div className="frow">
            <div className="fkey">links</div>
            <div className="fval">
              {r.links.github || r.links.linkedin || r.links.portfolio || r.links.other.length ? (
                <span className="v">
                  {['linkedin', 'github', 'portfolio'].filter((k) => r.links[k]).map((k) => (
                    <a key={k} href={r.links[k]} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>{k}</a>
                  ))}
                  {r.links.other.map((u, i) => (<a key={i} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>other</a>))}
                </span>
              ) : EMPTY}
            </div>
          </div>
        )}
      </div>

      <div className="rawbar">
        <button className="linklike danger" onClick={remove}>delete candidate</button>
      </div>
    </article>
  );
}

// Hiring-pipeline stage, tags, and a private note — the workflow layer on top
// of the merged record.
function Workflow({ meta, stages, onStage, onTags, onNote }) {
  const [tagDraft, setTagDraft] = useState('');
  const [note, setNoteDraft] = useState(meta.note || '');
  const noteChanged = (note || '') !== (meta.note || '');

  function addTag() {
    const t = tagDraft.trim();
    if (!t) return;
    if (!meta.tags.some((x) => x.toLowerCase() === t.toLowerCase())) onTags([...meta.tags, t]);
    setTagDraft('');
  }

  return (
    <div className="workflow">
      <div className="wf-stages" role="group" aria-label="pipeline stage">
        {stages.map((s) => (
          <button key={s} className={`wf-stage s-${s} ${meta.stage === s ? 'on' : ''}`} onClick={() => meta.stage !== s && onStage(s)} aria-pressed={meta.stage === s}>
            {STAGE_LABEL[s] || s}
          </button>
        ))}
      </div>

      <div className="wf-tags">
        {meta.tags.map((t) => (
          <span className="tag-chip" key={t}>{t}<button className="tag-x" onClick={() => onTags(meta.tags.filter((x) => x !== t))} aria-label={`remove tag ${t}`}>×</button></span>
        ))}
        <input
          className="tag-input"
          placeholder="+ tag"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          onBlur={addTag}
          aria-label="add a tag"
        />
      </div>

      <div className="wf-note">
        <textarea
          rows={2}
          placeholder="private note about this candidate…"
          value={note}
          onChange={(e) => setNoteDraft(e.target.value)}
          aria-label="private note"
        />
        {noteChanged && (
          <div className="wf-note-actions">
            <button className="ghost sm" onClick={() => onNote(note.trim() ? note : null)}>save note</button>
            <button className="linklike" onClick={() => setNoteDraft(meta.note || '')}>cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

function atsBand(score) {
  if (score >= 0.75) return { label: 'Strong', note: 'likely to clear automated screening' };
  if (score >= 0.5) return { label: 'Moderate', note: 'some gaps a screener may flag' };
  return { label: 'Needs work', note: 'key fields are missing or unverified' };
}

function AtsPanel({ score, suggestions, record, open, onToggle, onSave }) {
  const band = atsBand(score);
  const fixable = suggestions.filter((s) => s.field in EDITABLE).length;
  return (
    <div className="sugg">
      <button className="linklike" onClick={onToggle}>
        <span className="ats-head">
          ATS readiness: <b style={{ color: confColor(score) }}><CountUp value={score * 100} decimals={0} />/100 · {band.label}</b>
          {suggestions.length > 0 && <span className="ats-count"> — {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}{fixable ? `, ${fixable} fixable here` : ''}</span>}
        </span>
      </button>
      {open && (
        suggestions.length === 0 ? (
          <p className="ats-clean">Nothing flagged — every core field is present and corroborated.</p>
        ) : (
          <>
            <p className="ats-why">{band.note}. Fixes are saved as human-verified values and recompute the score.</p>
            <ul className="sugg-list">
              {suggestions.map((s, i) => (<SuggestionItem key={`${s.field}:${i}`} s={s} record={record} onSave={onSave} />))}
            </ul>
          </>
        )
      )}
    </div>
  );
}

function SuggestionItem({ s, record, onSave }) {
  const spec = EDITABLE[s.field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);

  function startFix() { setDraft(spec.show(record[s.field])); setEditing(true); setError(null); }
  async function commit() {
    try { await onSave(s.field, spec.parse(draft)); setEditing(false); }
    catch (err) { setError(err.message); }
  }

  return (
    <li className={`sugg-item ${s.severity}`}>
      <span className="sugg-dot" />
      <div className="sugg-body">
        <div>
          {s.message}
          {s.estimated_gain != null && <em className="sugg-gain"> ≈ +{s.estimated_gain.toFixed(2)} to the score</em>}
          {spec && !editing && (<button className="linklike edit-btn" onClick={startFix}>fix now</button>)}
        </div>
        {editing && (
          <div className="edit-line" style={{ marginTop: 6 }}>
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
              placeholder={s.field === 'location' ? 'City, Region, Country' : s.field} />
            <button className="ghost sm" onClick={commit}>save</button>
            <button className="ghost sm" onClick={() => setEditing(false)}>cancel</button>
          </div>
        )}
        {error && <div className="err-inline">{error}</div>}
      </div>
    </li>
  );
}

function EditableRow({ field, value, confidence, prov, overridden, onSave, onReset }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const spec = EDITABLE[field];

  async function commit() {
    try { await onSave(field, spec.parse(draft)); setEditing(false); setError(null); }
    catch (err) { setError(err.message); }
  }

  const display = spec.show(value);

  return (
    <div className="frow">
      <div className="fkey">{field}</div>
      <div className="fval">
        {editing ? (
          <div className="edit-line">
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
            <button className="ghost sm" onClick={commit}>save</button>
            <button className="ghost sm" onClick={() => { setEditing(false); setError(null); }}>cancel</button>
            {field === 'location' && <span className="edit-hint">city, region, country</span>}
            {(field === 'emails' || field === 'phones') && <span className="edit-hint">comma-separated</span>}
          </div>
        ) : (
          <span className="v">
            {hasText(display) ? display : EMPTY}
            <button className="linklike edit-btn" onClick={() => { setDraft(display); setEditing(true); }}>edit</button>
            {overridden && (
              <button className="linklike edit-btn" onClick={() => onReset(field)} title="discard the manual value and go back to the merged one">reset</button>
            )}
          </span>
        )}
        {error && <div className="err-inline">{error}</div>}
        <div className="fval-meta"><ConfTag value={confidence} /><Provenance entries={prov} /></div>
      </div>
    </div>
  );
}
