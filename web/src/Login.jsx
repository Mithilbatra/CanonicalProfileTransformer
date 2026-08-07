import { useState } from 'react';
import { api, saveSession } from './api';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); // login | register | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null); // { devLink } after a forgot request

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        const res = await api('/api/auth/forgot', { method: 'POST', body: { email } });
        setSent({ devLink: res.devLink || null });
        return;
      }
      const body = mode === 'register' ? { email, password, orgName } : { email, password };
      const session = await api(`/api/auth/${mode}`, { method: 'POST', body });
      saveSession(session);
      onLogin(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode(m) {
    setMode(m);
    setError(null);
    setSent(null);
  }

  if (mode === 'forgot' && sent) {
    return (
      <div className="login-box">
        <h3 className="auth-title">Check your email</h3>
        <p className="login-note">
          If an account exists for <b>{email}</b>, a password-reset link is on its way (valid 30 minutes).
        </p>
        {sent.devLink && (
          <p className="login-note">
            Dev mode — no mail server configured, so use this link directly:<br />
            <a href={sent.devLink}>{sent.devLink}</a>
          </p>
        )}
        <button className="ghost" onClick={() => switchMode('login')}>back to sign in</button>
      </div>
    );
  }

  return (
    <div className="login-box">
      {mode !== 'forgot' ? (
        <div className="seg" role="group" aria-label="auth mode" style={{ marginBottom: 18 }}>
          <button aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>sign in</button>
          <button aria-pressed={mode === 'register'} onClick={() => switchMode('register')}>create account</button>
        </div>
      ) : (
        <h3 className="auth-title">Reset your password</h3>
      )}

      <form onSubmit={submit}>
        {mode === 'register' && (
          <label className="fld">
            <span>organization name <em>(optional)</em></span>
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Recruiting" />
          </label>
        )}
        <label className="fld">
          <span>email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        {mode !== 'forgot' && (
          <label className="fld">
            <span>password {mode === 'register' && <em>(min 8 characters)</em>}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 8 : undefined}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </label>
        )}
        {error && <div className="err-banner">{error}</div>}
        <button className="run" disabled={busy}>
          {busy ? 'working…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}
        </button>
      </form>

      {mode === 'login' && (
        <button className="linklike" style={{ marginTop: 14 }} onClick={() => switchMode('forgot')}>forgot password?</button>
      )}
      {mode === 'forgot' && (
        <button className="linklike" style={{ marginTop: 14 }} onClick={() => switchMode('login')}>back to sign in</button>
      )}

      <p className="login-note">
        {mode === 'register'
          ? 'Creating an account starts a new organization with you as its admin. Your candidate data is private to that org.'
          : mode === 'forgot'
            ? "Enter your account email and we'll send a link to set a new password."
            : 'Sign in to your organization. The playground tab works without an account.'}
      </p>
    </div>
  );
}
