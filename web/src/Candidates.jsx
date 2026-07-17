import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile } from './api';
import { Meter, ConfTag, Provenance, provIndex, confColor, EMPTY, hasText } from './bits';

// The persistent candidate database: upload source files (optionally
// enriching from discovered GitHub links), browse/search the resolved
// profiles, match them against a job description, correct fields by hand,
// save filter views, and export as CSV / XLSX / JSON.

export default function Candidates() {
  const [candidates, setCandidates] = useState([]);
  const [query, setQuery] = useState('');
  const [skill, setSkill] = useState('');
  const [views, setViews] = useState([]);
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
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
      const qs = params.toString();
      const data = await api(`/api/candidates${qs ? '?' + qs : ''}`);
      setCandidates(data.candidates);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [query, skill]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    api('/api/views').then((d) => setViews(d.views)).catch(() => {});
  }, []);

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
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function exportAs(format) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (skill) params.set('skill', skill);
    const qs = params.toString();
    downloadFile(`/api/export.${format}${qs ? '?' + qs : ''}`, `candidates.${format}`).catch((e) => setError(e.message));
  }

  async function saveCurrentView() {
    const name = window.prompt('Name this view (current search + skill filter):');
    if (!name) return;
    try {
      await api('/api/views', { method: 'POST', body: { name, q: query || null, skill: skill || null } });
      setViews((await api('/api/views')).views);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeView(id) {
    try {
      await api(`/api/views/${id}`, { method: 'DELETE' });
      setViews((v) => v.filter((x) => x.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function runMatch() {
    if (!jd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setMatch(await api('/api/match', { method: 'POST', body: { jd, blind } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

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
        <input
          className="search"
          placeholder="search name, email, company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          className="search skill"
          placeholder="filter by skill (exact)"
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
        />
        <button className="ghost" onClick={saveCurrentView} title="save the current search + skill filter as a named view">save view</button>
        <button className="ghost" aria-pressed={matchOpen} onClick={() => { setMatchOpen(!matchOpen); setMatch(null); }}>
          match a JD
        </button>
        <span className="export-group">
          {['csv', 'xlsx', 'json'].map((f) => (
            <button key={f} className="ghost sm" onClick={() => exportAs(f)} disabled={!candidates.length}>
              {f}
            </button>
          ))}
        </span>
      </div>

      {views.length > 0 && (
        <div className="views-row">
          {views.map((v) => (
            <span key={v.id} className="view-chip">
              <button className="view-apply" onClick={() => { setQuery(v.q || ''); setSkill(v.skill || ''); }} title={`q: ${v.q || '—'} · skill: ${v.skill || '—'}`}>
                {v.name}
              </button>
              <button className="view-x" onClick={() => removeView(v.id)} aria-label={`delete view ${v.name}`}>×</button>
            </span>
          ))}
        </div>
      )}

      {matchOpen && (
        <div className="match-panel">
          <textarea
            rows={5}
            placeholder="Paste a job description. Skills, years of experience and role words are read from the text; every candidate gets an explainable score."
            value={jd}
            onChange={(e) => setJd(e.target.value)}
          />
          <div className="match-actions">
            <button className="run" onClick={runMatch} disabled={busy || !jd.trim()}>
              {busy ? 'matching…' : 'Rank candidates'}
            </button>
            <label className="switch" title="hide names and locations in the ranked list, so screening is on merit only; identity never feeds the score">
              <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
              <span className="track" /> bias-blind
            </label>
            {match && (
              <span className="match-req">
                recognized — skills: {match.requirements.skills.join(', ') || 'none'}
                {match.requirements.minYears != null && ` · ${match.requirements.minYears}+ years`}
                {match.blind && ' · identity hidden'}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="db-layout">
        <div className="db-list">
          {(match ? match.results : candidates).length === 0 && (
            <div className="empty-state">No candidates yet — upload resumes, CSVs or ATS exports above.</div>
          )}
          {match
            ? match.results.map((r) => (
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
            : candidates.map((c) => (
                <button
                  key={c.candidate_id}
                  className={`db-row ${selected === c.candidate_id ? 'active' : ''}`}
                  onClick={() => setSelected(selected === c.candidate_id ? null : c.candidate_id)}
                >
                  <span className="db-name">{c.record.full_name || c.record.emails[0] || '(unnamed)'}</span>
                  <span className="db-sub">{c.record.headline || '—'}</span>
                  <span className="db-conf" style={{ color: confColor(c.record.overall_confidence) }}>
                    {c.record.overall_confidence.toFixed(2)}
                  </span>
                </button>
              ))}
        </div>

        {selected && (
          <Detail
            id={selected}
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

function UploadZone({ onFiles, busy, enrich, setEnrich }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  return (
    <div>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles([...e.dataTransfer.files]);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') inputRef.current?.click(); }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept=".csv,.json,.txt,.pdf,.docx,.png,.jpg,.jpeg"
          onChange={(e) => { onFiles([...e.target.files]); e.target.value = ''; }}
        />
        {busy
          ? 'processing…'
          : 'drop resumes (pdf/docx/photo), CSVs, ATS exports or notes here — or click to pick files'}
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

// Identity-bearing fields, hidden while reviewing bias-blind until revealed.
const IDENTITY_FIELDS = ['full_name', 'emails', 'phones', 'location'];

function Detail({ id, matchResult, blind, onChanged, onDeleted }) {
  const [candidate, setCandidate] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(null);

  // a fresh selection starts hidden again
  useEffect(() => { setRevealed(false); }, [id]);
  const hideIdentity = blind && !revealed;

  const refresh = useCallback(() => {
    api(`/api/candidates/${id}`).then(setCandidate).catch((e) => setError(e.message));
    api(`/api/candidates/${id}/suggestions`).then((d) => setSuggestions(d.suggestions)).catch(() => {});
  }, [id]);

  useEffect(refresh, [refresh]);

  if (error) return <div className="err-banner">{error}</div>;
  if (!candidate) return null;

  const r = candidate.record;
  const fc = candidate.field_confidence;
  const prov = provIndex(r.provenance);
  const overridden = (field) => (prov[field] || []).some((p) => p.source === 'human');

  async function save(field, value) {
    await api(`/api/candidates/${id}`, { method: 'PATCH', body: { field, value } });
    refresh(); // record and suggestions both change
    onChanged();
  }

  async function reset(field) {
    await api(`/api/candidates/${id}/overrides/${field}`, { method: 'DELETE' });
    refresh();
    onChanged();
  }

  async function remove() {
    const label = hideIdentity ? (matchResult ? matchResult.alias : 'this candidate') : (r.full_name || id);
    if (!window.confirm(`Delete ${label} and all its source data?`)) return;
    await api(`/api/candidates/${id}`, { method: 'DELETE' });
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
          <div className="ov-num" style={{ color: confColor(r.overall_confidence) }}>
            {r.overall_confidence.toFixed(2)}
          </div>
          <Meter value={r.overall_confidence} />
        </div>
      </header>

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
        <AtsPanel
          score={r.overall_confidence}
          suggestions={suggestions}
          record={r}
          open={showSuggestions}
          onToggle={() => setShowSuggestions((s) => !s)}
          onSave={save}
        />
      )}

      <div className="fields">
        {Object.keys(EDITABLE)
          .filter((field) => !(hideIdentity && IDENTITY_FIELDS.includes(field)))
          .map((field) => (
            <EditableRow
              key={field}
              field={field}
              value={r[field]}
              confidence={fc[field]}
              prov={prov[field]}
              overridden={overridden(field)}
              onSave={save}
              onReset={reset}
            />
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
                      <span>
                        <span className="e-title">{e.title || '(role unknown)'}</span>
                        {e.company && <span className="e-co"> · {e.company}</span>}
                      </span>
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
                      <span>
                        <span className="e-title">{[e.degree, e.field].filter(Boolean).join(' ')}</span>
                        {e.institution && <span className="e-co"> · {e.institution}</span>}
                      </span>
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
                    <div className="e-top">
                      <span className="e-title">{p.name}</span>
                    </div>
                    {p.technologies.length > 0 && (
                      <div className="skills" style={{ marginTop: 5 }}>
                        {p.technologies.map((t, j) => (
                          <span className="skill" key={j}><span className="sname">{t}</span></span>
                        ))}
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
                    <div className="e-top">
                      <span>
                        <span className="e-title">{c.name}</span>
                        {c.issuer && <span className="e-co"> · {c.issuer}</span>}
                      </span>
                    </div>
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
              <ul className="explist">
                {r.activities.map((a, i) => (
                  <li className="exp" key={i}><div className="e-sum">{a}</div></li>
                ))}
              </ul>
            ) : EMPTY}
          </div>
        </div>

        <div className="frow">
          <div className="fkey">coursework</div>
          <div className="fval">
            {(r.coursework || []).length ? (
              <div className="skills">
                {r.coursework.map((c, i) => (
                  <span className="skill" key={i}><span className="sname">{c}</span></span>
                ))}
              </div>
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
                  {r.links.other.map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>other</a>
                  ))}
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

// ATS-readiness panel: the overall confidence reframed as how completely and
// reliably an automated screen would read this profile, plus the concrete
// gaps behind that number. Suggestions whose field can be corrected inline
// (headline, location, years, emails, phones) carry a "Fix" action, so a
// candidate improves the profile from here and watches the score move.
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
          ATS readiness: <b style={{ color: confColor(score) }}>{Math.round(score * 100)}/100 · {band.label}</b>
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
              {suggestions.map((s, i) => (
                <SuggestionItem key={`${s.field}:${i}`} s={s} record={record} onSave={onSave} />
              ))}
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

  function startFix() {
    setDraft(spec.show(record[s.field]));
    setEditing(true);
    setError(null);
  }
  async function commit() {
    try {
      await onSave(s.field, spec.parse(draft));
      setEditing(false); // the record refreshes; this suggestion drops off the list
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <li className={`sugg-item ${s.severity}`}>
      <span className="sugg-dot" />
      <div className="sugg-body">
        <div>
          {s.message}
          {s.estimated_gain != null && <em className="sugg-gain"> ≈ +{s.estimated_gain.toFixed(2)} to the score</em>}
          {spec && !editing && (
            <button className="linklike edit-btn" onClick={startFix}>fix now</button>
          )}
        </div>
        {editing && (
          <div className="edit-line" style={{ marginTop: 6 }}>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
              placeholder={s.field === 'location' ? 'City, Region, Country' : s.field}
            />
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
    try {
      await onSave(field, spec.parse(draft));
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  const display = spec.show(value);

  return (
    <div className="frow">
      <div className="fkey">{field}</div>
      <div className="fval">
        {editing ? (
          <div className="edit-line">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <button className="ghost sm" onClick={commit}>save</button>
            <button className="ghost sm" onClick={() => { setEditing(false); setError(null); }}>cancel</button>
            {field === 'location' && <span className="edit-hint">city, region, country</span>}
            {(field === 'emails' || field === 'phones') && <span className="edit-hint">comma-separated</span>}
          </div>
        ) : (
          <span className="v">
            {hasText(display) ? display : EMPTY}
            <button className="linklike edit-btn" onClick={() => { setDraft(display); setEditing(true); }}>
              edit
            </button>
            {overridden && (
              <button className="linklike edit-btn" onClick={() => onReset(field)} title="discard the manual value and go back to the merged one">
                reset
              </button>
            )}
          </span>
        )}
        {error && <div className="err-inline">{error}</div>}
        <div className="fval-meta">
          <ConfTag value={confidence} />
          <Provenance entries={prov} />
        </div>
      </div>
    </div>
  );
}
