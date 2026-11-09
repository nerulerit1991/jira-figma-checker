<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { api } from './api.js';
import globalCasesCatalog from '../data/global-test-cases/cases.json';
import McpStatus from './components/McpStatus.vue';
import Checklist from './components/Checklist.vue';
import TicketNav from './components/TicketNav.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import SignInChallengeDialog from './components/SignInChallengeDialog.vue';
import NewTicketDialog from './components/NewTicketDialog.vue';
import FrameSelectDialog from './components/FrameSelectDialog.vue';
import FigmaProjectDialog from './components/FigmaProjectDialog.vue';
import FigmaSaveProjectDialog from './components/FigmaSaveProjectDialog.vue';
import { parseFigmaUrl } from '../server/figma.js';
import { itemsVerifiedBy, testStatusOf } from '../server/checklist.js';
import { screenState, checkedScreens } from '../server/flowScope.js';
import DesignMatch from './components/DesignMatch.vue';
import DesignChecklist from './components/DesignChecklist.vue';
import ResponsiveReport from './components/ResponsiveReport.vue';
import ViewportSettings from './components/ViewportSettings.vue';
import TestsPanel from './components/TestsPanel.vue';
import Improvements from './components/Improvements.vue';
import FlowPanel from './components/FlowPanel.vue';
import ScreenTabs from './components/ScreenTabs.vue';
import TokenBurst from './components/TokenBurst.vue';
import TourGuide from './components/TourGuide.vue';
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
// "What can be improved?" (improvements.json): advice beyond the AC; never part of a score.
const improvements = ref(null);
// Interaction flow: the screens Figma's prototype links lead to from the frame (flow.json), and their last check.
const flow = ref(null);
const flowCheck = ref(null);
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
// The saved session: runs reuse it while it still gets past the login and sign in again once it does not.
// On sites with an OTP or CAPTCHA, signing in asks for it in a pop-up (SignInChallengeDialog).
const sessionBusy = ref(false);
const sessionNote = computed(() => {
  const otp = login.value?.humanCheck ? ' This site asks for an OTP or CAPTCHA each time it signs in again.' : '';
  return login.value?.sessionSavedAt
    ? `Session saved ${formatDate(login.value.sessionSavedAt)}; runs reuse it until it expires.${otp}`
    : `No saved session: the next run signs in.${otp}`;
});
// Why the last sign-in failed (Sign in now or a run), shown beside the toggle: the request's own error,
// else the failed result the server saved. Cleared when a sign-in starts.
const signInError = ref('');
const loginError = computed(() => {
  if (sessionBusy.value) return '';
  if (signInError.value) return signInError.value;
  return login.value?.last && !login.value.last.ok ? login.value.last.message : '';
});
async function signInNow() {
  const key = selectedKey.value;
  sessionBusy.value = true;
  signInError.value = '';
  try {
    const settings = await api.signIn(key);
    if (selectedKey.value !== key) return;
    applyLogin(settings);
  } catch (e) {
    if (selectedKey.value === key) signInError.value = e.message;
  } finally {
    sessionBusy.value = false;
  }
}
async function forgetSessionNow() {
  const key = selectedKey.value;
  sessionBusy.value = true;
  try {
    const settings = await api.forgetSession(key);
    if (selectedKey.value === key) applyLogin(settings);
  } catch (e) {
    if (selectedKey.value === key) error.value = e.message;
  } finally {
    sessionBusy.value = false;
  }
}
// The OTP or CAPTCHA typed in the pop-up, or null (Cancel), for the sign-in step waiting on the open ticket.
const challengeBusy = ref(false);
async function answerChallenge(value) {
  const key = selectedKey.value;
  const pending = login.value?.challenge;
  if (!pending) return;
  challengeBusy.value = true;
  try {
    const settings = await api.answerChallenge(key, pending.id, value);
    if (selectedKey.value === key) applyLogin(settings);
  } catch (e) {
    if (selectedKey.value === key) error.value = e.message;
  } finally {
    challengeBusy.value = false;
  }
}
// Only while a sign-in can be happening (Sign in now, a run on the ticket, which may sign in again or turn login on
// by itself, or a pop-up still open), re-read the login every few seconds so an OTP or CAPTCHA step opens the pop-up.
// Signed in and idle, nothing can change, so nothing is requested.
setInterval(() => {
  const key = selectedKey.value;
  if (!key || loginSaving.value || document.visibilityState !== 'visible') return;
  if (sessionBusy.value || ticketBusy(key) || login.value?.challenge) refreshLogin(key);
}, 2500);
// Running jobs keyed "<ticket>:<action>", so work on one ticket never shows on another
// and different actions on the same ticket (e.g. Jira and Figma) can run at once.
const jobs = ref({});
// Tickets whose Generate is between its click and its job (confirm dialog), so a double click starts nothing twice.
const generatePending = ref({});
const generatingTestsPending = computed(() => Boolean(generatePending.value[selectedKey.value]));
const isBusy = (action, key = selectedKey.value) => Boolean(jobs.value[`${key}:${action}`]);

// What Retrieve is doing right now ("Creating the checklist with AI…"), polled from the server while it runs.
const retrieveStep = ref({ jira: null, figma: null });
let stepTimer = null;
watch(
  () => [selectedKey.value, isBusy('jira'), isBusy('figma')],
  ([key, jiraBusy, figmaBusy]) => {
    clearInterval(stepTimer);
    retrieveStep.value = { jira: null, figma: null };
    if (!key || (!jiraBusy && !figmaBusy)) return;
    const poll = async () => {
      try {
        const p = await api.progress(key);
        if (selectedKey.value === key) retrieveStep.value = { jira: isBusy('jira') ? p.jira : null, figma: isBusy('figma') ? p.figma : null };
      } catch {
        // A missed poll just leaves the last message up.
      }
    };
    poll();
    stepTimer = setInterval(poll, 700);
  },
);
onBeforeUnmount(() => clearInterval(stepTimer));
const ticketBusy = (key) => Object.keys(jobs.value).some((id) => id.startsWith(`${key}:`));
const anyBusy = computed(() => Object.keys(jobs.value).length > 0);
// Check UI, tests and suggestions read the Details / Data section (links, sources, login), so it is locked while they run.
const DATA_USERS = ['check', 'flow', 'tests', 'run', 'improvements'];
const dataLocked = computed(() => DATA_USERS.some((action) => isBusy(action)));
const busyKeys = computed(() => [...new Set(Object.keys(jobs.value).map((id) => id.split(':')[0]))]);
const error = ref('');

const confirmDialog = ref(null);
const newTicketDialog = ref(null);
const frameSelectDialog = ref(null);
const figmaProjectDialog = ref(null);
const figmaSaveDialog = ref(null);

// Each acceptance item is shown in the card of the step that verifies it (see server/checklist.js).
const liveItems = computed(() => itemsVerifiedBy(jira.value?.checklist, 'live'));
const playwrightItems = computed(() => itemsVerifiedBy(jira.value?.checklist, 'playwright'));
const notTestableItems = computed(() => itemsVerifiedBy(jira.value?.checklist, 'not-testable'));
// ---- Screen tabs: screen S0 is the ticket's frame (check.json), S1… each page or modal reached by clicking
// (flow-check.json) that the Jira checklist has items about. Each item belongs to one screen (flow.json
// checklistScreens), so the tabs together cover the whole ticket. Screens the ticket does not mention get no tab.
const tabScreens = computed(() => (flow.value?.screens || []).filter((s) => ['start', 'checked', 'risky'].includes(screenState(flow.value, s))));
const flowTabsOn = computed(() => tabScreens.value.length > 1);
const activeScreen = ref('S0');
watch(selectedKey, () => { activeScreen.value = 'S0'; });
watch(flowTabsOn, (on) => { if (!on) activeScreen.value = 'S0'; });
const screenById = (id) => flow.value?.screens?.find((s) => s.id === id) || null;
// A flow result belongs to a screen only while the screen still points at the same Figma frame.
const flowResultOf = (id) => {
  const s = screenById(id);
  return (s && flowCheck.value?.screens?.find((r) => r.id === id && r.nodeId === s.nodeId)) || null;
};
const screenOfItem = (id) => (flowTabsOn.value && flow.value.checklistScreens?.assignments?.[id]) || 'S0';
// Playwright items (they need a click) join a flow screen's tab when reaching that screen proves them.
const flowPlaywrightItems = computed(() => playwrightItems.value.filter((i) => /^S[1-9]/.test(screenOfItem(i.id))));
const tabItems = computed(() => [...liveItems.value, ...flowPlaywrightItems.value]);
const itemsOfScreen = (id) => tabItems.value.filter((i) => screenOfItem(i.id) === id);
// What the Checklist component reads for a screen: the main check for S0, the flow screen's results otherwise.
const checkOfScreen = (id) => (id === 'S0' ? check.value : flowResultOf(id) && { results: flowResultOf(id).results || [] });
const designOfScreen = (id) => (id === 'S0' ? check.value : flowResultOf(id));
const tally = (list, ok) => (list?.length ? { passed: list.filter(ok).length, total: list.length } : null);
const sum = (scores) => {
  const parts = scores.filter((x) => x?.total);
  return parts.length ? { passed: parts.reduce((n, x) => n + x.passed, 0), total: parts.reduce((n, x) => n + x.total, 0) } : null;
};
const checklistScoreOf = (id) => {
  const results = new Map((checkOfScreen(id)?.results || []).map((r) => [r.id, r]));
  const items = itemsOfScreen(id);
  return items.length ? { passed: items.filter((i) => results.get(i.id)?.passed).length, total: items.length } : null;
};
const designScoreOf = (id) => {
  const d = designOfScreen(id);
  return d?.designChecklist?.length ? tally(d.designChecklist, (x) => x.passed) : tally(d?.designMatch?.rows, (x) => x.match);
};
const responsiveScoreOf = (id) => tally((id === 'S0' ? check.value : flowResultOf(id))?.responsive, (x) => x.passed);
const screenIds = computed(() => (flowTabsOn.value ? tabScreens.value.map((s) => s.id) : ['S0']));
const tabsFor = (scoreOf) =>
  tabScreens.value.map((s) => ({
    id: s.id,
    label: s.name,
    kind: s.kind,
    off: screenState(flow.value, s) === 'risky',
    score: scoreOf(s.id),
  }));
const shotOfScreen = (id) => (vp) =>
  `/api/tickets/${encodeURIComponent(selectedKey.value)}/flow/screenshot/${id}/${vp}?t=${encodeURIComponent(flowCheck.value?.checkedAt || '')}`;
// Why a flow screen's tab has no results: waiting to be allowed, not reached, or not checked yet.
const screenNote = (id) => {
  if (id === 'S0') return check.value ? '' : 'Not checked yet. Press play under Check UI.';
  const s = screenById(id);
  if (s && screenState(flow.value, s) === 'risky') return 'Skipped: a click on the way to this screen may change data on the site. Allow it under Interaction flow (staging with test data only).';
  const r = flowResultOf(id);
  if (!r) return 'Not checked yet. Press play under Check UI (or Check flow only).';
  return r.error ? (r.reached ? r.error : `Could not reach this screen: ${r.error}`) : '';
};

const checklistScore = computed(() => {
  const scores = screenIds.value.map(checklistScoreOf);
  return { passed: sum(scores)?.passed || 0, total: tabItems.value.length };
});
// Playwright items no generated test covers; Functionality lists them as gaps.
const uncoveredItems = computed(() =>
  tests.value ? playwrightItems.value.filter((i) => testStatusOf(i.id, tests.value).status === 'no-test') : [],
);
// Older checks have only the property table; newer ones have the per-category design checklist.
const designScore = computed(() => sum(screenIds.value.map(designScoreOf)));
const responsiveScore = computed(() => sum(screenIds.value.map(responsiveScoreOf)));
const hasDesignResults = computed(() => Boolean(check.value?.designChecklist?.length || check.value?.designMatch?.rows?.length || (flowTabsOn.value && designScore.value)));
const hasResponsiveResults = computed(() => Boolean(check.value?.responsive?.length || (flowTabsOn.value && responsiveScore.value)));
const testsScore = computed(() => {
  const r = tests.value?.results;
  return r && r.passed + r.failed ? { passed: r.passed, total: r.passed + r.failed } : null;
});
// Check UI totals across its three parts (acceptance checklist, Figma design categories, responsive viewports),
// shown like the test run line: "N passed · N failed".
const checkCounts = computed(() => {
  const parts = [checklistScore.value, designScore.value, responsiveScore.value].filter((x) => x?.total);
  if (!check.value || !parts.length) return null;
  const passed = parts.reduce((sum, x) => sum + x.passed, 0);
  return { passed, failed: parts.reduce((sum, x) => sum + x.total, 0) - passed };
});
const seconds = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);
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

// Every AI call on this ticket (data/<KEY>/token-log.json), so re-fetches add up instead of replacing the last cost.
const ticketTokens = ref(null);
const sourceTokens = (source) => ticketTokens.value?.bySource?.[source] || { tokens: 0, calls: 0 };
const totalTokens = computed(() => (ticketTokens.value?.calls ? ticketTokens.value.total : null));
const runsText = (source) => (sourceTokens(source).calls > 1 ? ` · ${sourceTokens(source).calls} AI runs` : '');
async function refreshTokens(key) {
  try {
    const totals = await api.tokens(key);
    if (selectedKey.value === key) ticketTokens.value = totals;
  } catch {
    /* non-critical: the next ticket load shows it */
  }
}

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
  ticket.value = jira.value = figma.value = check.value = checkErrors.value = improvements.value = tests.value = flow.value = flowCheck.value = null;
  ticketTokens.value = null;
  figmaSaved.value = null;
  applyLogin(null);
  signInError.value = '';
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
    improvements.value = data.improvements || null;
    flow.value = data.flow || null;
    flowCheck.value = data.flowCheck || null;
    tests.value = data.tests;
    globalTests.value = data.globalTests;
    ticketTokens.value = data.tokens || null;
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
    if (['jira', 'figma', 'check', 'flow', 'tests', 'improvements'].includes(action)) loadAgentUsage(true);
    return true;
  } catch (e) {
    if (FIELD_ERRORS.has(action)) fieldErrors.value = { ...fieldErrors.value, [id]: e.message };
    else error.value = selectedKey.value === key ? e.message : `${key}: ${e.message}`;
    return false;
  } finally {
    const { [id]: _, ...rest } = jobs.value;
    jobs.value = rest;
    if (['check', 'flow', 'tests', 'run'].includes(action)) refreshLogin(key);
    // AI runs add to the ticket's token total, also when they fail after the agent answered.
    if (['jira', 'figma', 'check', 'flow', 'tests', 'improvements'].includes(action)) refreshTokens(key);
  }
}

// Where Jira is read from, remembered per ticket: "mcp" (selected agent's local Atlassian MCP)
// or "api" (Jira REST API with JIRA_EMAIL + JIRA_API_TOKEN; only the checklist step uses AI).
// The API sources come first: they read Jira and Figma without AI tokens (the card title says they are recommended).
const JIRA_TABS = [
  { via: 'api', label: 'Jira API' },
  { via: 'mcp', label: 'Jira MCP' },
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

// Retrieving again starts the ticket fresh: a new checklist would not match the old tests and results (they are
// linked by checklist ids such as C3), so after a confirm they are all removed. Figma data and links stay.
async function retrieveJira() {
  const key = selectedKey.value;
  const force = Boolean(jira.value);
  if (force) {
    const ok = await confirmDialog.value.ask({
      title: 'Retrieve the Jira ticket again?',
      message: 'This resets the ticket: the checklist is rebuilt, and all tests (ticket and default), test results, Check UI results and suggestions are removed. Figma data and links are kept. Creating the checklist uses AI tokens.',
      confirmLabel: 'Reset and retrieve',
    });
    if (!ok || selectedKey.value !== key) return;
  }
  const via = jiraVia.value;
  noteRun('jira', status.value?.runs && jiraRunLabel.value);
  return run('jira', (key) => api.fetchJira(key, force, via, force), (res) => {
    jira.value = res.data;
    if (res.flow) flow.value = res.flow;
    if (res.reset) {
      tests.value = check.value = checkErrors.value = improvements.value = flowCheck.value = null;
      globalTests.value = { ...globalTests.value, results: null, errors: null };
    }
    if (!res.cached) showBurst('jira', res.data.ai);
    if (!figmaUrl.value && res.data.figmaLinks?.length) figmaUrl.value = res.data.figmaLinks[0];
  });
}

// Where Figma is read from, remembered per ticket. Each tab uses only its own source:
// "mcp" (selected agent's local Figma MCP), "bridge" (the frame selected in the Figma desktop app)
// or "api" (Figma REST API; the whole file is saved in data/full-figma/, into the project folder chosen at retrieve).
const FIGMA_TABS = [
  { via: 'api', label: 'Figma API' },
  { via: 'mcp', label: 'Figma MCP online' },
  { via: 'bridge', label: 'Figma MCP bridge' },
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
    // The API tab maps the new frame's prototype links straight away; other tabs have none to follow.
    if ('flow' in res) flow.value = res.flow;
    else if (via !== 'api') flow.value = null;
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
  return run('figma', (key) => api.useFigmaFrame(key, frame.id, pick.fileKey), ({ data, flow: map }) => {
    figma.value = data;
    flow.value = map || null;
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
  const ok = await run('check', (key) => api.checkUi(key, url), (res) => {
    check.value = res.data;
    checkErrors.value = res.errors;
    if (res.flow) flow.value = res.flow;
    showBurst('check', res.data.ai);
  });
  // The same run continues into each page and modal the frame's prototype links open that the ticket talks about.
  if (ok && selectedKey.value === key && checkedScreens(flow.value).length) await checkFlow();
}

// ---- Interaction flow ----
// Names of the modals and pages the flow check opens, for the status line while it runs.
const flowScreenNames = computed(() => checkedScreens(flow.value).map((sc) => sc.name).filter(Boolean).join(', '));
const flowApiFrame = computed(() => figma.value?.via === 'api' && Boolean(figma.value?.nodeId));

function checkFlow() {
  const url = pageUrl.value;
  return run('flow', (key) => api.checkFlow(key, url), ({ flow: map, ...res }) => {
    flowCheck.value = res;
    if (map) flow.value = map;
    showBurst('check', res.ai);
  });
}
// The one setting left: letting the flow click through to a screen behind a click that may change data.
const allowRiskyScreen = (id, on) => run('flow-map', (key) => api.updateFlow(key, { allowRisky: { [id]: on } }), (res) => { flow.value = res; });

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
        message: 'Claude rewrites the ticket-specific scripts from the ticket and current page. Default test cases are kept separate. This uses tokens again and replaces the saved ticket scripts and last results.',
        confirmLabel: 'Regenerate',
        danger: false,
      });
      if (!ok || selectedKey.value !== key) return;
    }
    const url = pageUrl.value;
    noteRun('tests', status.value?.runs && [`Tests via ${runLabel('analysis')}`]);
    await run('tests', (key) => api.generateTests(key, url), (res) => {
      tests.value = res;
      showBurst('tests', res.ai);
    });
  } finally {
    const { [key]: _, ...rest } = generatePending.value;
    generatePending.value = rest;
  }
}

// Lists gaps, loopholes and improvements beyond the AC (uses tokens). Regenerating replaces the saved list.
async function findImprovements() {
  const key = selectedKey.value;
  if (isBusy('improvements')) return;
  if (improvements.value) {
    const ok = await confirmDialog.value.ask({
      title: 'Regenerate suggestions?',
      message: 'The AI reads the ticket and the live page again and replaces the saved list. This uses tokens again.',
      confirmLabel: 'Regenerate',
      danger: false,
    });
    if (!ok || selectedKey.value !== key) return;
  }
  const url = pageUrl.value;
  noteRun('improvements', status.value?.runs && [`Suggestions via ${runLabel('analysis')}`]);
  return run('improvements', (key) => api.findImprovements(key, url), (res) => {
    improvements.value = res.data;
    showBurst('improvements', res.data.ai);
  });
}
const improvementCounts = computed(() => {
  const items = improvements.value?.items || [];
  return { total: items.length, high: items.filter((i) => i.severity === 'high').length };
});

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

// A person reviewed a generated script (or withdraws that); only verified scripts run.
const verifyBusy = ref(null);
async function verifyScript({ file, hash, verified }) {
  const key = selectedKey.value;
  if (!key || verifyBusy.value) return;
  verifyBusy.value = file;
  try {
    const res = await api.verifyScript(key, file, hash, verified);
    if (selectedKey.value === key) tests.value = res;
  } catch (e) {
    // The script changed under the reviewer (e.g. regenerated in another tab): show the new version.
    if (selectedKey.value === key) {
      await loadTicket(key).catch(() => {});
      error.value = e.message;
    }
  } finally {
    verifyBusy.value = null;
  }
}

// Re-runs only the tests that failed last time (ticket and default); passing results are kept.
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

// ---- Guided tour: walks through the real flow on a throwaway TOUR-1 ticket (no tokens), removed at the end. ----
const tourOpen = ref(false);
const TOUR_KEY = 'TOUR-1';
const TOUR_URL = `https://example.atlassian.net/browse/${TOUR_KEY}`;
const TOUR_JIRA = {
  key: TOUR_KEY,
  summary: '[Tour] Login page: email, password and error message',
  status: 'For checking',
  issueType: 'Story',
  priority: 'Medium',
  assignee: null,
  labels: [],
  lastUpdated: new Date().toISOString(),
  lastUpdatedBy: 'Walkthrough',
  description: 'Sample ticket made by the walkthrough. It is removed when the tour ends.',
  acceptanceText: '',
  figmaLinks: [],
  otherLinks: [],
  checklist: [
    { id: 'C1', item: 'Login form shows email and password fields', category: 'ui', verifyBy: 'live' },
    { id: 'C2', item: 'Primary button reads "Sign in"', category: 'ui', verifyBy: 'live' },
    { id: 'C3', item: 'Wrong password shows an error message', category: 'behavior', verifyBy: 'playwright' },
  ],
};
const TOUR_FIGMA_URL = 'https://www.figma.com/design/EXAMPLE/Login?node-id=1-2';
const TOUR_PAGE_URL = 'http://localhost:3000/login';
let tourPrevKey = null;
// Shows a step's real spinner for a moment without calling the server.
function tourFake(action, ms) {
  if (selectedKey.value !== TOUR_KEY) return;
  return run(action, () => sleep(ms), () => {});
}
let tourMadeTicket = false;
let tourAdding = null;

const tour = {
  start() {
    tourPrevKey = selectedKey.value;
    tourMadeTicket = !tickets.value.some((t) => t.key === TOUR_KEY);
  },
  openDialog: () => newTicketDialog.value.open({ modal: false }),
  typeUrl: () => newTicketDialog.value.typeUrl(TOUR_URL),
  // Real create: only writes data/TOUR-1/ticket.json, no tokens.
  addTicket() {
    tourAdding = newTicketDialog.value.submit();
    return tourAdding;
  },
  // Simulated retrieve: shows the real spinner, then fills sample Jira data locally (nothing is fetched or saved).
  async retrieve() {
    if (selectedKey.value !== TOUR_KEY) return;
    await run('jira', () => sleep(1400).then(() => ({ data: TOUR_JIRA })), (res) => (jira.value = res.data));
  },
  // The rest is acted out only: the real spinners run, but nothing is fetched, checked, written or saved.
  async typeFigma() {
    if (selectedKey.value !== TOUR_KEY) return;
    figmaUrl.value = '';
    for (const ch of TOUR_FIGMA_URL) {
      figmaUrl.value += ch;
      await sleep(18);
    }
  },
  retrieveFigma: () => tourFake('figma', 1400),
  async typePageUrl() {
    if (selectedKey.value !== TOUR_KEY) return;
    pageUrl.value = '';
    for (const ch of TOUR_PAGE_URL) {
      pageUrl.value += ch;
      await sleep(25);
    }
  },
  checkUi: () => tourFake('check', 1800),
  generateTests: () => tourFake('tests', 1800),
  runTests: () => tourFake('run', 1600),
  async end() {
    // Finish a still-running Add first, so the ticket it creates is not left behind.
    await tourAdding?.catch(() => {});
    tourAdding = null;
    newTicketDialog.value?.close();
    if (tourMadeTicket) {
      await api.deleteTicket(TOUR_KEY).catch(() => {}); // 404 when the tour ended before Add ticket
      clearFieldErrors(TOUR_KEY);
      await loadTickets();
    }
    selectedKey.value = tickets.value.some((t) => t.key === tourPrevKey) ? tourPrevKey : tickets.value[0]?.key ?? null;
    tourMadeTicket = false;
  },
};

// A tour cut off mid-way (page reload, closed tab) leaves TOUR-1 behind; remove it on the next load.
// Only a ticket the tour made (its example link, never retrieved) is removed, never a real TOUR-1.
async function removeStaleTourTicket() {
  try {
    const list = await api.tickets();
    const t = list.find((x) => x.key === TOUR_KEY);
    if (!t || t.hasJira) return;
    const { ticket: saved } = await api.ticket(TOUR_KEY);
    if (saved?.jiraUrl === TOUR_URL) await api.deleteTicket(TOUR_KEY);
  } catch {
    /* non-critical */
  }
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

// Viewports the responsive check renders at (app-wide setting, edited in the Responsive layout section).
const viewports = ref([]);
const viewportList = computed(() => viewports.value.map((v) => v.name).join(', ') || 'desktop, tablet and mobile');
async function loadViewports() {
  try {
    viewports.value = (await api.viewports()).viewports;
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(async () => {
  loadStatus();
  loadViewports();
  loadAgentUsage();
  try {
    await removeStaleTourTicket();
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
        <!-- Wordmark "C{}DE": the O is a pair of code braces (same braces as public/favicon.svg). -->
        <span class="logo-word" role="img" aria-label="Figplayra">
          <span aria-hidden="true">C</span><svg class="logo-o" viewBox="0 0 40 40" aria-hidden="true">
            <path d="M16 4c-5 0-7 2-7 7v4c0 3-2 5-5 5 3 0 5 2 5 5v4c0 5 2 7 7 7M24 4c5 0 7 2 7 7v4c0 3 2 5 5 5-3 0-5 2-5 5v4c0 5-2 7-7 7" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg><span aria-hidden="true">DE</span>
        </span>
        <button class="icon help-btn" title="Show tour" aria-label="Show tour" @click="tourOpen = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
        </button>
      </div>

      <div class="ticket-actions">
        <button class="primary new-btn" data-tour="new-ticket" @click="newTicketDialog.open()">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          New ticket
        </button>
        <button v-if="tickets.length" class="ghost reset-btn" :disabled="anyBusy" @click="resetAll">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
          Reset all
        </button>
      </div>

      <TicketNav data-tour="tickets" v-model="selectedKey" :tickets="tickets" :busy-keys="busyKeys" @reorder="reorderTickets" />

      <div class="sidebar-foot" data-tour="connections">
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
            <section class="card" data-tour="details">
              <div class="card-head">
                <span class="step">01</span>
                <h2>Details / Data</h2>
                <span class="card-note">Jira API and Figma API are recommended</span>
                <span v-if="clickedRuns.jira || clickedRuns.figma" class="run-chips">
                  <span v-for="chip in clickedRuns.jira" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('jira') }">{{ chip }}</span>
                  <span v-for="chip in clickedRuns.figma" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('figma') }">{{ chip }}</span>
                </span>
              </div>

              <!-- A disabled fieldset disables every input, radio and button inside it. -->
              <fieldset class="sources" :disabled="dataLocked" :title="dataLocked ? 'Locked while a check or test runs on these details' : null">
                <div class="source" data-tour="jira-section">
                  <span class="field-label">Jira section<span v-if="isBusy('jira')" class="retrieve-step" aria-live="polite">{{ retrieveStep.jira || 'Retrieving…' }}</span></span>
                  <div class="via-row">
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
                  <span v-if="jiraVia === 'api'" class="token-help">
                    Generate a token:
                    <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com › API tokens</a>
                  </span>
                  </div>
                  <div class="inline-field">
                    <input id="jira-link" :value="ticket.jiraUrl" readonly />
                    <TokenBurst :burst="burst" target="jira" />
                    <button class="primary small" data-tour="retrieve-jira" :disabled="isBusy('jira')" @click="retrieveJira" aria-label="Retrieve Jira">
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

                <div class="source" data-tour="figma-section">
                  <span class="field-label">Figma section<span v-if="isBusy('figma')" class="retrieve-step" aria-live="polite">{{ retrieveStep.figma || 'Retrieving…' }}</span></span>
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
                    <span v-if="figmaVia === 'api'" class="token-help">
                      Generate a token:
                      <a href="https://www.figma.com/" target="_blank" rel="noopener noreferrer">figma.com</a>
                      › profile › Settings › Security › Generate new token
                    </span>
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
                      data-tour="retrieve-figma"
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

                <div class="source" data-tour="page-url">
                  <label class="field-label" for="page-link">Page URL</label>
                  <div class="inline-field">
                    <input id="page-link" v-model.trim="pageUrl" aria-label="Page URL" aria-describedby="page-link-note" placeholder="http://localhost:3000/login" @change="saveLinks" />
                  </div>
                  <!-- Generated tests click, type and create test records on this site. -->
                  <p id="page-link-note" class="url-note">⚠ Use a staging, UAT or local URL only. Do not use production: tests interact with the site and create test records.</p>
                  <!-- Used by Check UI, Re-check and the tests: each signs in first when on. -->
                  <div class="login-row">
                    <label class="login-toggle" :class="{ on: loginOn }">
                      <input v-model="loginOn" type="checkbox" aria-label="Requires login" :disabled="loginSaving" @change="toggleLogin" />
                      <span class="switch-track" aria-hidden="true"></span>
                      Requires login
                    </label>
                    <span v-if="loginOn && loginError" class="login-error" role="alert">{{ loginError }}</span>
                  </div>
                  <Transition name="login-note">
                    <p v-show="loginOn" class="login-note" :class="{ settled: loginNoteSettled }">
                      {{ loginNote }}
                    </p>
                  </Transition>
                  <div v-if="loginOn && login?.hasPassword" class="session-row">
                    <span>{{ sessionNote }}</span>
                    <button class="ghost session-btn" :disabled="sessionBusy" @click="signInNow">{{ sessionBusy ? 'Signing in…' : 'Sign in now' }}</button>
                    <button v-if="login.sessionSavedAt" class="ghost session-btn" :disabled="sessionBusy" @click="forgetSessionNow">Forget session</button>
                  </div>
                </div>
              </fieldset>
              <p v-if="dataLocked" class="hint">Details are locked while a check or test runs on them.</p>

            </section>

            <!-- 02 Check -->
            <section class="card" data-tour="check">
              <div class="card-head tests-card-head">
                <span class="step">02</span>
                <h2>Check UI</h2>
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
                <button class="primary small" :disabled="!jira?.checklist?.length || !pageUrl || isBusy('check') || isBusy('flow') || isBusy('jira') || isBusy('figma')" data-tour="check-ui" @click="checkUi" aria-label="Check UI">
                  <span v-if="isBusy('check') || isBusy('flow')" class="spinner" aria-hidden="true"></span>
                  <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" /></svg>
                </button>
              </div>
              <!-- Same format as the "Last ticket test run" line in Functional & API tests. -->
              <p v-if="check?.checkedAt" class="meta check-run-meta">
                Last UI check {{ formatDate(check.checkedAt) }}<template v-if="check.durationMs != null"> · {{ seconds(check.durationMs) }}</template><template v-if="checkCounts"> ·
                <span class="ok-text">{{ checkCounts.passed }} passed</span> ·
                <span :class="{ 'bad-text': checkCounts.failed }">{{ checkCounts.failed }} failed</span></template>
                <template v-if="check.recheckedAt"> · errors re-checked {{ formatDate(check.recheckedAt) }}<template v-if="check.recheckDurationMs != null"> ({{ seconds(check.recheckDurationMs) }})</template></template>
              </p>
              <p v-if="!jira" class="hint">Retrieve the Jira ticket first to build the checklist.</p>
              <p v-else-if="!pageUrl" class="hint">Enter the live page URL under Details / Data to enable play.</p>
              <p v-else-if="isBusy('check')" class="hint run-step" aria-live="polite"><span class="retrieve-step">Rendering at {{ viewportList }}, then comparing with Jira and Figma…</span></p>
              <p v-else-if="isBusy('flow')" class="hint run-step" aria-live="polite"><span class="retrieve-step">Opening and checking {{ flowScreenNames || 'the linked modals and pages' }} against Figma…</span></p>
              <p v-if="check?.warning" class="warn-text">{{ check.warning }}</p>

              <template v-if="jira?.checklist?.length">
                <FlowPanel
                  v-if="figmaHasSpecs"
                  :flow="flow"
                  :flow-need="jira?.flow || null"
                  :flow-check="flowCheck"
                  :check="check"
                  :api-frame="flowApiFrame"
                  :busy="isBusy('flow')"
                  :locked="isBusy('flow') || isBusy('flow-map') || isBusy('check') || isBusy('figma')"
                  @allow="allowRiskyScreen"
                  @run="checkFlow"
                />

                <details v-if="liveItems.length" class="accordion">
                  <summary>
                    <span class="acc-title">Acceptance checklist</span>
                    <span v-if="check || flowCheck" class="score-chip" :class="scoreClass(checklistScore)">
                      {{ checklistScore.passed }}/{{ checklistScore.total }}
                    </span>
                    <span v-else class="score-chip">{{ liveItems.length }} items</span>
                    <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </summary>
                  <template v-if="flowTabsOn">
                    <ScreenTabs v-model="activeScreen" :tabs="tabsFor(checklistScoreOf)" />
                    <div class="tab-panel">
                      <p v-if="screenNote(activeScreen)" class="hint">{{ screenNote(activeScreen) }}</p>
                      <Checklist v-if="itemsOfScreen(activeScreen).length" :items="itemsOfScreen(activeScreen)" :check="checkOfScreen(activeScreen)" :show-score="false" />
                      <p v-else class="hint">No Jira checklist items are about this screen.</p>
                      <p v-if="!flow.checklistScreens" class="acc-note">The checklist is split across the screens on the next check; until then every item is listed here.</p>
                    </div>
                  </template>
                  <Checklist v-else :items="liveItems" :check="check" :show-score="false" />
                </details>

                <details v-if="hasDesignResults" class="accordion">
                  <summary>
                    <span class="acc-title">Figma vs live</span>
                    <span v-if="designScore" class="score-chip" :class="scoreClass(designScore)">
                      {{ designScore.passed }}/{{ designScore.total }}
                    </span>
                    <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </summary>
                  <ScreenTabs v-if="flowTabsOn" v-model="activeScreen" :tabs="tabsFor(designScoreOf)" />
                  <div class="tab-panel">
                    <p v-if="flowTabsOn && screenNote(activeScreen)" class="hint">{{ screenNote(activeScreen) }}</p>
                    <template v-if="designOfScreen(activeScreen)">
                      <p v-if="activeScreen !== 'S0' && designOfScreen(activeScreen).designMatch?.comparedAt" class="meta">
                        Compared at {{ designOfScreen(activeScreen).designMatch.comparedAt }} {{ designOfScreen(activeScreen).width }}px<template v-if="designOfScreen(activeScreen).landedUrl"> · {{ designOfScreen(activeScreen).landedUrl }}</template>
                      </p>
                      <DesignChecklist v-if="designOfScreen(activeScreen).designChecklist?.length" :items="designOfScreen(activeScreen).designChecklist" />
                      <details v-if="designOfScreen(activeScreen).designMatch?.rows?.length" class="more">
                        <summary>All compared properties</summary>
                        <DesignMatch :match="designOfScreen(activeScreen).designMatch" />
                      </details>
                    </template>
                    <p class="acc-note">
                      If an issue persists after you fix it, re-fetch Figma: the design may have been updated since it was last retrieved.
                    </p>
                  </div>
                </details>
                <p v-else-if="check && !figma" class="hint block-hint">Retrieve the Figma design to compare padding, margins and fonts.</p>

                <details class="accordion responsive-accordion">
                  <summary>
                    <span class="acc-title">Responsive layout</span>
                    <span v-if="responsiveScore" class="score-chip" :class="scoreClass(responsiveScore)">{{ responsiveScore.passed }}/{{ responsiveScore.total }}</span>
                    <span v-else-if="viewports.length" class="score-chip">{{ viewports.length }} viewport{{ viewports.length === 1 ? '' : 's' }}</span>
                    <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                  </summary>
                  <ViewportSettings
                    v-if="viewports.length"
                    :viewports="viewports"
                    :locked="isBusy('check') || isBusy('flow')"
                    @change="viewports = $event"
                  />
                  <p v-if="!hasResponsiveResults" class="hint">Run Check UI to see the layout at each viewport.</p>
                  <ScreenTabs v-if="hasResponsiveResults && flowTabsOn" v-model="activeScreen" :tabs="tabsFor(responsiveScoreOf)" />
                  <div v-if="hasResponsiveResults" class="tab-panel">
                    <p v-if="flowTabsOn && screenNote(activeScreen)" class="hint">{{ screenNote(activeScreen) }}</p>
                    <ResponsiveReport
                      v-if="activeScreen === 'S0' && check?.responsive?.length"
                      :responsive="check.responsive"
                      :screenshots="check.screenshots"
                      :ticket-key="selectedKey"
                      :checked-at="check.checkedAt"
                    />
                    <ResponsiveReport
                      v-else-if="activeScreen !== 'S0' && flowResultOf(activeScreen)?.responsive?.length"
                      :responsive="flowResultOf(activeScreen).responsive"
                      :screenshots="flowResultOf(activeScreen).screenshots || []"
                      :ticket-key="selectedKey"
                      :checked-at="flowCheck.checkedAt"
                      :shot-url="shotOfScreen(activeScreen)"
                    />
                  </div>
                </details>

                <template v-if="check?.summary || (flowTabsOn && flowCheck)">
                  <h3 class="block-title">Findings</h3>
                  <template v-if="flowTabsOn">
                    <template v-for="(s, i) in flow.screens" :key="s.id">
                      <p v-if="s.kind === 'start' ? check?.summary : flowResultOf(s.id)?.summary" class="findings-screen">{{ i + 1 }} · {{ s.name }}</p>
                      <ul v-if="s.kind === 'start' ? check?.summary : flowResultOf(s.id)?.summary" class="list">
                        <li v-for="(line, j) in (s.kind === 'start' ? check.summary : flowResultOf(s.id).summary).split(/(?<=[.;])\s+/).filter(Boolean)" :key="j">{{ line }}</li>
                      </ul>
                    </template>
                  </template>
                  <ul v-else class="list">
                    <li v-for="(line, i) in check.summary.split(/(?<=[.;])\s+/).filter(Boolean)" :key="i">{{ line }}</li>
                  </ul>
                </template>
              </template>
            </section>

            <!-- 03 Functional & API tests -->
            <section class="card" data-tour="tests">
              <div class="card-head tests-card-head">
                <span class="step">03</span>
                <h2>Functional &amp; API tests</h2>
                <span v-if="clickedRuns.tests" class="run-chips">
                  <span v-for="chip in clickedRuns.tests" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('tests') }">{{ chip }}</span>
                </span>
                <div class="tests-card-actions">
                  <button class="regen-tab" data-tour="generate-tests" :disabled="!jira || !pageUrl || generatingTestsPending || isBusy('tests') || isBusy('run')" @click="generateTests">
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
                  <button v-if="canRunAnyTests" class="primary small" data-tour="run-tests" :disabled="!pageUrl || isBusy('tests') || isBusy('run')" @click="runTests()" :title="isBusy('run') ? 'Running all tests' : 'Run all tests'" :aria-label="isBusy('run') ? 'Running all tests' : 'Run all tests'">
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
                  :uncovered="uncoveredItems"
                  :verify-busy="verifyBusy"
                  @verify="verifyScript"
                >
                  <template #acceptance>
                    <details v-if="notTestableItems.length" class="accordion suite-accordion">
                      <summary>
                        <span class="acc-title">Not testable</span>
                        <span class="score-chip">{{ notTestableItems.length }} manual QA</span>
                        <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                      </summary>
                      <Checklist :items="notTestableItems" :show-score="false" />
                    </details>
                  </template>
                </TestsPanel>
              </div>
            </section>

            <!-- 04 What can be improved? -->
            <section class="card" data-tour="improve">
              <div class="card-head tests-card-head">
                <span class="step">04</span>
                <h2>What can be improved? <span class="optional-tag">(Optional)</span></h2>
                <span v-if="clickedRuns.improvements" class="run-chips">
                  <span v-for="chip in clickedRuns.improvements" :key="chip" class="run-chip" :title="chip" :class="{ busy: isBusy('improvements') }">{{ chip }}</span>
                </span>
                <div class="tests-card-actions">
                  <button class="regen-tab" :disabled="!jira || !pageUrl || isBusy('improvements')" @click="findImprovements">
                    <span v-if="isBusy('improvements')" class="spinner" aria-hidden="true"></span>
                    {{ isBusy('improvements') ? 'Thinking…' : improvements ? 'Regenerate' : 'Find improvements' }}
                  </button>
                </div>
              </div>
              <p v-if="improvements?.generatedAt" class="meta check-run-meta">
                Last generated {{ formatDate(improvements.generatedAt) }}<template v-if="improvements.durationMs != null"> · {{ seconds(improvements.durationMs) }}</template> ·
                {{ improvementCounts.total }} suggestion{{ improvementCounts.total === 1 ? '' : 's' }}<template v-if="improvementCounts.high"> · <span class="bad-text">{{ improvementCounts.high }} high</span></template>
              </p>
              <p v-if="!jira" class="hint">Retrieve the Jira ticket first.</p>
              <p v-else-if="!pageUrl" class="hint">Enter the live page URL under Details / Data</p>
              <p v-else-if="isBusy('improvements')" class="hint run-step" aria-live="polite"><span class="retrieve-step">Scanning the live page and reading the ticket for missing scenarios and loopholes…</span></p>
              <p class="tests-cost-note imp-note">AI looks past the acceptance criteria for missing scenarios, loopholes and improvements, explained in plain words. These are suggestions to discuss with the client or BA; they never change any score.</p>
              <div class="burst-host">
                <TokenBurst :burst="burst" target="improvements" />
                <template v-if="improvements">
                  <p v-if="improvements.summary" class="imp-summary">{{ improvements.summary }}</p>
                  <details v-if="improvements.items?.length" class="accordion">
                    <summary>
                      <span class="acc-title">Suggestions</span>
                      <span class="score-chip" :class="{ bad: improvementCounts.high }">{{ improvementCounts.total }}</span>
                      <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                    </summary>
                    <Improvements :items="improvements.items" />
                  </details>
                  <p v-else class="hint">No gaps found beyond the acceptance criteria.</p>
                </template>
              </div>
            </section>
          </div>

          <!-- Right column widgets -->
          <aside class="content-side" data-tour="scores">
            <section class="widget">
              <h3 class="widget-title">Scores</h3>
              <template v-if="check || testsScore">
                <div v-for="row in [
                  { label: 'Checklist', sc: check && checklistScore.total ? checklistScore : null },
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
                    <small>{{ jira ? formatDate(jira.fetchedAt) : 'Not retrieved' }}{{ runsText('jira') }}</small>
                  </div>
                  <span class="cost" :title="sourceTokens('jira').calls ? `${sourceTokens('jira').calls} AI run(s) on this ticket` : undefined">{{ sourceTokens('jira').tokens ? formatTokenCount(sourceTokens('jira').tokens) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: figmaHasSpecs }"></span>
                  <div>
                    <p>Figma<template v-if="figma"> · {{ figmaHasSpecs ? figma.nodeName || figma.frameName || 'Design' : 'no data' }}</template></p>
                    <small>
                      <template v-if="figma">
                        {{ [figma.pageName, figma.frameWidth && `${figma.frameWidth}×${figma.frameHeight}`].filter(Boolean).join(' · ') }}
                      </template>
                      <template v-else>Not retrieved</template>{{ runsText('figma') }}
                    </small>
                  </div>
                  <span class="cost" :title="sourceTokens('figma').calls ? `${sourceTokens('figma').calls} AI run(s) on this ticket` : undefined">{{ sourceTokens('figma').tokens ? formatTokenCount(sourceTokens('figma').tokens) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: tests }"></span>
                  <div>
                    <p>Test scripts</p>
                    <small>{{ tests ? `${tests.tests.length} tests · ${formatDate(tests.generatedAt)}` : 'Not generated' }}{{ runsText('tests') }}</small>
                  </div>
                  <span class="cost" :title="sourceTokens('tests').calls ? `${sourceTokens('tests').calls} AI run(s) on this ticket` : undefined">{{ sourceTokens('tests').tokens ? formatTokenCount(sourceTokens('tests').tokens) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: check }"></span>
                  <div>
                    <p>UI check</p>
                    <small>{{ check ? formatDate(check.checkedAt) : 'Not run yet' }}{{ runsText('check') }}</small>
                  </div>
                  <span class="cost" :title="sourceTokens('check').calls ? `${sourceTokens('check').calls} AI run(s) on this ticket` : undefined">{{ sourceTokens('check').tokens ? formatTokenCount(sourceTokens('check').tokens) : '' }}</span>
                </li>
                <li>
                  <span class="src-dot" :class="{ on: improvements }"></span>
                  <div>
                    <p>Improvements</p>
                    <small>{{ improvements ? `${improvementCounts.total} suggestions · ${formatDate(improvements.generatedAt)}` : 'Not generated' }}{{ runsText('improvements') }}</small>
                  </div>
                  <span class="cost" :title="sourceTokens('improvements').calls ? `${sourceTokens('improvements').calls} AI run(s) on this ticket` : undefined">{{ sourceTokens('improvements').tokens ? formatTokenCount(sourceTokens('improvements').tokens) : '' }}</span>
                </li>
                <li class="source-total">
                  <span></span>
                  <div>
                    <p>Total</p>
                    <small>Every AI run on this ticket, re-fetches included</small>
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
    <SignInChallengeDialog :challenge="login?.challenge" :busy="challengeBusy" @submit="answerChallenge" @cancel="answerChallenge(null)" />
    <NewTicketDialog ref="newTicketDialog" :create="createTicket" />
    <FrameSelectDialog ref="frameSelectDialog" />
    <FigmaProjectDialog ref="figmaProjectDialog" />
    <FigmaSaveProjectDialog ref="figmaSaveDialog" />
    <TourGuide v-model:open="tourOpen" :tour="tour" />
  </div>
</template>
