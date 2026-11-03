async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const t = (key) => `/tickets/${encodeURIComponent(key)}`;

export const api = {
  status: (refresh = false) => request(`/status${refresh ? '?refresh=1' : ''}`),
  agentUsage: (refresh = false) => request(`/agent-usage${refresh ? '?refresh=1' : ''}`),
  setAgent: (provider) => request('/settings/agent', { method: 'POST', body: { provider } }),
  fixConnection: (target) => request(`/connections/${target}/fix`, { method: 'POST' }),
  signOutAll: () => request('/connections/sign-out-all', { method: 'POST' }),
  connectionJobs: () => request('/connections/jobs'),
  tickets: () => request('/tickets'),
  reorderTickets: (keys) => request('/tickets/order', { method: 'PUT', body: { keys } }),
  createTicket: (jiraUrl) => request('/tickets', { method: 'POST', body: { jiraUrl } }),
  ticket: (key) => request(t(key)),
  updateTicket: (key, changes) => request(t(key), { method: 'PATCH', body: changes }),
  deleteTicket: (key) => request(t(key), { method: 'DELETE' }),
  deleteAllTickets: () => request('/tickets', { method: 'DELETE' }),
  fetchJira: (key, force, via) => request(`${t(key)}/jira`, { method: 'POST', body: { force, via } }),
  fetchFigma: (key, url, body = {}) => request(`${t(key)}/figma`, { method: 'POST', body: { ...body, url } }),
  checkUi: (key, url) => request(`${t(key)}/check`, { method: 'POST', body: { url } }),
  recheckUi: (key, url) => request(`${t(key)}/check/recheck`, { method: 'POST', body: { url } }),
  figmaProjects: () => request('/full-figma'),
  figmaFrames: (key, fileKey) => request(`${t(key)}/figma/frames${fileKey ? `?fileKey=${encodeURIComponent(fileKey)}` : ''}`),
  useFigmaFrame: (key, nodeId, fileKey) => request(`${t(key)}/figma/frame`, { method: 'POST', body: { nodeId, fileKey } }),
  generateTests: (key, url) => request(`${t(key)}/tests/generate`, { method: 'POST', body: { url } }),
  runTests: (key, url) => request(`${t(key)}/tests/run`, { method: 'POST', body: { url } }),
  runGlobalTests: (key, url) => request(`${t(key)}/global-tests/run`, { method: 'POST', body: { url } }),
  rerunFailedTests: (key, url) => request(`${t(key)}/tests/rerun-failed`, { method: 'POST', body: { url } }),
  login: (key) => request(`${t(key)}/login`),
  // On: sign in with the .env test account before runs. Off: forget the ticket's login.
  setLogin: (key, on) => (on ? request(`${t(key)}/login`, { method: 'PUT', body: { useEnv: true } }) : request(`${t(key)}/login`, { method: 'DELETE' })),
  // Signs in now and saves the session (a site with an OTP or CAPTCHA asks for it in the pop-up).
  signIn: (key) => request(`${t(key)}/login/test`, { method: 'POST', body: {} }),
  forgetSession: (key) => request(`${t(key)}/login/session`, { method: 'DELETE' }),
  // The OTP or CAPTCHA typed for the sign-in step `id`; value null cancels the sign-in.
  answerChallenge: (key, id, value) => request(`${t(key)}/login/challenge`, { method: 'POST', body: { id, value } }),
  screenshotUrl: (key, viewport, at) => `/api${t(key)}/screenshot/${viewport}?t=${encodeURIComponent(at)}`,
};

export function parseJiraKey(input) {
  const text = String(input || '').trim();
  const match =
    text.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/i) ||
    text.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i) ||
    text.match(/^([A-Z][A-Z0-9_]*-\d+)$/i);
  return match ? match[1].toUpperCase() : null;
}
