// Adds the login token, sends JSON and turns error responses into Errors with the field details.
const Session = {
  get() {
    try { return JSON.parse(localStorage.getItem('loanTrackerSession')) || null; } catch { return null; }
  },
  save(session) {
    try { localStorage.setItem('loanTrackerSession', JSON.stringify(session)); } catch { /* private mode */ }
  },
  clear() {
    try { localStorage.removeItem('loanTrackerSession'); } catch { /* ignore */ }
  }
};

async function api(method, path, body) {
  const session = Session.get();
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session && session.token) headers.Authorization = `Bearer ${session.token}`;

  let response;
  try {
    response = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (networkError) {
    throw Object.assign(new Error('Cannot reach the server. Check that the API is running.'), { status: 0 });
  }

  if (response.status === 204) return null;
  let data = null;
  try { data = await response.json(); } catch { data = null; }

  if (!response.ok) {
    if (response.status === 401 && session && !path.startsWith('/api/auth/')) {
      Session.clear();
      window.location.href = 'index.html?expired=1';
    }
    const err = (data && data.error) || {};
    throw Object.assign(new Error(err.message || (data && data.message) || `Request failed (${response.status}).`), {
      status: response.status, code: err.code, details: err.details || []
    });
  }
  return data;
}
