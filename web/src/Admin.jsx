import { useEffect, useState } from 'react';
import { api } from './api';

// Admin-only view: the org's teammates (with an invite form) and the audit
// trail of every action taken on candidate data. Both are org-scoped by the
// server; this is purely a window onto them.

export default function Admin() {
  return (
    <section className="admin">
      <Members />
      <AuditLog />
    </section>
  );
}

function Members() {
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('recruiter');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/api/org/members').then((d) => setMembers(d.members)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function invite(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/org/members', { method: 'POST', body: { email, password, role } });
      setEmail('');
      setPassword('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
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
        <input type="password" placeholder="temp password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="role-select">
          <option value="admin">admin</option>
          <option value="recruiter">recruiter</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="ghost" disabled={busy}>{busy ? 'inviting…' : 'invite'}</button>
      </form>
      <p className="admin-hint">admins manage the team · recruiters upload & edit · viewers are read-only</p>
      {error && <div className="err-banner">{error}</div>}
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
