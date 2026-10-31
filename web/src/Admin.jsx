import { useEffect, useRef, useState } from 'react';
import { api, downloadFile } from './api';
import { useToast } from './Toast';

// Admin-only view: teammates (invited by shareable link), a backup/restore
// panel, and the audit trail. Everything is org-scoped by the server.

export default function Admin() {
  return (
    <section className="admin">
      <Members />
      <Settings />
      <Backup />
      <AuditLog />
    </section>
  );
}

// Data-retention window + AI daily-cost cap, and today's AI usage.
function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [budget, setBudget] = useState(null);
  const [retention, setRetention] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/org/settings').then((s) => {
      setSettings(s);
      setRetention(s.retention_days != null ? String(s.retention_days) : '');
      setCap(s.ai_daily_cap != null ? String(s.ai_daily_cap) : '');
    }).catch(() => {});
    api('/api/ai/status').then((d) => setBudget(d.budget)).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    try {
      const s = await api('/api/org/settings', { method: 'PUT', body: { retention_days: retention, ai_daily_cap: cap } });
      setSettings(s);
      toast('Settings saved');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    const n = settings.retention_pending;
    if (!window.confirm(`Permanently delete ${n} candidate${n === 1 ? '' : 's'} whose data is older than ${settings.retention_days} days? This cannot be undone.`)) return;
    try {
      const { purged } = await api('/api/org/purge', { method: 'POST' });
      toast(purged ? `Purged ${purged} candidate${purged === 1 ? '' : 's'}` : 'Nothing to purge');
      setSettings(await api('/api/org/settings'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="admin-block">
      <h2>settings</h2>
      <div className="settings-grid">
        <label className="set-row">
          <span className="set-label">Data retention (days)</span>
          <input type="number" min="1" max="3650" placeholder="keep forever" value={retention} onChange={(e) => setRetention(e.target.value)} />
          <span className="set-hint">
            Candidates with no source data newer than this are auto-deleted daily. Empty = keep forever.
            {settings && settings.retention_days != null && <> <b>{settings.retention_pending}</b> past the window now.</>}
          </span>
          {settings && settings.retention_blocked && (
            <span className="set-warn">
              More than half of your candidates are past this window, so the daily cleanup is paused. If the number is right, delete them below.
            </span>
          )}
        </label>
        <label className="set-row">
          <span className="set-label">AI requests / day</span>
          <input type="number" min="0" max="100000" placeholder={settings && settings.ai_effective_cap != null ? `default ${settings.ai_effective_cap}` : 'default'} value={cap} onChange={(e) => setCap(e.target.value)} />
          <span className="set-hint">
            Caps live AI calls against the shared model key.
            {budget && <> Today: <b>{budget.used}/{budget.cap}</b> used.</>}
          </span>
        </label>
      </div>
      <div className="backup-row">
        <button className="ghost" onClick={save} disabled={busy}>{busy ? 'saving…' : 'save settings'}</button>
        <button className="ghost sm danger-ghost" onClick={purge} disabled={!settings || !settings.retention_pending} title="delete the candidates past the retention window now">
          delete expired{settings && settings.retention_pending ? ` (${settings.retention_pending})` : ''}
        </button>
      </div>
    </div>
  );
}

function Members() {
  const toast = useToast();
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('recruiter');
  const [link, setLink] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/api/org/members').then((d) => setMembers(d.members)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function invite(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/org/invites', { method: 'POST', body: { email, role } });
      setLink(res.link);
      setEmail('');
      toast(`Invite created for ${res.email}`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    navigator.clipboard?.writeText(link).then(() => toast('Invite link copied', 'info')).catch(() => {});
  }

  return (
    <div className="admin-block">
      <h2>team</h2>
      <div className="member-list">
        {members.map((m) => (
          <div className="member" key={m.email}>
            <span className="m-email">{m.email}</span>
            <span className={`role-tag ${m.role}`}>{m.role}</span>
          </div>
        ))}
      </div>

      <form className="invite" onSubmit={invite}>
        <input type="email" placeholder="teammate@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="role-select">
          <option value="admin">admin</option>
          <option value="recruiter">recruiter</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="ghost" disabled={busy}>{busy ? 'creating…' : 'create invite link'}</button>
      </form>

      {link && (
        <div className="invite-link">
          <span className="il-label">Share this link — they set their own password:</span>
          <div className="il-row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="ghost sm" onClick={copy}>copy</button>
          </div>
          <span className="il-note">Also emailed to them (when a mail server is configured).</span>
        </div>
      )}

      <p className="admin-hint">admins manage the team · recruiters upload &amp; edit · viewers are read-only</p>
      {error && <div className="err-banner">{error}</div>}
    </div>
  );
}

function Backup() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  function download() {
    downloadFile('/api/org/backup', 'candidate-db-backup.json')
      .then(() => toast('Backup downloaded'))
      .catch((e) => toast(e.message, 'bad'));
  }

  async function restore(file) {
    if (!file) return;
    if (!window.confirm('Restore this backup into the current organization? It adds to what is already here.')) return;
    setBusy(true);
    try {
      const data = JSON.parse(await file.text());
      const res = await api('/api/org/restore', { method: 'POST', body: data });
      toast(`Restored — ${res.candidates} candidates on file`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-block">
      <h2>backup &amp; restore</h2>
      <div className="backup-row">
        <button className="ghost" onClick={download}>download backup (.json)</button>
        <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? 'restoring…' : 'restore from file'}</button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { restore(e.target.files[0]); e.target.value = ''; }} />
      </div>
      <p className="admin-hint">A backup is a portable JSON snapshot of every candidate, stage, tag and saved template in this org.</p>
    </div>
  );
}

function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/api/audit').then((d) => setEntries(d.entries)).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="admin-block">
      <h2>audit log</h2>
      {error && <div className="err-banner">{error}</div>}
      {entries.length === 0 ? (
        <div className="empty-state">No activity recorded yet.</div>
      ) : (
        <table className="audit-table">
          <thead>
            <tr><th>when</th><th>who</th><th>action</th><th>target</th><th>detail</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="a-when">{e.created_at}</td>
                <td>{e.user_email || '—'}</td>
                <td><span className="a-action">{e.action}</span></td>
                <td className="a-target">{e.target || '—'}</td>
                <td className="a-detail">{e.detail ? JSON.stringify(e.detail) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
