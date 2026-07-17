import { useState } from 'react';
import Playground from './Playground';
import Candidates from './Candidates';
import Admin from './Admin';
import Login from './Login';
import { api, getSession, clearSession } from './api';

export default function App() {
  const [view, setView] = useState('playground');
  const [session, setSession] = useState(getSession());

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* token may already be dead */ }
    clearSession();
    setSession(null);
    setView('playground');
  }

  const isAdmin = session && session.role === 'admin';

  return (
    <>
      <div className="wrap">
        <header className="masthead">
          <div className="mast-top">
            <div>
              <p className="eyebrow">canonical profile transformer</p>
              <h1>Many messy sources in. One profile you can <em>trust</em> out.</h1>
            </div>
            <nav className="topnav">
              <div className="seg" role="group" aria-label="view">
                <button aria-pressed={view === 'playground'} onClick={() => setView('playground')}>playground</button>
                <button aria-pressed={view === 'database'} onClick={() => setView('database')}>candidate database</button>
                {isAdmin && <button aria-pressed={view === 'admin'} onClick={() => setView('admin')}>admin</button>}
              </div>
              {session && (
                <span className="whoami">
                  {session.org_name && <span className="org-tag">{session.org_name}</span>}
                  {session.email} · {session.role} <button className="linklike" onClick={signOut}>sign out</button>
                </span>
              )}
            </nav>
          </div>
          <p>
            {view === 'playground' &&
              'Feed conflicting recruiter, ATS, GitHub and free-text records for the same people. The engine resolves who is who, normalizes every value, and returns one canonical profile per candidate — each field carrying where it came from and how confident the merge is. Nothing is invented; a true unknown stays empty.'}
            {view === 'database' &&
              'Upload resumes, CSVs and ATS exports over time. New sources merge into the candidates already on file, fields can be corrected by hand, matched against a job description (optionally bias-blind), and exported.'}
            {view === 'admin' &&
              'Your organization: teammates and their roles, and the audit trail of every action taken on candidate data.'}
          </p>
        </header>

        {view === 'playground' && <Playground />}
        {view === 'database' && (session
          ? <Candidates />
          : <Login onLogin={setSession} />)}
        {view === 'admin' && isAdmin && <Admin />}
      </div>

      <footer>
        <div className="wrap">
          Name : Mithil Batra | Roll No : 231210068 | College : NIT DELHI | Personal Email : mithil.batra05@gmail.com | College Email : 231210068@nitdelhi.ac.in
        </div>
      </footer>
    </>
  );
}
