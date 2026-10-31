// Small display components shared by the playground and the database views.

import { useEffect, useState } from 'react';

// Animates a number from 0 to its value on mount — purely visual sugar for
// score displays. Skips straight to the value when reduced motion is set.
export function CountUp({ value, decimals = 2, duration = 700 }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return undefined;
    }
    let raf;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / duration);
      setShown(value * (1 - Math.pow(1 - p, 3))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{shown.toFixed(decimals)}</>;
}

export function confColor(c) {
  if (c == null) return 'var(--c-null)';
  if (c >= 0.75) return 'var(--c-high)';
  if (c >= 0.45) return 'var(--c-mid)';
  return 'var(--c-low)';
}

export function Meter({ value, size }) {
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

export function ConfTag({ value }) {
  if (value == null) return null;
  return (
    <span className="conf-tag" title={`confidence ${value}`}>
      <Meter value={value} size="sm" />
      {value.toFixed(2)}
    </span>
  );
}

export function provIndex(provenance = []) {
  const idx = {};
  for (const p of provenance) {
    const base = String(p.field).split('[')[0];
    (idx[base] = idx[base] || []).push(p);
  }
  return idx;
}

export function Provenance({ entries }) {
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

export const EMPTY = <span className="v empty">— empty</span>;

export function FieldRow({ label, children, confidence, prov }) {
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

export function hasText(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

// Display names for the hiring-pipeline stages, shared by every view.
export const STAGE_LABEL = {
  new: 'New', screening: 'Screening', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected',
};
