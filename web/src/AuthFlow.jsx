import { useEffect, useState } from 'react';
import { api, saveSession } from './api';

// Full-screen token flows reached from an emailed link:
//   ?reset=<token>   → set a new password
//   ?invite=<token>  → accept a teammate invite and choose a password
// Both end by logging the user in and handing the session back to App.

export function ResetPassword({ token, onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api('/api/auth/reset', { method: 'POST', body: { token, password } });
      saveSession(session);
      onDone(session);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-box">
      <h3 className="auth-title">Choose a new password</h3>
      <form onSubmit={submit}>
        <label className="fld">
          <span>new password <em>(min 8 characters)</em></span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus autoComplete="new-password" />
        </label>
        {error && <div className="err-banner">{error}</div>}
        <button className="run" disabled={busy}>{busy ? 'saving…' : 'Set password & sign in'}</button>
      </form>
      <button className="linklike" style={{ marginTop: 14 }} onClick={() => onDone(null)}>cancel</button>
    </div>
  );
}

export function AcceptInvite({ token, onDone }) {
  const [invite, setInvite] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/invites/${token}`).then(setInvite).catch((e) => setLoadErr(e.message));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api(`/api/invites/${token}/accept`, { method: 'POST', body: { password } });
      saveSession(session);
      onDone(session);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (loadErr) {
    return (
      <div className="login-box">
        <h3 className="auth-title">Invite unavailable</h3>
        <div className="err-banner">{loadErr}</div>
        <button className="ghost" onClick={() => onDone(null)}>go to sign in</button>
      </div>
    );
  }
  if (!invite) return <div className="login-box"><div className="skeleton sk-title" /><div className="skeleton sk-bar" /></div>;

  return (
    <div className="login-box">
      <h3 className="auth-title">Join {invite.org_name}</h3>
      <p className="login-note">
        You've been invited as <b>{invite.role}</b> for <b>{invite.email}</b>. Pick a password to accept.
      </p>
      <form onSubmit={submit}>
        <label className="fld">
          <span>password <em>(min 8 characters)</em></span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus autoComplete="new-password" />
        </label>
        {error && <div className="err-banner">{error}</div>}
        <button className="run" disabled={busy}>{busy ? 'joining…' : `Join ${invite.org_name}`}</button>
      </form>
    </div>
  );
}
