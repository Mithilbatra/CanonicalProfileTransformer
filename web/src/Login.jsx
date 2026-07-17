import { useState } from 'react';
import { api, saveSession } from './api';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
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

  return (
    <div className="login-box">
      <div className="seg" role="group" aria-label="auth mode" style={{ marginBottom: 18 }}>
        <button aria-pressed={mode === 'login'} onClick={() => setMode('login')}>sign in</button>
        <button aria-pressed={mode === 'register'} onClick={() => setMode('register')}>create account</button>
      </div>
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
        {error && <div className="err-banner">{error}</div>}
        <button className="run" disabled={busy}>
          {busy ? 'working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <p className="login-note">
        {mode === 'register'
          ? 'Creating an account starts a new organization with you as its admin. Your candidate data is private to that org.'
          : 'Sign in to your organization. The playground tab works without an account.'}
      </p>
    </div>
  );
}
