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

const PAGE_SIZE = 50;

export default function Candidates() {
  const toast = useToast();
  const [candidates, setCandidates] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
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
  const [aiInfo, setAiInfo] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuery, setAiQuery] = useState('');
  const [aiSearch, setAiSearch] = useState(null);
  const aiOn = aiInfo && aiInfo.mode !== 'off';
  const [dupOpen, setDupOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (skill) params.set('skill', skill);
      if (stageFilter) params.set('stage', stageFilter);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const data = await api(`/api/candidates?${params.toString()}`);
      // defensive: tolerate an unexpected response shape (e.g. a version
      // mismatch serving HTML) and guarantee every row has meta, so a render
      // can never white-screen — degrade to empty + a visible error instead.
      setCandidates((data.candidates || []).map((c) => ({ ...c, meta: c.meta || { stage: 'new', tags: [], note: null } })));
      setTotal(data.total ?? (data.candidates || []).length);
      if (data.stages) setStages(data.stages);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query, skill, stageFilter, page]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing
    return () => clearTimeout(t);
  }, [load]);

  // Changing a filter returns to the first page.
  useEffect(() => { setPage(0); }, [query, skill, stageFilter]);

  useEffect(() => {
    api('/api/views').then((d) => setViews(d.views)).catch(() => {});
    api('/api/jd-templates').then((d) => setTemplates(d.templates)).catch(() => {});
    api('/api/ai/status').then(setAiInfo).catch(() => setAiInfo({ mode: 'off' }));
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

  async function runAiSearch() {
    if (!aiQuery.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/ai/search', { method: 'POST', body: { query: aiQuery } });
      setAiSearch(res);
      setMatch(null);
      setMatchOpen(false);
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

  async function seedDemo() {
    setBusy(true);
    try {
      const res = await api('/api/demo/seed', { method: 'POST' });
      toast(`Loaded ${res.totalCandidates} sample candidates`);
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
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

  const list = match ? match.results : aiSearch ? aiSearch.results : candidates;

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
        {aiOn && (
          <button className="ghost ai-btn" aria-pressed={aiOpen} onClick={() => { setAiOpen(!aiOpen); if (aiOpen) setAiSearch(null); setMatchOpen(false); setMatch(null); clearPicked(); }}>
            <span className="ai-spark" aria-hidden>✦</span> AI search
          </button>
        )}
        <button className="ghost" aria-pressed={matchOpen} onClick={() => { setMatchOpen(!matchOpen); setMatch(null); setAiOpen(false); setAiSearch(null); setDupOpen(false); clearPicked(); }}>match a JD</button>
        <button className="ghost" aria-pressed={dupOpen} onClick={() => { setDupOpen(!dupOpen); setMatchOpen(false); setMatch(null); setAiOpen(false); setAiSearch(null); clearPicked(); }}>
          review duplicates
        </button>
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

      {aiOpen && aiOn && (
        <div className="match-panel ai-panel">
          <div className="ai-search-row">
            <span className="ai-spark" aria-hidden>✦</span>
            <input
              className="search ai-search-input"
              placeholder="Describe who you're looking for — e.g. “senior backend engineers who've shipped payments and can mentor juniors”"
              value={aiQuery}
              onChange={(e) => setAiQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runAiSearch(); }}
              aria-label="natural-language candidate search"
            />
            <button className="run" onClick={runAiSearch} disabled={busy || !aiQuery.trim()}>{busy ? 'searching…' : 'Search'}</button>
            {aiSearch && <button className="linklike" onClick={() => { setAiSearch(null); setAiQuery(''); }}>clear</button>}
          </div>
          {aiSearch && (
            <div className="ai-parsed">
              <span className={`ai-badge ${aiSearch.mode}`}>
                {aiSearch.mode === 'live' ? `AI · ${aiSearch.model || ''}` : aiSearch.mode === 'mock' ? 'local draft · no AI key' : 'local fallback'}
              </span>
              <span className="ai-read">read as:</span>
              {aiSearch.parsed.skills.length > 0 && <span> skills <b>{aiSearch.parsed.skills.join(', ')}</b></span>}
              {aiSearch.parsed.minYears != null && <span> · <b>{aiSearch.parsed.minYears}+ yrs</b></span>}
              {aiSearch.parsed.roleWords.length > 0 && <span> · role <b>{aiSearch.parsed.roleWords.join(', ')}</b></span>}
              {aiSearch.parsed.location && <span> · in <b>{aiSearch.parsed.location}</b></span>}
              {aiSearch.parsed.keywords.length > 0 && <span> · terms <b>{aiSearch.parsed.keywords.join(', ')}</b></span>}
              {aiSearch.parsed.skills.length === 0 && aiSearch.parsed.roleWords.length === 0 &&
                aiSearch.parsed.keywords.length === 0 && aiSearch.parsed.minYears == null && <span> (no filters found — try naming skills or a role)</span>}
            </div>
          )}
          <p className="ai-note">Ranking is deterministic and explained per candidate — the AI only turns your words into a filter.</p>
        </div>
      )}

      {!match && !aiSearch && !dupOpen && picked.size > 0 && (
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

      {!match && !aiSearch && !dupOpen && total > PAGE_SIZE && (
        <div className="pager">
          <span className="pager-info">
            {page * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE + candidates.length)} of {total}
          </span>
          <span className="pager-btns">
            <button className="ghost sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>prev</button>
            <button className="ghost sm" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>next</button>
          </span>
        </div>
      )}

      {dupOpen ? (
        <DuplicatesPanel onChanged={load} />
      ) : (
      <div className="db-layout">
        <div className="db-list">
          {loading && !candidates.length ? (
            <SkeletonRows />
          ) : list.length === 0 ? (
            <div className="empty-state">
              {match ? (
                'No candidates matched — try a broader job description.'
              ) : aiSearch ? (
                'No candidates matched your search — try different words.'
              ) : (
                <>
                  No candidates yet — upload files above, or
                  <div style={{ marginTop: 14 }}>
                    <button className="run" onClick={seedDemo} disabled={busy}>
                      {busy ? 'loading…' : 'Load sample candidates'}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : aiSearch ? (
            aiSearch.results.map((r) => (
              <button
                key={r.candidate_id}
                className={`db-row ${selected === r.candidate_id ? 'active' : ''}`}
                onClick={() => setSelected(selected === r.candidate_id ? null : r.candidate_id)}
              >
                <span className="db-name">{r.full_name || '(unnamed)'}</span>
                <span className="db-sub">{r.why.slice(0, 2).join(' · ') || r.headline || '—'}</span>
                <span className="db-conf" style={{ color: confColor(r.relevance) }}>{r.relevance.toFixed(2)}</span>
              </button>
            ))
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
            aiMode={aiInfo ? aiInfo.mode : 'off'}
            jobText={matchOpen && jd.trim() ? jd : null}
            onChanged={load}
            onDeleted={() => { setSelected(null); load(); }}
          />
        )}
      </div>
      )}
    </section>
  );
}

// Duplicate review: candidate pairs the engine left apart because it wasn't
// sure. Confirm a merge (a human decision the resolver then honors), mark "not
// a match", or undo an earlier manual merge.
function DuplicatesPanel({ onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api('/api/merge/suggestions').then(setData).catch((e) => toast(e.message, 'bad'));
  }, [toast]);
  useEffect(load, [load]);

  async function act(key, path, body, msg) {
    setBusy(key);
    try {
      await api(path, { method: 'POST', body });
      if (msg) toast(msg);
      load();
      onChanged();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="dup-panel"><div className="skeleton sk-bar" /></div>;

  return (
    <div className="dup-panel">
      <p className="dup-lead">
        {data.suggestions.length === 0
          ? 'No likely duplicates — your pool looks clean.'
          : `${data.suggestions.length} possible duplicate${data.suggestions.length === 1 ? '' : 's'}. The engine kept these apart because it wasn't certain — you decide.`}
      </p>

      {data.suggestions.map((s) => (
        <div className="dup-card" key={s.pair_key}>
          <div className="dup-top">
            <span className="dup-score" style={{ color: confColor(s.score) }}>{Math.round(s.score * 100)}% match</span>
            <span className="dup-reasons">{s.reasons.join(' · ')}</span>
          </div>
          <div className="dup-pair">
            <DupSide c={s.a} />
            <span className="dup-vs">≟</span>
            <DupSide c={s.b} />
          </div>
          <div className="dup-actions">
            <button className="run sm" disabled={busy === s.pair_key} onClick={() => act(s.pair_key, '/api/merge', { a: s.a.candidate_id, b: s.b.candidate_id }, 'Candidates merged')}>
              {busy === s.pair_key ? 'merging…' : 'Merge'}
            </button>
            <button className="ghost sm" disabled={busy === s.pair_key} onClick={() => act(s.pair_key, '/api/merge/dismiss', { a: s.a.candidate_id, b: s.b.candidate_id }, 'Marked as different people')}>
              not a match
            </button>
          </div>
        </div>
      ))}

      {data.manual.length > 0 && (
        <div className="dup-manual">
          <div className="dup-sub">Manual merges</div>
          {data.manual.map((m) => (
            <div className="dup-manual-row" key={m.link_id}>
              <span>{(m.candidate && m.candidate.full_name) || '(unnamed)'} — {m.subjects} source{m.subjects === 1 ? '' : 's'} joined</span>
              <button className="linklike" disabled={busy === m.link_id} onClick={() => act(m.link_id, '/api/merge/undo', { link_id: m.link_id }, 'Merge undone')}>undo</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DupSide({ c }) {
  return (
    <div className="dup-side">
      <div className="dup-name">{c.full_name || '(unnamed)'}</div>
      <div className="dup-meta">{c.headline || '—'}</div>
      <div className="dup-meta">{c.emails[0] || 'no email'}{c.companies[0] ? ` · ${c.companies[0]}` : ''}</div>
      {c.top_skills.length > 0 && <div className="dup-skills">{c.top_skills.join(', ')}</div>}
      <div className="dup-cid">{c.candidate_id}</div>
    </div>
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

function Detail({ id, stages, matchResult, blind, aiMode, jobText, onChanged, onDeleted }) {
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

      {!hideIdentity && aiMode && aiMode !== 'off' && <AiAssist id={id} jobText={jobText} aiMode={aiMode} />}

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

// AI-written drafts for one candidate — a grounded brief, tailored
// interview questions, or a first-contact note. Every result is labeled by mode
// (live model, or a deterministic local draft) and is never written back into
// the record: these are drafts a recruiter reads and verifies.
function AiAssist({ id, jobText, aiMode }) {
  const toast = useToast();
  const [tab, setTab] = useState(null); // 'summary' | 'kit' | 'outreach'
  const [data, setData] = useState({}); // cached result per tab
  const [busy, setBusy] = useState(null);

  useEffect(() => { setTab(null); setData({}); setBusy(null); }, [id]);

  async function run(kind) {
    setTab(kind);
    if (data[kind]) return; // already generated — just show it
    setBusy(kind);
    try {
      const path = kind === 'summary' ? 'summary' : kind === 'kit' ? 'interview-kit' : 'outreach';
      const body = kind === 'summary' ? {} : (jobText ? { jd: jobText } : {});
      const res = await api(`/api/candidates/${id}/${path}`, { method: 'POST', body });
      setData((d) => ({ ...d, [kind]: res }));
    } catch (err) {
      toast(err.message, 'bad');
      setTab(null);
    } finally {
      setBusy(null);
    }
  }

  const active = tab ? data[tab] : null;

  return (
    <div className="ai-assist">
      <div className="ai-assist-head">
        <span className="ai-spark" aria-hidden>✦</span>
        <span className="ai-assist-title">AI assist</span>
        {aiMode !== 'live' && <span className="ai-ctx dim">local drafts</span>}
        {jobText && <span className="ai-ctx" title="the job description open in the match panel is used as context">JD context</span>}
      </div>
      <div className="ai-actions">
        <button className={`ghost sm ${tab === 'summary' ? 'on' : ''}`} onClick={() => run('summary')} disabled={busy === 'summary'}>{busy === 'summary' ? 'writing…' : 'Summarize'}</button>
        <button className={`ghost sm ${tab === 'kit' ? 'on' : ''}`} onClick={() => run('kit')} disabled={busy === 'kit'}>{busy === 'kit' ? 'writing…' : 'Interview kit'}</button>
        <button className={`ghost sm ${tab === 'outreach' ? 'on' : ''}`} onClick={() => run('outreach')} disabled={busy === 'outreach'}>{busy === 'outreach' ? 'writing…' : 'Outreach draft'}</button>
      </div>

      {active && (
        <div className="ai-out">
          <AiModeNote result={active} />
          {tab === 'summary' && <AiSummary d={active} />}
          {tab === 'kit' && <AiKit d={active} />}
          {tab === 'outreach' && <AiOutreach d={active} toast={toast} />}
        </div>
      )}
    </div>
  );
}

function AiModeNote({ result }) {
  const label = result.mode === 'live' ? `AI${result.model ? ` · ${result.model}` : ''}`
    : result.mode === 'mock' ? 'Local draft · no AI key configured'
    : 'Local draft · AI unavailable';
  return (
    <div className="ai-mode-note">
      <span className={`ai-badge ${result.mode}`}>{label}</span>
      <span className="ai-verify">AI-written draft — verify before use; nothing here changes the record.</span>
      {result.ai_error && <span className="ai-err" title={result.ai_error}>· fell back locally</span>}
    </div>
  );
}

function AiSummary({ d }) {
  return (
    <div>
      <p className="ai-summary">{d.summary}</p>
      {d.strengths && d.strengths.length > 0 && (
        <div className="ai-block">
          <div className="ai-sub">Strengths</div>
          <ul className="ai-list">{d.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {d.gaps && d.gaps.length > 0 && (
        <div className="ai-block">
          <div className="ai-sub">Probe / gaps</div>
          <ul className="ai-list">{d.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function AiKit({ d }) {
  return (
    <div>
      {(d.groups || []).map((g, i) => (
        <div className="ai-block" key={i}>
          <div className="ai-sub">{g.area}</div>
          <ol className="ai-qlist">{g.questions.map((q, j) => <li key={j}>{q}</li>)}</ol>
        </div>
      ))}
    </div>
  );
}

function AiOutreach({ d, toast }) {
  function copy() {
    const text = `Subject: ${d.subject || ''}\n\n${d.body || ''}`;
    navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard')).catch(() => {});
  }
  return (
    <div>
      {d.subject && <div className="ai-subject"><b>Subject:</b> {d.subject}</div>}
      <textarea className="ai-outreach" rows={7} readOnly value={d.body || ''} />
      <div><button className="ghost sm" onClick={copy}>copy</button></div>
    </div>
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
