// Small fetch wrapper: attaches the auth token, unwraps JSON errors.

const TOKEN_KEY = 'cpt_token';
const SESSION_KEY = 'cpt_session';

export function getSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  let meta = {};
  try { meta = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch { /* ignore */ }
  return { token, ...meta };
}

export function saveSession({ token, email, role, org_id, org_name }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(SESSION_KEY, JSON.stringify({ email, role, org_id, org_name }));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export async function api(path, { method = 'GET', body, formData } = {}) {
  const headers = {};
  const session = getSession();
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: formData || (body ? JSON.stringify(body) : undefined),
  });

  if (res.status === 401 && session) {
    clearSession();
    throw new Error('session expired — please sign in again');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// Authenticated file download (the token lives in a header, so a plain
// <a href> won't do).
export async function downloadFile(path, filename) {
  const session = getSession();
  const res = await fetch(path, {
    headers: session ? { Authorization: `Bearer ${session.token}` } : {},
  });
  if (!res.ok) throw new Error('export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
