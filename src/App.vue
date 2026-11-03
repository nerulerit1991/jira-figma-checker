<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api } from './api.js';
import globalCasesCatalog from '../data/global-test-cases/cases.json';
import McpStatus from './components/McpStatus.vue';
import Checklist from './components/Checklist.vue';
import TicketNav from './components/TicketNav.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import NewTicketDialog from './components/NewTicketDialog.vue';
import FrameSelectDialog from './components/FrameSelectDialog.vue';
import FigmaProjectDialog from './components/FigmaProjectDialog.vue';
import FigmaSaveProjectDialog from './components/FigmaSaveProjectDialog.vue';
import { parseFigmaUrl } from '../server/figma.js';
import DesignMatch from './components/DesignMatch.vue';
import DesignChecklist from './components/DesignChecklist.vue';
import ResponsiveReport from './components/ResponsiveReport.vue';
import TestsPanel from './components/TestsPanel.vue';
import TokenBurst from './components/TokenBurst.vue';
import { statusClass } from './status.js';

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const status = ref(null);
const statusLoading = ref(false);

const tickets = ref([]);
const selectedKey = ref(store.get('selectedTicket'));
const ticket = ref(null);
const jira = ref(null);
const figma = ref(null);
// The whole Figma file the Figma API tab has on disk for this ticket's link, or null.
const figmaSaved = ref(null);
const check = ref(null);
// Errors-only view of the last check (check-errors.json); Re-check errors sends just these.
const checkErrors = ref(null);
const tests = ref(null);
const globalTests = ref({ cases: [], results: null });
// The shared suite exists for every ticket, so Run is meaningful even before ticket tests are generated.
const canRunAnyTests = computed(() => Boolean(tests.value) || globalCasesCatalog.cases.length > 0);
const scoreProgress = ref(1);
let scoreAnimationFrame = 0;
let ticketLoadSequence = 0;
function animateScores() {
  cancelAnimationFrame(scoreAnimationFrame);
  const startedAt = performance.now();
  const duration = 800;
  const step = (now) => {
    scoreProgress.value = Math.min((now - startedAt) / duration, 1);
    if (scoreProgress.value < 1) scoreAnimationFrame = requestAnimationFrame(step);
  };
  scoreAnimationFrame = requestAnimationFrame(step);
}
const figmaUrl = ref('');
const pageUrl = ref('');
// "Requires login" for the live page: when on, checks and test runs first sign in with the .env test account
// (PROJECT_USERNAME_EMAIL / PROJECT_PASSWORD). The server turns it on by itself when a run finds the page behind a login.
const login = ref(null);
const loginOn = ref(false);
// Saving the toggle; it is disabled meanwhile so a quick on/off cannot leave the server in the other state.
const loginSaving = ref(false);
const loginNote = computed(() => {
  if (login.value?.source === 'saved') return `Signs in as ${login.value.username} (saved for this ticket)`;
  if (login.value?.enabled && !login.value.hasPassword) return 'Set PROJECT_USERNAME_EMAIL and PROJECT_PASSWORD in .env, then restart the server';
  if (login.value?.auto) return 'Turned on automatically: the page asked for a login. Uses the .env test account';
  if (login.value?.enabled) return `Signs in as ${login.value.username} (.env test account)`;
  return 'Configure the username and password under .env';
});
// The note beside the toggle starts green, then eases to normal text colour 3s after login is switched on
// (by the user, or by a run that found a login page), not when a ticket that already has it is opened.
const loginNoteSettled = ref(true);
let loginNoteTimer = 0;
function flashLoginNote() {
  clearTimeout(loginNoteTimer);
  loginNoteSettled.value = false;
  loginNoteTimer = setTimeout(() => (loginNoteSettled.value = true), 3000);
}
function applyLogin(settings) {
  login.value = settings;
  loginOn.value = Boolean(settings?.enabled);
}
async function toggleLogin() {
  const key = selectedKey.value;
  const on = loginOn.value;
  // Switching off forgets a saved per-ticket account, which cannot be entered again from here.
  if (!on && login.value?.source === 'saved') {
    const ok = await confirmDialog.value.ask({
      title: 'Turn off login?',
      message: `This forgets the account saved for ${key} (${login.value.username}).`,
      confirmLabel: 'Turn off',
    });
    if (!ok || selectedKey.value !== key) {
      if (selectedKey.value === key) loginOn.value = true;
      return;
    }
  }
  loginSaving.value = true;
  try {
    const settings = await api.setLogin(key, on);
    if (selectedKey.value !== key) return;
    applyLogin(settings);
    if (on) flashLoginNote();
  } catch (e) {
    if (selectedKey.value !== key) return;
    loginOn.value = !on;
    error.value = e.message;
  } finally {
    loginSaving.value = false;
  }
}
// A check or test run can turn login on by itself, so re-read it afterwards.
async function refreshLogin(key) {
  try {
    const settings = await api.login(key);
    if (selectedKey.value !== key) return;
    const wasOn = loginOn.value;
    applyLogin(settings);
    if (!wasOn && loginOn.value) flashLoginNote();
  } catch {
    // The toggle keeps its last known state.
  }
}
// Running jobs keyed "<ticket>:<action>", so work on one ticket never shows on another
// and different actions on the same ticket (e.g. Jira and Figma) can run at once.
const jobs = ref({});
// Tickets whose Generate is between its click and its job (confirm dialog), so a double click starts nothing twice.
const generatePending = ref({});
const generatingTestsPending = computed(() => Boolean(generatePending.value[selectedKey.value]));
const isBusy = (action, key = selectedKey.value) => Boolean(jobs.value[`${key}:${action}`]);
const ticketBusy = (key) => Object.keys(jobs.value).some((id) => id.startsWith(`${key}:`));
const anyBusy = computed(() => Object.keys(jobs.value).length > 0);
const busyKeys = computed(() => [...new Set(Object.keys(jobs.value).map((id) => id.split(':')[0]))]);
const error = ref('');

const confirmDialog = ref(null);
const newTicketDialog = ref(null);
const frameSelectDialog = ref(null);
const figmaProjectDialog = ref(null);
const figmaSaveDialog = ref(null);

const checklistScore = computed(() => {
  const r = check.value?.results;
  return r?.length ? { passed: r.filter((x) => x.passed).length, total: r.length } : { passed: 0, total: 0 };
});
// Older checks have only the property table; newer ones have the per-category design checklist.
const designScore = computed(() => {
  const cats = check.value?.designChecklist;
  if (cats?.length) return { passed: cats.filter((x) => x.passed).length, total: cats.length };
  const rows = check.value?.designMatch?.rows;
  return rows?.length ? { passed: rows.filter((x) => x.match).length, total: rows.length } : null;
});
const responsiveScore = computed(() => {
  const r = check.value?.responsive;
  return r?.length ? { passed: r.filter((x) => x.passed).length, total: r.length } : null;
});
const testsScore = computed(() => {
  const r = tests.value?.results;
  return r && r.passed + r.failed ? { passed: r.passed, total: r.passed + r.failed } : null;
});
const scoreClass = (s) => (s.total && s.passed === s.total ? 'good' : 'bad');

const scorePercent = (sc) => (sc?.total ? Math.round((sc.passed / sc.total) * 100) : 0);

const accountEmail = computed(() => status.value?.account?.email || '');
const initials = computed(() => (accountEmail.value ? accountEmail.value[0].toUpperCase() : '?'));

// Token usage per AI call: counts everything the call processed, including cached input.
const tokensOf = (meta) => {
  const u = meta?.usage || {};
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
};
const formatTokenCount = (t) => (t ? (t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`) : '—');
const formatTokens = (meta) => formatTokenCount(tokensOf(meta));

const totalTokens = computed(() => {
  const records = [jira.value, figma.value, check.value, tests.value].filter(Boolean);
  if (!records.some((record) => record.ai)) return null;
  return records.reduce((sum, record) => sum + tokensOf(record.ai), 0);
});

// "-N tokens" animation after each AI call.
const burst = ref(null);
const showBurst = (target, meta) => (burst.value = { id: `${target}-${Date.now()}`, target, tokens: tokensOf(meta) });

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// When someone last edited the source itself (not when we fetched it). `undefined` means the data predates this field.
function sourceUpdated(at, by, source) {
  if (at === undefined && by === undefined) return `Last updated in ${source}: re-fetch to see`;
  if (!at && !by) return `Last updated in ${source}: not provided by the ${source} connector`;
  return `Last updated in ${source}: ${at ? formatDate(at) : 'date unknown'}${by ? ` by ${by}` : ''}`;
}

// One button per source: "Retrieve" the first time, "Re-fetch" (new AI call) once data is saved.
// Saved Figma data counts for the open tab only if it came from that tab's source; older files have no "via".
const figmaSavedVia = computed(() => figma.value?.via || (figma.value?.ai?.source === 'figma-api' ? 'api' : 'mcp'));
const figmaIsSaved = computed(
  () => figma.value && (figma.value.sourceUrl || figma.value.url) === figmaUrl.value && figmaSavedVia.value === figmaVia.value,
);
const figmaHasSpecs = computed(() => Boolean(figma.value?.specs?.length || figma.value?.typography?.length));

// Per-source status. All three tabs write the same data/<KEY>/figma.json, so the two AI sources share a
// line; the Figma API additionally has whole files on disk, which decides between "no frame selected"
// and "no figma data".
const frameLabel = computed(() => figma.value?.nodeName || figma.value?.frameName || 'Design');
const aiSource = computed(() => (figmaHasSpecs.value ? { state: 'ok', label: frameLabel.value } : { state: 'off', label: 'no figma data' }));
const apiSource = computed(() => {
  if (figmaHasSpecs.value && figmaSaved.value) return { state: 'ok', label: frameLabel.value };
  return figmaSaved.value ? { state: 'wait', label: 'no frame selected' } : { state: 'off', label: 'no figma data' };
});

async function loadStatus(refresh = false) {
  statusLoading.value = true;
  try {
    status.value = await api.status(refresh);
  } catch (e) {
    error.value = e.message;
  } finally {
    statusLoading.value = false;
  }
}

// Selected agent's remaining plan allowance, shown at the top of Sources.
const agentUsage = ref(null);
const agentUsageError = ref('');
async function loadAgentUsage(refresh = false) {
  try {
    agentUsage.value = await api.agentUsage(refresh);
    agentUsageError.value = '';
  } catch (e) {
    agentUsageError.value = e.message;
  }
}
const resetText = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

async function selectAgent(provider) {
  try {
    await api.setAgent(provider);
    agentUsage.value = null;
    await Promise.all([loadStatus(true), loadAgentUsage(true)]);
  } catch (e) {
    error.value = e.message;
  }
}

// ---- One-click connection fixes ----
const fixing = ref({});
const signOutStatus = ref(null);
const signOutBusy = computed(() => signOutStatus.value?.state === 'running');
const signOutErrors = computed(() => (signOutStatus.value?.steps || [])
  .filter((step) => step.state === 'error')
  .map((step) => `${step.target}: ${step.message}`)
  .join(' · '));
const FIX_TIMEOUT_MS = 10 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isConnected = (s, target) =>
  target === 'claude' || target === 'codex' ? s.authenticated : target === 'browser' ? s.browser?.status === 'installed' : ['connected', 'configured'].includes(s[target]?.status);

async function fixConnection(target) {
  // The selected agent's CLI (Claude or Codex) opens the sign-in page itself, so the app opens no tab of its own.
  const tab = null;
  fixing.value = { ...fixing.value, [target]: { state: 'running', message: '' } };
  const set = (patch) => (fixing.value = { ...fixing.value, [target]: { ...fixing.value[target], ...patch } });

  try {
    const res = await api.fixConnection(target);
    if (res.action === 'open') {
      if (tab && !tab.closed) tab.location.replace(res.url);
      else window.open(res.url, '_blank');
      set({ message: res.hint, url: res.url });
    } else {
      const keepAuthTab = Boolean(tab && res.action === 'job');
      if (res.action !== 'codex-mcp' && !keepAuthTab) tab?.close();
      if (res.action === 'manual') return set({ state: 'error', message: res.hint });
      if (res.action === 'job') set({ message: res.job.message, url: res.job.url });
      if (res.action === 'codex-mcp') set({ message: res.job.message, url: res.job.url });
    }

    // Poll until it connects, the background job fails, or we time out.
    const started = Date.now();
    while (Date.now() - started < FIX_TIMEOUT_MS) {
      if (res.action === 'codex-mcp') {
        const job = (await api.connectionJobs())[target];
        if (job?.url) {
          set({ url: job.url });
        }
        if (job?.state === 'error') {
          tab?.close();
          return set({ state: 'error', message: job.message });
        }
        if (job?.state === 'done') {
          tab?.close();
          status.value = await api.status(true);
          if (!isConnected(status.value, target)) {
            return set({ state: 'error', message: `${target === 'jira' ? 'Jira' : 'Figma'} still needs MCP authorization. Complete the sign-in and recheck Connections.` });
          }
          set({ state: 'done', message: '' });
          setTimeout(() => {
            const { [target]: _, ...rest } = fixing.value;
            fixing.value = rest;
          }, 4000);
          return;
        }
        await sleep(1000);
        continue;
      }
      if (res.action === 'job') {
        const job = (await api.connectionJobs())[target];
        if (job?.url) {
          set({ url: job.url });
        }
        if (job?.state === 'error') {
          tab?.close();
          return set({ state: 'error', message: job.message });
        }
      }
      const latestStatus = await api.status(true);
      status.value = latestStatus;
      if (isConnected(status.value, target)) {
        set({ state: 'done', message: '' });
        setTimeout(() => {
          const { [target]: _, ...rest } = fixing.value;
          fixing.value = rest;
        }, 4000);
        return;
      }
      if (res.action === 'done') return set({ state: 'error', message: `Still ${status.value[target]?.status}. ${status.value[target]?.error || ''}`.trim() });
      await sleep(4000);
    }
    tab?.close();
    set({ state: 'error', message: 'Timed out waiting. Click to try again.' });
  } catch (e) {
    tab?.close();
    set({ state: 'error', message: e.message });
  }
}

async function signOutAll() {
  if (signOutBusy.value) return;
  try {
    signOutStatus.value = await api.signOutAll();
    while (signOutStatus.value?.state === 'running') {
      await sleep(400);
      const jobs = await api.connectionJobs();
      if (jobs.signOutAll) signOutStatus.value = jobs.signOutAll;
    }
    await loadStatus(true);
  } catch (e) {
    signOutStatus.value = { state: 'error', message: e.message };
  }
}

async function loadTickets() {
  tickets.value = await api.tickets();
  if (!tickets.value.some((t) => t.key === selectedKey.value)) {
    selectedKey.value = tickets.value[0]?.key ?? null;
  }
}

// Shows the dragged order at once, then saves it; on failure the saved order is loaded back.
async function reorderTickets(keys) {
  const byKey = new Map(tickets.value.map((t) => [t.key, t]));
  tickets.value = keys.map((key) => byKey.get(key)).filter(Boolean);
  try {
    await api.reorderTickets(keys);
  } catch (e) {
    error.value = e.message;
    await loadTickets();
  }
}

async function loadTicket(key) {
  const loadSequence = ++ticketLoadSequence;
  cancelAnimationFrame(scoreAnimationFrame);
  scoreProgress.value = 0;
  ticket.value = jira.value = figma.value = check.value = checkErrors.value = tests.value = null;
  figmaSaved.value = null;
  applyLogin(null);
  loginNoteSettled.value = true;
  // Cleared so a link typed for the previous ticket is never sent for this one while it loads.
  figmaUrl.value = pageUrl.value = '';
  clickedRuns.value = {};
  globalTests.value = { cases: [], results: null };
  error.value = '';
  if (!key) return;
  try {
    const data = await api.ticket(key);
    if (selectedKey.value !== key || loadSequence !== ticketLoadSequence) return;
    ticket.value = data.ticket;
    jira.value = data.jira;
    figma.value = data.figma;
    figmaSaved.value = data.figmaSaved;
    check.value = data.check;
    checkErrors.value = data.checkErrors;
    tests.value = data.tests;
    globalTests.value = data.globalTests;
    applyLogin(data.login);
    figmaUrl.value = data.ticket.figmaUrl || data.figma?.sourceUrl || data.jira?.figmaLinks?.[0] || '';
    pageUrl.value = data.ticket.pageUrl || data.check?.url || '';
    if (selectedKey.value === key) animateScores();
  } catch (e) {
    if (selectedKey.value === key && loadSequence === ticketLoadSequence) error.value = e.message;
  }
}

watch(selectedKey, (key) => {
  store.set('selectedTicket', key);
  loadTicket(key);
});

/**
 * Runs `request(key)` for the open ticket. `apply(result)` only runs if that ticket is still open
 * when it finishes, so switching tickets never shows one ticket's results on another.
 */
// Jira and Figma errors are shown under their own field instead of the banner at the top.
const FIELD_ERRORS = new Set(['jira', 'figma']);
const fieldErrors = ref({});
const fieldError = (action) => fieldErrors.value[`${selectedKey.value}:${action}`];

async function run(action, request, apply) {
  const key = selectedKey.value;
  const id = `${key}:${action}`;
  jobs.value = { ...jobs.value, [id]: true };
  error.value = '';
  if (FIELD_ERRORS.has(action)) fieldErrors.value = { ...fieldErrors.value, [id]: '' };
  try {
    const result = await request(key);
    if (selectedKey.value === key) apply?.(result);
    await loadTickets();
    // After an AI run, the agent's remaining allowance has changed.
    if (['jira', 'figma', 'check', 'tests'].includes(action)) loadAgentUsage(true);
    return true;
  } catch (e) {
    if (FIELD_ERRORS.has(action)) fieldErrors.value = { ...fieldErrors.value, [id]: e.message };
    else error.value = selectedKey.value === key ? e.message : `${key}: ${e.message}`;
    return false;
  } finally {
    const { [id]: _, ...rest } = jobs.value;
    jobs.value = rest;
    if (['check', 'tests', 'run'].includes(action)) refreshLogin(key);
  }
}

// Where Jira is read from, remembered per ticket: "mcp" (selected agent's local Atlassian MCP)
// or "api" (Jira REST API with JIRA_EMAIL + JIRA_API_TOKEN; only the checklist step uses AI).
const JIRA_TABS = [
  { via: 'mcp', label: 'Jira MCP' },
  { via: 'api', label: 'Jira API' },
];
const jiraVia = ref('mcp');
watch(
  selectedKey,
  (key) => {
    const saved = store.get(`jiraVia:${key}`);
    jiraVia.value = JIRA_TABS.some((t) => t.via === saved) ? saved : 'mcp';
  },
  { immediate: true },
);
function setJiraVia(via) {
  jiraVia.value = via;
  store.set(`jiraVia:${selectedKey.value}`, via);
}

function retrieveJira() {
  const force = Boolean(jira.value);
  const via = jiraVia.value;
  noteRun('jira', status.value?.runs && jiraRunLabel.value);
  return run('jira', (key) => api.fetchJira(key, force, via), (res) => {
    jira.value = res.data;
    if (!res.cached) showBurst('jira', res.data.ai);
    if (!figmaUrl.value && res.data.figmaLinks?.length) figmaUrl.value = res.data.figmaLinks[0];
  });
}

// Where Figma is read from, remembered per ticket. Each tab uses only its own source:
// "mcp" (selected agent's local Figma MCP), "bridge" (the frame selected in the Figma desktop app)
// or "api" (Figma REST API; the whole file is saved in data/full-figma/, into the project folder chosen at retrieve).
const FIGMA_TABS = [
  { via: 'mcp', label: 'Figma MCP online' },
  { via: 'bridge', label: 'Figma MCP bridge' },
  { via: 'api', label: 'Figma API' },
];
const figmaVia = ref('api');
watch(
  selectedKey,
  (key) => {
    const saved = store.get(`figmaVia:${key}`);
    figmaVia.value = FIGMA_TABS.some((t) => t.via === saved) ? saved : 'api';
  },
  { immediate: true },
);
function setFigmaVia(via) {
  figmaVia.value = via;
  store.set(`figmaVia:${selectedKey.value}`, via);
}

// Which status row is highlighted follows the radio tabs above; the rows themselves only report.
const aiRowOn = computed(() => figmaVia.value !== 'api');

// "Claude · Haiku 5.5 · low effort" labels next to the run buttons, from the server's description of each step.
const runLabel = (kind) => {
  const runs = status.value?.runs;
  const run = runs?.[kind];
  if (!run) return '';
  return `${runs.agent} · ${run.model} · ${run.effort === 'default' ? 'default effort' : `${run.effort} effort`}`;
};
const jiraRunLabel = computed(() =>
  jiraVia.value === 'api'
    ? [`Checklist via ${runLabel('analysis')}`]
    : [`Fetch via ${runLabel('extract')}`, `Checklist via ${runLabel('analysis')}`],
);
const figmaRunLabel = computed(() => [figmaVia.value === 'api' ? 'Figma API · no AI' : `Fetch via ${runLabel('extract')}`]);
const checkRunLabel = computed(() => [`Check via ${runLabel('analysis')}`]);
// Chips beside the card title, shown only after its button is clicked: the agent, model and effort each step used.
// Jira and Figma share a card, so only the step clicked last keeps its chips.
const clickedRuns = ref({});
const noteRun = (action, chips) => {
  if (!chips) return;
  const { jira, figma, ...rest } = clickedRuns.value;
  clickedRuns.value = action === 'jira' || action === 'figma' ? { ...rest, [action]: chips } : { ...clickedRuns.value, [action]: chips };
};
const apiRowOn = computed(() => figmaVia.value === 'api');

async function retrieveFigma() {
  const via = figmaVia.value;
  const url = via === 'bridge' ? undefined : figmaUrl.value || undefined;
  // The API tab asks where to save the whole file (overwrite a project or make a new one)
  // before it downloads, so a cancelled dialog never costs an API call.
  let body = { via, force: via === 'bridge' || Boolean(figmaIsSaved.value) };
  if (via === 'api') {
    const link = parseFigmaUrl(url || '');
    const alreadySaved = link && figmaSaved.value?.fileKey === link.fileKey ? figmaSaved.value : null;
    const save = await figmaSaveDialog.value.ask({ savedProject: alreadySaved });
    if (!save) return;
    body = { ...body, project: save.project, overwrite: save.overwrite, redownload: save.redownload };
  }
  noteRun('figma', status.value?.runs && figmaRunLabel.value);
  return run('figma', (key) => api.fetchFigma(key, url, body), (res) => {
    figma.value = res.data;
    if (via === 'api') figmaSaved.value = { fileKey: res.data.fileKey, project: res.data.fileName };
    // Remember the selected frame's link so the MCP and API tabs can use it too.
    if (via === 'bridge' && res.data.url && !figmaUrl.value) {
      figmaUrl.value = res.data.url;
      saveLinks();
    }
    if (!res.cached) showBurst('figma', res.data.ai);
  });
}

/**
 * Asks which whole Figma file the API tab already saved, then which frame of it, and points this
 * ticket at that frame. No download and no tokens. False on cancel or failure.
 */
async function useSavedFigmaFrame() {
  const pick = await figmaProjectDialog.value.ask();
  if (!pick) return false;
  const frame = await frameSelectDialog.value.ask(selectedKey.value, pick.fileKey);
  if (!frame) return false;
  return run('figma', async (key) => (await api.useFigmaFrame(key, frame.id, pick.fileKey)).data, (data) => {
    figma.value = data;
    figmaSaved.value = { fileKey: pick.fileKey, project: data.fileName };
    if (data.url && data.url !== figmaUrl.value) {
      figmaUrl.value = data.url;
      saveLinks();
    }
  });
}

// In the Figma API tab the check compares one frame, so it is picked first — but only when the
// ticket has no frame yet; Replace frame on the Figma API row is how an existing choice is changed.
async function checkUi() {
  const key = selectedKey.value;
  const url = pageUrl.value;
  if (figmaVia.value === 'api' && !figmaHasSpecs.value && !(await useSavedFigmaFrame())) return;
  // Picking the frame takes a while; never start the check on a ticket opened in the meantime.
  if (selectedKey.value !== key) return;
  noteRun('check', status.value?.runs && checkRunLabel.value);
  return run('check', (key) => api.checkUi(key, url), (res) => {
    check.value = res.data;
    checkErrors.value = res.errors;
    showBurst('check', res.data.ai);
  });
}

// Re-checks only the last check's errors: fewer viewports, only the affected sections, far fewer tokens.
// Checks with only failed design-table rows (no failed category) still have errors to re-check.
const checkErrorCount = computed(() => checkErrors.value?.count || checkErrors.value?.designRows?.length || 0);
function recheckUi() {
  const url = pageUrl.value;
  noteRun('check', status.value?.runs && [`Re-check via ${runLabel('analysis')}`]);
  return run('check', (key) => api.recheckUi(key, url), (res) => {
    check.value = res.data;
    checkErrors.value = res.errors;
    showBurst('check', res.data.ai);
  });
}

async function generateTests() {
  const key = selectedKey.value;
  if (generatePending.value[key] || isBusy('tests')) return;
  generatePending.value = { ...generatePending.value, [key]: true };
  try {
    if (tests.value) {
      const ok = await confirmDialog.value.ask({
        title: 'Regenerate tests?',
        message: 'Claude rewrites the ticket-specific scripts from the ticket and current page. Global test cases are kept separate. This uses tokens again and replaces the saved ticket scripts and last results.',
        confirmLabel: 'Regenerate',
        danger: false,
      });
      if (!ok || selectedKey.value !== key) return;
    }
    const url = pageUrl.value;
    await run('tests', (key) => api.generateTests(key, url), (res) => {
      tests.value = res;
      showBurst('tests', res.ai);
    });
  } finally {
    const { [key]: _, ...rest } = generatePending.value;
    generatePending.value = rest;
  }
}

function runTests() {
  if (isBusy('run') || !canRunAnyTests.value) return;
  const url = pageUrl.value;
  // Decided now: by the time the global suite finishes another ticket may be open.
  const hasTicketTests = Boolean(tests.value);
  return run('run', async (key) => {
    const global = await api.runGlobalTests(key, url);
    // Without generated ticket scripts the global suite still runs on its own.
    const ticket = hasTicketTests ? await api.runTests(key, url) : null;
    return { global, ticket };
  }, ({ global, ticket }) => {
    globalTests.value = global;
    tests.value = ticket;
  });
}

// Re-runs only the tests that failed last time (ticket and global); passing results are kept.
const failedTestCount = computed(() => (tests.value?.results?.failed || 0) + (globalTests.value?.results?.failed || 0));
function rerunFailedTests() {
  if (isBusy('run') || !failedTestCount.value) return;
  const url = pageUrl.value;
  return run('run', (key) => api.rerunFailedTests(key, url), ({ global, ticket }) => {
    globalTests.value = global;
    tests.value = ticket;
  });
}

// Remember links per ticket as they are typed.
async function saveLinks() {
  const key = selectedKey.value;
  if (!key) return;
  try {
    const saved = await api.updateTicket(key, { figmaUrl: figmaUrl.value, pageUrl: pageUrl.value });
    // Another ticket may have been opened while saving (blur fires on the click that opens it).
    if (selectedKey.value === key) ticket.value = saved;
  } catch {
    /* non-critical */
  }
}

// ---- Test account for pages behind a sign-in ----
async function createTicket(jiraUrl) {
  const { ticket: created } = await api.createTicket(jiraUrl);
  await loadTickets();
  if (selectedKey.value === created.key) await loadTicket(created.key);
  else selectedKey.value = created.key;
}

async function deleteCurrent() {
  const key = selectedKey.value;
  const ok = await confirmDialog.value.ask({
    title: `Delete ${key}?`,
    message: `This removes data/${key}/ and its saved Jira, Figma and check results. Retrieving it again will use tokens.`,
    confirmLabel: 'Delete ticket',
  });
  if (!ok) return;
  await run('delete', () => api.deleteTicket(key), () => {
    clearFieldErrors(key);
    selectedKey.value = null;
  });
}

// Jira / Figma field errors of deleted tickets, so a ticket added again with the same key starts clean.
function clearFieldErrors(key) {
  fieldErrors.value = Object.fromEntries(Object.entries(fieldErrors.value).filter(([id]) => key && !id.startsWith(`${key}:`)));
}

async function resetAll() {
  const ok = await confirmDialog.value.ask({
    title: 'Delete everything?',
    message: `This removes all ${tickets.value.length} ticket folders, their saved JSON and every whole Figma file under data/full-figma/. Retrieving a Figma design again needs a fresh API download. This cannot be undone.`,
    confirmLabel: 'Delete all',
  });
  if (!ok) return;
  await run('reset', () => api.deleteAllTickets(), () => {
    clearFieldErrors(null);
    selectedKey.value = null;
  });
}

onMounted(async () => {
  loadStatus();
  loadAgentUsage();
  try {
    await loadTickets();
    loadTicket(selectedKey.value);
  } catch (e) {
    error.value = e.message;
  }
});
</script>

<template>
  <div class="shell">
    <!-- Sidebar: brand, tickets, connections -->
    <aside class="sidebar">
      <div class="brand">
        <span class="logo" aria-hidden="true"></span>
        <span class="brand-name">UI Checker</span>
      </div>

      <div class="ticket-actions">
        <button class="primary new-btn" @click="newTicketDialog.open()">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New ticket
        </button>
        <button v-if="tickets.length" class="ghost reset-btn" :disabled="anyBusy" @click="resetAll">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          Reset all
        </button>
      </div>

      <TicketNav v-model="selectedKey" :tickets="tickets" :busy-keys="busyKeys" @reorder="reorderTickets" />

      <div class="sidebar-foot">
        <div class="connections-head">
          <p class="nav-label">Connections</p>
          <button class="icon" :disabled="statusLoading || signOutBusy" :class="{ spinning: statusLoading }" title="Recheck connections" aria-label="Recheck connections" @click="loadStatus(true)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
          </button>
        </div>
        <McpStatus :status="status" :loading="statusLoading" :fixing="fixing" :signing-out="signOutBusy" @fix="fixConnection" @select-agent="selectAgent" />
        <button class="ghost reset-btn signout-btn" :disabled="signOutBusy" @click="signOutAll">
          {{ signOutBusy ? 'Signing out…' : 'Sign out all' }}
        </button>
        <p v-if="signOutStatus" class="signout-note" :class="{ err: signOutStatus.state === 'error', ok: signOutStatus.state === 'done' }">
          {{ signOutStatus.message }}
          <span v-if="signOutBusy && signOutStatus.current"> {{ signOutStatus.completed }}/{{ signOutStatus.total }} · {{ signOutStatus.current }}</span>
          <span v-else-if="signOutStatus.state === 'error' && signOutErrors"> {{ signOutErrors }}</span>
        </p>
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <header class="topbar">
        <nav class="crumbs" aria-label="Breadcrumb">
          <span>Tickets</span>
          <template v-if="ticket">
            <span class="crumb-sep">/</span>
            <span class="crumb-current">{{ ticket.key }}</span>
          </template>
        </nav>
        <div v-if="accountEmail" class="account" :title="accountEmail">
          <span class="avatar">{{ initials }}</span>
          <span class="account-email">{{ accountEmail }}</span>
        </div>
      </header>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section v-if="!tickets.length" class="empty">
        <span class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </span>
        <p class="empty-title">No tickets yet</p>
        <p class="muted">Add a Jira ticket to start. Each ticket gets its own folder of JSON files.</p>
        <button class="primary" @click="newTicketDialog.open()">New ticket</button>
      </section>

      <template v-else-if="ticket">
        <div class="page-head">
          <div class="page-title">
            <div class="ticket-meta">
              <a class="ticket-key" :href="ticket.jiraUrl" target="_blank" rel="noopener">{{ ticket.key }} ↗</a>
              <span v-if="jira?.status" class="status-chip" :class="statusClass(jira.status)">{{ jira.status }}</span>
            </div>
            <h1>{{ jira?.summary || '---' }}</h1>
          </div>
          <button class="delete-btn" :disabled="ticketBusy(selectedKey)" aria-label="Delete ticket" @click="deleteCurrent">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
            <span class="btn-label">Delete</span>
          </button>
        </div>

        <div class="content-grid">
          <div class="content-main">
            <!-- 01 Details / Data -->
            <section class="card">
              <div class="card-head">
                <span class="step">01</span>
                <h2>Details / Data</h2>
                <span v-if="clickedRuns.jira || clickedRuns.figma" class="run-chips">
                  <span v-for="chip in clickedRuns.jira" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('jira') }">{{ chip }}</span>
                  <span v-for="chip in clickedRuns.figma" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('figma') }">{{ chip }}</span>
                </span>
              </div>

              <div class="sources">
                <div class="source">
                  <span class="field-label">Jira section</span>
                  <div class="via-tabs" role="tablist" aria-label="Read Jira from">
                    <button
                      v-for="tab in JIRA_TABS"
                      :key="tab.via"
                      role="tab"
                      :aria-selected="jiraVia === tab.via"
                      :class="{ on: jiraVia === tab.via }"
                      :disabled="isBusy('jira')"
                      @click="setJiraVia(tab.via)"
                    >
                      {{ tab.label }}
                    </button>
                  </div>
                  <div class="inline-field">
                    <input id="jira-link" :value="ticket.jiraUrl" readonly />
                    <TokenBurst :burst="burst" target="jira" />
                    <button class="primary small" :disabled="isBusy('jira')" @click="retrieveJira" aria-label="Retrieve Jira">
                      <span v-if="isBusy('jira')" class="spinner" aria-hidden="true"></span>
                      <span v-else>↻</span>
                    </button>
                  </div>
                  <p v-if="jira" class="source-status ok">
                    <span class="tick">✓</span> Jira retrieved · {{ jira.checklist?.length || 0 }} checklist items
                  </p>
                  <p v-else class="source-status">Not retrieved yet</p>
                  <p v-if="jira" class="source-updated">{{ sourceUpdated(jira.lastUpdated, jira.lastUpdatedBy, 'Jira') }}</p>
                  <p class="source-hint accent">
                    {{ jiraVia === 'api'
                      ? 'Jira API retrieval does not use AI tokens. Creating the checklist uses AI tokens.'
                      : 'Jira MCP retrieval and checklist creation use AI tokens.' }}
                  </p>
                  <p v-if="fieldError('jira')" class="source-error" role="alert">{{ fieldError('jira') }}</p>
                </div>

                <div class="source">
                  <span class="field-label">Figma section</span>
                  <div class="via-radios" role="radiogroup" aria-label="Read Figma from">
                    <label v-for="tab in FIGMA_TABS" :key="tab.via" class="via-radio" :class="{ on: figmaVia === tab.via }">
                      <input
                        type="radio"
                        name="figma-via"
                        :value="tab.via"
                        :checked="figmaVia === tab.via"
                        :disabled="isBusy('figma')"
                        @change="setFigmaVia(tab.via)"
                      />
                      {{ tab.label }}
                      <span v-if="tab.via === 'api'" class="tab-badge">free</span>
                    </label>
                  </div>
                  <div class="inline-field">
                    <span v-if="figmaVia === 'bridge'" class="frame-hint">Select the frame in Figma</span>
                    <input
                      v-if="figmaVia !== 'bridge'"
                      id="figma-link"
                      v-model.trim="figmaUrl"
                      :placeholder="figmaVia === 'api' ? 'Paste the whole Figma URL (file or frame link)' : 'Design or prototype link'"
                      @change="saveLinks"
                    />
                    <TokenBurst :burst="burst" target="figma" />
                    <button
                      class="primary small"
                      :disabled="isBusy('figma') || (figmaVia !== 'bridge' && !figmaUrl && !jira?.figmaLinks?.length)"
                      @click="retrieveFigma"
                      aria-label="Retrieve Figma"
                    >
                      <span v-if="isBusy('figma')" class="spinner" aria-hidden="true"></span>
                      <span v-else>↻</span>
                    </button>
                  </div>
                  <div class="source-picks">
                    <p class="source-status source-pick" :class="[aiSource.state, { on: aiRowOn }]">
                      Figma MCP / Figma bridge ·
                      <strong :title="aiSource.label">{{ aiSource.label }}</strong>
                      <span v-if="aiSource.state === 'ok' && figma?.nodeType" class="tag">{{ figma.nodeType.toLowerCase().replace('_', ' ') }}</span>
                      <span class="pick-right"><span v-if="aiRowOn" class="in-use">in use</span></span>
                    </p>
                    <p class="source-status source-pick" :class="[apiSource.state, { on: apiRowOn }]">
                      Figma API ·
                      <strong :title="apiSource.label">{{ apiSource.label }}</strong>
                      <span v-if="apiSource.state === 'ok' && figma?.nodeType" class="tag">{{ figma.nodeType.toLowerCase().replace('_', ' ') }}</span>
                      <span class="pick-right">
                        <button
                          class="ghost replace-frame"
                          :disabled="isBusy('figma')"
                          title="Point this ticket at another frame of a Figma file already on this machine. No download, no AI tokens."
                          @click="useSavedFigmaFrame"
                        >
                          Replace frame
                        </button>
                        <span v-if="apiRowOn" class="in-use">in use</span>
                      </span>
                    </p>
                  </div>
                  <p v-if="figma" class="source-updated">{{ sourceUpdated(figma.lastModified, figma.lastModifiedBy, 'Figma') }}</p>
                  <p v-if="figma && figmaSavedVia !== 'api'" class="source-via">
                    <template v-if="figmaSavedVia === 'bridge'">Fetched from Figma desktop (bridge)</template>
                    <template v-else>Fetched with the Figma MCP (AI)</template>
                  </p>
                  <p v-if="figmaVia === 'bridge'" class="source-hint accent">In the Figma desktop app, run the bridge plugin and select the frame to check, then click Fetch selection. Uses AI tokens.</p>
                  <p v-else-if="figmaVia === 'mcp'" class="source-hint accent">Reads the link with the selected agent's Figma MCP. Uses AI tokens.</p>
                  <template v-else>
                    <p class="source-hint accent">Don’t select a frame. Paste the Figma file URL to download the entire file. Does not use AI tokens.</p>
                    <p v-if="status && !status.figmaApiToken" class="source-hint warn-text">No FIGMA_TOKEN in .env yet. Add a personal access token (File content: Read, File versions: Read) and restart the app.</p>
                    <p v-else-if="status?.figmaApiBlockedUntil" class="source-hint warn-text">Figma API limit reached until {{ formatDate(status.figmaApiBlockedUntil) }}.</p>
                  </template>
                  <p v-if="fieldError('figma')" class="source-error" role="alert">{{ fieldError('figma') }}</p>
                </div>

                <div class="source">
                  <label class="field-label" for="page-link">Page URL</label>
                  <div class="inline-field">
                    <input id="page-link" v-model.trim="pageUrl" aria-label="Page URL" placeholder="http://localhost:3000/login" @change="saveLinks" />
                  </div>
                  <!-- Used by Check UI, Re-check and the tests: each signs in first when on. -->
                  <div class="login-row">
                    <label class="login-toggle" :class="{ on: loginOn }">
                      <input v-model="loginOn" type="checkbox" aria-label="Requires login" :disabled="loginSaving" @change="toggleLogin" />
                      <span class="switch-track" aria-hidden="true"></span>
                      Requires login
                    </label>
                  </div>
                  <Transition name="login-note">
                    <p v-show="loginOn" class="login-note" :class="{ settled: loginNoteSettled }">
                      {{ loginNote }}
                    </p>
                  </Transition>
                </div>
              </div>

            </section>

            <!-- 02 Check -->
            <section class="card">
              <div class="card-head">
                <span class="step">02</span>
                <h2>Check the live page</h2>
                <span v-if="clickedRuns.check" class="run-chips">
                  <span v-for="chip in clickedRuns.check" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('check') }">{{ chip }}</span>
                </span>
                <span class="check-target">
                  {{ selectedKey }} → {{ FIGMA_TABS.find((t) => t.via === figmaVia)?.label }}<template v-if="figmaHasSpecs && figma?.nodeName"> · {{ figma.nodeName }}</template>
                </span>
                <TokenBurst :burst="burst" target="check" />
                <button
                  v-if="check && checkErrorCount"
                  class="ghost recheck"
                  :disabled="!pageUrl || isBusy('check') || isBusy('jira') || isBusy('figma')"
                  :title="`Re-check only the ${checkErrorCount} errors from the last check`"
                  @click="recheckUi"
                >
                  Re-check {{ checkErrorCount }} error{{ checkErrorCount === 1 ? '' : 's' }}
                </button>
                <button class="primary small" :disabled="!jira?.checklist?.length || !pageUrl || isBusy('check') || isBusy('jira') || isBusy('figma')" @click="checkUi" aria-label="Check UI">
                  <span v-if="isBusy('check')" class="spinner" aria-hidden="true"></span>
                  <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" /></svg>
                </button>
              </div>
              <p v-if="check?.recheckedAt" class="meta recheck-meta">Errors re-checked {{ formatDate(check.recheckedAt) }} · full check {{ formatDate(check.checkedAt) }}</p>
              <p v-if="!jira" class="hint">Retrieve the Jira ticket first to build the checklist.</p>
              <p v-else-if="!pageUrl" class="hint">Enter the live page URL under Details / Data to enable play.</p>
              <p v-else-if="isBusy('check')" class="hint">Rendering at desktop, tablet and mobile, then comparing with Jira and Figma…</p>
              <p v-if="check?.warning" class="warn-text">{{ check.warning }}</p>

              <template v-if="jira?.checklist?.length">
                <details class="accordion">
                  <summary>
                    <span class="acc-title">Acceptance checklist</span>
                    <span v-if="check" class="score-chip" :class="scoreClass(checklistScore)">
                      {{ checklistScore.passed }}/{{ checklistScore.total }}
                    </span>
                    <span v-else class="score-chip">{{ jira.checklist.length }} items</span>
                    <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </summary>
                  <Checklist :items="jira.checklist" :check="check" :show-score="false" />
                </details>

                <details v-if="check?.designChecklist?.length || check?.designMatch?.rows?.length" class="accordion">
                  <summary>
                    <span class="acc-title">Figma vs live</span>
                    <span v-if="designScore" class="score-chip" :class="scoreClass(designScore)">
                      {{ designScore.passed }}/{{ designScore.total }}
                    </span>
                    <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </summary>
                  <DesignChecklist v-if="check.designChecklist?.length" :items="check.designChecklist" />
                  <details v-if="check.designMatch?.rows?.length" class="more">
                    <summary>All compared properties</summary>
                    <DesignMatch :match="check.designMatch" />
                  </details>
                  <p class="acc-note">
                    If an issue persists after you fix it, re-fetch Figma: the design may have been updated since it was last retrieved.
                  </p>
                </details>
                <p v-else-if="check && !figma" class="hint block-hint">Retrieve the Figma design to compare padding, margins and fonts.</p>

                <details v-if="check?.responsive?.length" class="accordion responsive-accordion">
                  <summary>
                    <span class="acc-title">Responsive layout</span>
                    <span v-if="responsiveScore" class="score-chip" :class="scoreClass(responsiveScore)">{{ responsiveScore.passed }}/{{ responsiveScore.total }}</span>
                    <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </summary>
                  <ResponsiveReport
                    :responsive="check.responsive"
                    :screenshots="check.screenshots"
                    :ticket-key="selectedKey"
                    :checked-at="check.checkedAt"
                  />
                </details>

                <template v-if="check?.summary">
                  <h3 class="block-title">Findings</h3>
                  <ul class="list">
                    <li v-for="(line, i) in check.summary.split(/(?<=[.;])\s+/).filter(Boolean)" :key="i">{{ line }}</li>
                  </ul>
                </template>
              </template>
            </section>

            <!-- 03 Functional & API tests -->
            <section class="card">
              <div class="card-head tests-card-head">
                <span class="step">03</span>
                <h2>Functional &amp; API tests</h2>
                <div class="tests-card-actions">
                  <button class="regen-tab" :disabled="!jira || !pageUrl || generatingTestsPending || isBusy('tests') || isBusy('run')" @click="generateTests">
                    <span v-if="isBusy('tests')" class="spinner" aria-hidden="true"></span>
                    {{ isBusy('tests') ? 'Writing tests…' : tests ? 'Regenerate tests' : 'Generate tests' }}
                  </button>
                  <button
                    v-if="failedTestCount"
                    class="ghost recheck"
                    :disabled="!pageUrl || isBusy('tests') || isBusy('run')"
                    :title="`Re-run only the ${failedTestCount} failed test${failedTestCount === 1 ? '' : 's'} from the last run`"
                    @click="rerunFailedTests"
                  >
                    Re-run {{ failedTestCount }} failed
                  </button>
                  <button v-if="canRunAnyTests" class="primary small" :disabled="!pageUrl || isBusy('tests') || isBusy('run')" @click="runTests()" :title="isBusy('run') ? 'Running all tests' : 'Run all tests'" :aria-label="isBusy('run') ? 'Running all tests' : 'Run all tests'">
                    <span v-if="isBusy('run')" class="spinner" aria-hidden="true"></span>
                    <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" /></svg>
                  </button>
                </div>
              </div>
              <p v-if="!pageUrl" class="hint">Enter the live page URL under Details / Data</p>
              <p class="tests-cost-note">Generating or regenerating test scripts uses AI tokens; running saved tests does not.</p>
              <div class="burst-host">
                <TokenBurst :burst="burst" target="tests" />
                <TestsPanel
                  :tests="tests"
                  :global-tests="globalTests"
                />
              </div>
            </section>
          </div>

          <!-- Right column widgets -->
          <aside class="content-side">
            <section class="widget">
              <h3 class="widget-title">Scores</h3>
              <template v-if="check || testsScore">
                <div v-for="row in [
                  { label: 'Checklist', sc: check ? checklistScore : null },
                  { label: 'Design match', sc: designScore },
                  { label: 'Responsive', sc: responsiveScore },
                  { label: 'Functional & API', sc: testsScore },
                ].filter((r) => r.sc)" :key="row.label" class="score-row" :class="scoreClass(row.sc)">
                  <div class="score-row-top">
                    <span>{{ row.label }}</span>
                    <strong>{{ Math.round(row.sc.passed * scoreProgress) }}<span>/{{ row.sc.total }}</span></strong>
                  </div>
                  <div class="meter"><i :style="{ width: `${scorePercent(row.sc) * scoreProgress}%` }" /></div>
                </div>
                <div v-if="check && !designScore" class="score-row none">
                  <div class="score-row-top">
                    <span>Design match</span>
                    <strong class="not-compared">Not compared</strong>
                  </div>
                  <p class="score-why">{{ figmaHasSpecs ? 'Run Check UI again to compare with Figma.' : 'No Figma design data. Retrieve Figma, then run Check UI.' }}</p>
                </div>
              </template>
              <p v-else class="widget-empty">Run Check UI or the tests to see scores.</p>
            </section>

            <section class="widget">
              <h3 class="widget-title">Sources</h3>
              <div class="agent-usage">
                <div class="agent-usage-head">
                  <span>Agent · <strong>{{ agentUsage?.agent || (status?.provider === 'codex' ? 'Codex' : 'Claude') }}</strong></span>
                  <span v-if="agentUsage?.plan" class="tag">{{ agentUsage.plan }}</span>
                </div>
                <p v-if="agentUsageError" class="agent-usage-note">Couldn't read usage: {{ agentUsageError }}</p>
                <p v-else-if="!agentUsage" class="agent-usage-note">Checking remaining usage…</p>
                <p v-else-if="!agentUsage.windows.length" class="agent-usage-note">{{ agentUsage.note || 'No usage limits reported.' }}</p>
                <div v-for="w in agentUsage?.windows || []" :key="w.label" class="agent-window">
                  <div class="agent-window-top">
                    <span>{{ w.label }} left</span>
                    <!-- Plan pages round up, so "100% used" can still leave a little; the agent stops only once it is truly used up. -->
                    <strong :class="w.usedPercent >= 90 ? 'bad-text' : w.usedPercent >= 70 ? 'warn-text' : 'ok-text'">{{ w.usedPercent >= 100 ? 'Nearly used up' : `${Math.round((100 - w.usedPercent) * scoreProgress)}%` }}</strong>
                  </div>
                  <div class="meter"><i :style="{ width: `${(100 - w.usedPercent) * scoreProgress}%` }" :class="{ low: w.usedPercent >= 90 }" /></div>
                  <small v-if="w.resetsAt">Resets {{ resetText(w.resetsAt) }}</small>
                </div>
              </div>
              <ul class="source-list">
                <li>
                  <span class="src-dot" :class="{ on: jira }"></span>
                  <div>
                    <p>Jira</p>
                    <small>{{ jira ? formatDate(jira.fetchedAt) : 'Not retrieved' }}</small>
                  </div>
                  <span class="cost">{{ jira ? formatTokens(jira.ai) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: figmaHasSpecs }"></span>
                  <div>
                    <p>Figma<template v-if="figma"> · {{ figmaHasSpecs ? figma.nodeName || figma.frameName || 'Design' : 'no data' }}</template></p>
                    <small>
                      <template v-if="figma">
                        {{ [figma.pageName, figma.frameWidth && `${figma.frameWidth}×${figma.frameHeight}`].filter(Boolean).join(' · ') }}
                      </template>
                      <template v-else>Not retrieved</template>
                    </small>
                  </div>
                  <span class="cost">{{ figma ? formatTokens(figma.ai) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: tests }"></span>
                  <div>
                    <p>Test scripts</p>
                    <small>{{ tests ? `${tests.tests.length} tests · ${formatDate(tests.generatedAt)}` : 'Not generated' }}</small>
                  </div>
                  <span class="cost">{{ tests ? formatTokens(tests.ai) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: check }"></span>
                  <div>
                    <p>UI check</p>
                    <small>{{ check ? formatDate(check.checkedAt) : 'Not run yet' }}</small>
                  </div>
                  <span class="cost">{{ check ? formatTokens(check.ai) : '' }}</span>
                </li>
                <li class="source-total">
                  <span></span>
                  <div>
                    <p>Total</p>
                    <small>All sources on this ticket</small>
                  </div>
                  <span class="cost">{{ totalTokens == null ? '' : formatTokenCount(totalTokens) }}</span>
                </li>
              </ul>
            </section>
          </aside>
        </div>
      </template>
    </main>

    <ConfirmDialog ref="confirmDialog" />
    <NewTicketDialog ref="newTicketDialog" :create="createTicket" />
    <FrameSelectDialog ref="frameSelectDialog" />
    <FigmaProjectDialog ref="figmaProjectDialog" />
    <FigmaSaveProjectDialog ref="figmaSaveDialog" />
  </div>
</template>
