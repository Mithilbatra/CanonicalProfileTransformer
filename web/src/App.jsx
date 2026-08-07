import { useEffect, useState } from 'react';
import Playground from './Playground';
import Candidates from './Candidates';
import Jobs from './Jobs';
import Insights from './Insights';
import Admin from './Admin';
import Login from './Login';
import ErrorBoundary from './ErrorBoundary';
import { ResetPassword, AcceptInvite } from './AuthFlow';
import { api, getSession, clearSession, saveSession } from './api';

// Detect a token flow from the URL (?reset=… / ?invite=…) once, on load.
function initialFlow() {
  const p = new URLSearchParams(window.location.search);
  if (p.get('reset')) return { kind: 'reset', token: p.get('reset') };
  if (p.get('invite')) return { kind: 'invite', token: p.get('invite') };
  return null;
}

// First visit follows the OS colour scheme; after that we honour the choice
// the user actually made.
function initialTheme() {
  const saved = localStorage.getItem('cpt_theme');
  if (saved) return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [view, setView] = useState('playground');
  const [session, setSession] = useState(getSession());
  const [theme, setTheme] = useState(initialTheme);
  const [flow, setFlow] = useState(initialFlow);

  // Finish a token flow: clear the ?reset/?invite from the URL, and if it
  // produced a session, sign the user straight into the database.
  function endFlow(newSession) {
    window.history.replaceState({}, '', window.location.pathname);
    setFlow(null);
    if (newSession) {
      saveSession(newSession);
      setSession(newSession);
      setView('database');
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cpt_theme', theme);
  }, [theme]);

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
              <div className="nav-row">
                <div className="seg" role="group" aria-label="view">
                  <button aria-pressed={view === 'playground'} onClick={() => setView('playground')}>playground</button>
                  <button aria-pressed={view === 'database'} onClick={() => setView('database')}>candidate database</button>
                  {session && <button aria-pressed={view === 'jobs'} onClick={() => setView('jobs')}>jobs</button>}
                  {session && <button aria-pressed={view === 'insights'} onClick={() => setView('insights')}>insights</button>}
                  {isAdmin && <button aria-pressed={view === 'admin'} onClick={() => setView('admin')}>admin</button>}
                </div>
                <button
                  className="theme-btn"
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                  aria-label={theme === 'light' ? 'switch to dark mode' : 'switch to light mode'}
                  title={theme === 'light' ? 'lights off' : 'lights on'}
                >
                  <span key={theme}>{theme === 'light' ? '☾' : '☀'}</span>
                </button>
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
              'Upload resumes, CSVs and ATS exports over time. New sources merge into the candidates already on file, move them through your hiring pipeline, tag and annotate them, match against a job description (optionally bias-blind), and export.'}
            {view === 'jobs' &&
              'Open a requisition for each role, match the candidate pool against its description, and run a pipeline that is scoped to that job — a candidate can sit at a different stage on every job.'}
            {view === 'insights' &&
              'A read-out of your candidate pool: the hiring funnel, how confident the merges are, which skills are abundant, and where the data came from.'}
            {view === 'admin' &&
              'Your organization: teammates and their roles, and the audit trail of every action taken on candidate data.'}
          </p>
        </header>

        <ErrorBoundary resetKey={flow ? flow.token : view}>
          {flow ? (
            flow.kind === 'reset'
              ? <ResetPassword token={flow.token} onDone={endFlow} />
              : <AcceptInvite token={flow.token} onDone={endFlow} />
          ) : (
            <>
              {view === 'playground' && <Playground />}
              {view === 'database' && (session
                ? <Candidates />
                : <Login onLogin={setSession} />)}
              {view === 'jobs' && (session
                ? <Jobs />
                : <Login onLogin={setSession} />)}
              {view === 'insights' && (session
                ? <Insights />
                : <Login onLogin={setSession} />)}
              {view === 'admin' && isAdmin && <Admin />}
            </>
          )}
        </ErrorBoundary>
      </div>

      <footer>
        <div className="wrap">
          Name : Mithil Batra | Roll No : 231210068 | College : NIT DELHI | Personal Email : mithil.batra05@gmail.com | College Email : 231210068@nitdelhi.ac.in
        </div>
      </footer>
    </>
  );
}
