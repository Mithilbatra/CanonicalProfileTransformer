import { useEffect, useState } from 'react';
import { api } from './api';
import { confColor } from './bits';

// Screening analytics dashboard — plain CSS bars, no chart library. Reads the
// org's funnel, confidence distribution, skill supply and source mix.

const STAGE_LABEL = {
  new: 'New', screening: 'Screening', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected',
};

export default function Insights() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/api/insights').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="err-banner">{error}</div>;
  if (!data) return <div className="insights"><SkeletonCards /></div>;
  if (data.total === 0) {
    return <div className="empty-state">No candidates yet — upload some in the candidate database to see insights.</div>;
  }

  const maxFunnel = Math.max(...data.funnel.map((f) => f.count), 1);
  const maxSkill = Math.max(...data.topSkills.map((s) => s.count), 1);
  const maxBand = Math.max(...data.confidenceBands.map((b) => b.count), 1);
  const maxSource = Math.max(...data.sourceMix.map((s) => s.count), 1);

  return (
    <div className="insights">
      <div className="stat-row">
        <Stat label="candidates" value={data.total} />
        <Stat label="avg confidence" value={data.avgConfidence.toFixed(2)} color={confColor(data.avgConfidence)} />
        <Stat label="matches run" value={data.activity.matches} />
        <Stat label="bias-blind matches" value={data.activity.blindMatches} />
      </div>

      <div className="insight-grid">
        <Panel title="hiring funnel">
          {data.funnel.map((f) => (
            <Bar key={f.stage} label={STAGE_LABEL[f.stage] || f.stage} value={f.count} pct={(f.count / maxFunnel) * 100} tone="signal" />
          ))}
        </Panel>

        <Panel title="confidence distribution">
          {data.confidenceBands.map((b) => (
            <Bar key={b.label} label={b.label} value={b.count} pct={(b.count / maxBand) * 100} tone="grad" />
          ))}
        </Panel>

        <Panel title="most common skills">
          {data.topSkills.length === 0 ? <p className="muted">no skills extracted yet</p> : data.topSkills.map((s) => (
            <Bar key={s.name} label={s.name} value={s.count} pct={(s.count / maxSkill) * 100} tone="sun" />
          ))}
        </Panel>

        <Panel title="where the data came from">
          {data.sourceMix.length === 0 ? <p className="muted">no sources recorded</p> : data.sourceMix.map((s) => (
            <Bar key={s.type} label={s.type} value={s.count} pct={(s.count / maxSource) * 100} tone="signal" />
          ))}
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="stat">
      <div className="stat-num" style={color ? { color } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="insight-panel">
      <h2>{title}</h2>
      <div className="bars">{children}</div>
    </section>
  );
}

function Bar({ label, value, pct, tone }) {
  return (
    <div className="bar-row">
      <span className="bar-label" title={label}>{label}</span>
      <span className="bar-track">
        <span className={`bar-fill ${tone}`} style={{ width: `${Math.max(pct, value > 0 ? 4 : 0)}%` }} />
      </span>
      <span className="bar-value">{value}</span>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="insight-grid">
      {[0, 1, 2, 3].map((i) => (
        <section className="insight-panel" key={i}>
          <div className="skeleton sk-title" />
          {[0, 1, 2, 3].map((j) => <div className="skeleton sk-bar" key={j} />)}
        </section>
      ))}
    </div>
  );
}
