import { useEffect, useMemo, useState } from 'react';

function confColor(c) {
  if (c == null) return 'var(--c-null)';
  if (c >= 0.75) return 'var(--c-high)';
  if (c >= 0.45) return 'var(--c-mid)';
  return 'var(--c-low)';
}
function Meter({ value, size }) {
  const segs = 5;
  const on = value == null ? 0 : Math.max(1, Math.round(value * segs));
  const color = confColor(value);
  return (
    <span className={`meter ${size === 'sm' ? 'sm' : ''}`} style={{ '--mc': color }} aria-hidden="true">
      {Array.from({ length: segs }).map((_, i) => (
        <i key={i} className={i < on ? 'on' : ''} />
      ))}
    </span>
  );
}

function ConfTag({ value }) {
  if (value == null) return null;
  return (
    <span className="conf-tag" title={`confidence ${value}`}>
      <Meter value={value} size="sm" />
      {value.toFixed(2)}
    </span>
  );
}

function provIndex(provenance = []) {
  const idx = {};
  for (const p of provenance) {
    const base = String(p.field).split('[')[0];
    (idx[base] = idx[base] || []).push(p);
  }
  return idx;
}

function Provenance({ entries }) {
  if (!entries || !entries.length) return null;
  const seen = new Set();
  const uniq = entries.filter((e) => {
    const k = e.source + '|' + e.method;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <span className="prov">
      {uniq.map((e, i) => (
        <span className="ptag" key={i} title={e.method}>
          <b>{e.source}</b> · {e.method}
        </span>
      ))}
    </span>
  );
}

const EMPTY = <span className="v empty">— empty</span>;

function FieldRow({ label, children, confidence, prov }) {
  return (
    <div className="frow">
      <div className="fkey">{label}</div>
      <div className="fval">
        {children}
        {(confidence != null || (prov && prov.length)) && (
          <div className="fval-meta">
            <ConfTag value={confidence} />
            <Provenance entries={prov} />
          </div>
        )}
      </div>
    </div>
  );
}

function hasText(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function CanonicalCard({ profile }) {
  const o = profile.output;
  const [showRaw, setShowRaw] = useState(false);
  const fc = o.field_confidence || {};
  const prov = provIndex(o.provenance);
  const isCanonical =
    'emails' in o && 'experience' in o && Array.isArray(o.skills) &&
    (o.skills.length === 0 || typeof o.skills[0] === 'object');

  const overall = o.overall_confidence;

  return (
    <article className="card">
      <header className="card-head">
        <div>
          <h3 className="name">{o.full_name || o.primary_email || '(unnamed candidate)'}</h3>
          {o.candidate_id && <div className="cid">{o.candidate_id}</div>}
          <div style={{ marginTop: 8 }}>
            <span className={`valid ${profile.canonical_valid ? 'ok' : 'bad'}`}>
              {profile.canonical_valid ? '✓ canonical valid' : '✗ canonical: ' + (profile.canonical_errors || []).join('; ')}
            </span>{' '}
            <span className={`valid ${profile.projection_valid ? 'ok' : 'bad'}`}>
              {profile.projection_valid ? '✓ projection valid' : '✗ projection: ' + (profile.projection_errors || []).join('; ')}
            </span>
          </div>
        </div>
        {overall != null && (
          <div className="overall">
            <div className="ov-label">overall confidence</div>
            <div className="ov-num" style={{ color: confColor(overall) }}>{overall.toFixed(2)}</div>
            <Meter value={overall} />
          </div>
        )}
      </header>

      <div className="fields">
        {isCanonical ? (
          <>
            <FieldRow label="full_name" confidence={fc.full_name} prov={prov.full_name}>
              <span className="v">{hasText(o.full_name) ? o.full_name : EMPTY}</span>
            </FieldRow>

            <FieldRow label="headline" confidence={fc.headline} prov={prov.headline}>
              <span className="v">{hasText(o.headline) ? o.headline : EMPTY}</span>
            </FieldRow>

            <FieldRow label="years_exp" confidence={fc.years_experience} prov={prov.years_experience}>
              <span className="v">{o.years_experience != null ? o.years_experience : EMPTY}</span>
            </FieldRow>

            <FieldRow label="emails" confidence={fc.emails} prov={prov.emails}>
              <span className="v">{o.emails && o.emails.length ? o.emails.join(', ') : EMPTY}</span>
            </FieldRow>

            <FieldRow label="phones" confidence={fc.phones} prov={prov.phones}>
              <span className="v">{o.phones && o.phones.length ? o.phones.join(', ') : EMPTY}</span>
            </FieldRow>

            <FieldRow label="location" confidence={fc.location} prov={prov.location}>
              <span className="v">
                {o.location && (o.location.city || o.location.region || o.location.country)
                  ? [o.location.city, o.location.region, o.location.country].filter(Boolean).join(', ')
                  : EMPTY}
              </span>
            </FieldRow>

            <FieldRow label="links" prov={prov.links}>
              {o.links && (o.links.linkedin || o.links.github || o.links.portfolio || (o.links.other || []).length) ? (
                <span className="v">
                  {['linkedin', 'github', 'portfolio'].filter((k) => o.links[k]).map((k) => (
                    <span key={k} style={{ marginRight: 12 }}>
                      <a href={o.links[k]} target="_blank" rel="noreferrer">{k}</a>
                    </span>
                  ))}
                  {(o.links.other || []).map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>other</a>
                  ))}
                </span>
              ) : EMPTY}
            </FieldRow>

            <FieldRow label="skills" confidence={fc.skills} prov={prov.skills}>
              {o.skills && o.skills.length ? (
                <div className="skills">
                  {o.skills.map((s, i) => (
                    <span className="skill" key={i} title={(s.sources || []).join(', ')}>
                      <span className={'sname' + (s.known === false ? ' unknown' : '')}>{s.name}</span>
                      <Meter value={s.confidence} size="sm" />
                      <span className="sconf">{s.confidence != null ? s.confidence.toFixed(2) : ''}</span>
                    </span>
                  ))}
                </div>
              ) : EMPTY}
            </FieldRow>

            <FieldRow label="experience" confidence={fc.experience} prov={prov.experience}>
              {o.experience && o.experience.length ? (
                <ul className="explist">
                  {o.experience.map((e, i) => (
                    <li className="exp" key={i}>
                      <div className="e-top">
                        <span>
                          <span className="e-title">{e.title || '(role unknown)'}</span>
                          {e.company && <span className="e-co"> · {e.company}</span>}
                        </span>
                        <span className="e-when">{(e.start || '?')}{' → '}{e.end || 'present'}</span>
                      </div>
                      {e.summary && <div className="e-sum">{e.summary}</div>}
                    </li>
                  ))}
                </ul>
              ) : EMPTY}
            </FieldRow>

            <FieldRow label="education" confidence={fc.education} prov={prov.education}>
              {o.education && o.education.length ? (
                <ul className="explist">
                  {o.education.map((e, i) => (
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
            </FieldRow>
          </>
        ) : (
          Object.entries(o)
            .filter(([k]) => !['overall_confidence', 'field_confidence', 'provenance'].includes(k))
            .map(([k, v]) => {
              let display;
              if (v == null || (Array.isArray(v) && !v.length)) display = EMPTY;
              else if (Array.isArray(v)) display = <span className="v">{v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v)}</span>;
              else if (typeof v === 'object') display = <span className="v">{[v.city, v.region, v.country].some(Boolean) ? [v.city, v.region, v.country].filter(Boolean).join(', ') : JSON.stringify(v)}</span>;
              else display = <span className="v">{String(v)}</span>;
              return (
                <FieldRow key={k} label={k} confidence={fc[k]}>
                  {display}
                </FieldRow>
              );
            })
        )}
      </div>

      <div className="rawbar">
        <button className="linklike" onClick={() => setShowRaw((s) => !s)}>
          {showRaw ? 'hide raw json' : 'view raw json'}
        </button>
      </div>
      {showRaw && <pre className="raw">{JSON.stringify(o, null, 2)}</pre>}
    </article>
  );
}

const SOURCE_NOTE = {
  'recruiter.csv': 'structured · recruiter export',
  'ats.json': 'structured · ATS, foreign field names',
  'github.json': 'unstructured · public profile + repo languages',
  'recruiter_notes.txt': 'unstructured · free text, lowest trust',
  'broken.json': 'deliberately malformed — should fail gracefully',
};

export default function App() {
  const [samples, setSamples] = useState(null);
  const [picked, setPicked] = useState({});
  const [configKey, setConfigKey] = useState('default');
  const [provOn, setProvOn] = useState(true);
  const [confOn, setConfOn] = useState(true);
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/samples')
      .then((r) => r.json())
      .then((d) => {
        setSamples(d);
        const init = {};
        d.sources.forEach((s) => { init[s.name] = true; });
        setPicked(init);
      })
      .catch((e) => setError('Could not load sample inputs. Is the API running on :4000? ' + e.message));
  }, []);

  const config = useMemo(() => {
    if (!samples) return null;
    const base = configKey === 'default' ? samples.configs.default : samples.configs.recruiter_shortlist;
    return { ...base, include_provenance: provOn, include_confidence: confOn, include_field_confidence: confOn };
  }, [samples, configKey, provOn, confOn]);

  async function run() {
    if (!samples) return;
    setBusy(true);
    setError(null);
    try {
      const sources = samples.sources.filter((s) => picked[s.name]).map((s) => ({ name: s.name, content: s.content }));
      const res = await fetch('/api/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, config, allowNetwork }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'request failed');
      setResult(data);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="wrap">
        <header className="masthead">
          <p className="eyebrow">canonical profile transformer</p>
          <h1>Many messy sources in. One profile you can <em>trust</em> out.</h1>
          <p>
            Feed conflicting recruiter, ATS, GitHub and free-text records for the same people. The engine resolves who
            is who, normalizes every value, and returns one canonical profile per candidate — each field carrying where
            it came from and how confident the merge is. Nothing is invented; a true unknown stays empty.
          </p>
        </header>

        <section className="controls" aria-label="run controls">
          <div>
            <p className="ctrl-label">sources to feed</p>
            <div className="src-toggles">
              {samples?.sources.map((s) => (
                <button
                  key={s.name}
                  className="chip-toggle"
                  aria-pressed={!!picked[s.name]}
                  onClick={() => setPicked((p) => ({ ...p, [s.name]: !p[s.name] }))}
                  title={SOURCE_NOTE[s.name] || ''}
                >
                  <span className="dot" />
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="ctrl-label">output config</p>
            <div className="opt-row" style={{ marginBottom: 14 }}>
              <div className="seg" role="group" aria-label="config preset">
                <button aria-pressed={configKey === 'default'} onClick={() => setConfigKey('default')}>default schema</button>
                <button aria-pressed={configKey === 'shortlist'} onClick={() => setConfigKey('shortlist')}>recruiter_shortlist</button>
              </div>
            </div>
            <div className="opt-row">
              <label className="switch">
                <input type="checkbox" checked={confOn} onChange={(e) => setConfOn(e.target.checked)} />
                <span className="track" /> confidence
              </label>
              <label className="switch">
                <input type="checkbox" checked={provOn} onChange={(e) => setProvOn(e.target.checked)} />
                <span className="track" /> provenance
              </label>
              <label className="switch" title="github.json is a pre-fetched blob and needs no network; enable only to fetch a live handle">
                <input type="checkbox" checked={allowNetwork} onChange={(e) => setAllowNetwork(e.target.checked)} />
                <span className="track" /> allow network
              </label>
            </div>
            <div className="runbar">
              <button className="run" onClick={run} disabled={busy || !samples}>
                {busy ? 'transforming…' : 'Run transform'}
              </button>
              <span className="run-note">{configKey === 'default' ? 'full canonical schema' : '7 reshaped fields, remapped paths'}</span>
            </div>
          </div>
        </section>

        {error && <div className="err-banner">{error}</div>}

        <section className="results">
          <aside className="ledger">
            <h2>source ledger</h2>
            {(result?.sources || []).length === 0 && (
              <div className="ledger-item"><div className="li-name">no run yet</div></div>
            )}
            {(result?.sources || []).map((s, i) => (
              <div className={`ledger-item ${s.ok ? 'ok' : 'fail'}`} key={i}>
                <div className="li-name">{s.source}</div>
                <div className="li-meta">
                  <span>{s.type}</span>
                  <span>{s.ok ? `${s.subjects} subj` : <span className="li-err">failed</span>}</span>
                </div>
                {!s.ok && s.error && <div className="li-meta"><span className="li-err">{s.error}</span></div>}
              </div>
            ))}
          </aside>

          <div className="stack">
            <h2>canonical readout {result ? `· ${result.profiles.length} candidate${result.profiles.length === 1 ? '' : 's'}` : ''}</h2>
            {!result && <div className="empty-state">Pick your sources and a config, then run the transform.</div>}
            {result && result.profiles.length === 0 && (
              <div className="empty-state">No profiles resolved — every fed source was empty or failed.</div>
            )}
            {result?.profiles.map((p, i) => <CanonicalCard key={i} profile={p} />)}
          </div>
        </section>
      </div>

      <footer>
        <div className="wrap">
          Name : Mithil Batra | Roll No : 231210068 | College : NIT DELHI | Personal Email : mithil.batra05@gmail.com | College Email : 231210068@nitdelhi.ac.in
        </div>
      </footer>
    </>
  );
}
