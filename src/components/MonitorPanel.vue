<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { api } from '../api.js';
import SignInChallengeDialog from './SignInChallengeDialog.vue';

// Monitoring: add website URLs (signed out, or signed in with an .env test-account profile) and see each one's
// network errors and the keys exposed in its own code (masked). One tab per website.
const profiles = ref([]);
const sites = ref([]);
const challenge = ref(null);
const url = ref('');
const profile = ref('none');
const activeId = ref(null);
const adding = ref(false);
const error = ref('');
const challengeBusy = ref(false);
let timer = null;

const TYPE_LABEL = { network: 'Network', http: 'HTTP', timeout: 'Timeout' };
const SEVERITY_LABEL = { high: 'High', medium: 'Check', info: 'Public' };
// Older runs also saved console errors and exceptions; only network errors are shown now.
const networkErrors = (site) => (site.lastRun?.errors || []).filter((e) => e.type in TYPE_LABEL);
const exposedKeys = (site) => site.lastRun?.secrets || [];
// Clean: checked, no network errors and no exposed keys (public-by-design keys still count as findings to review).
// Runs from before key scanning have no `secrets`: they are never called clean, and ask for a re-check.
const keysScanned = (site) => Array.isArray(site.lastRun?.secrets);
const isClean = (site) => site.lastRun && site.lastRun.status !== 'failed' && keysScanned(site) && !networkErrors(site).length && !exposedKeys(site).length;

// ---- Where to find it / how to replicate (built from what the run recorded) ----
const fileName = (u) => {
  try {
    const { pathname } = new URL(u);
    return pathname.split('/').filter(Boolean).pop() || pathname;
  } catch {
    return u;
  }
};
const loc = (x) => (x ? `${x.url}${x.line ? `:${x.line}` : ''}${x.column ? `:${x.column}` : ''}` : '');
const signedAs = (site) => (site.profile === 'none' ? 'signed out (use an Incognito window)' : `signed in as the "${profileLabel(site.profile)}" test account`);

/** Where a network error comes from and the steps to see it yourself. */
function networkHelp(e, site) {
  const page = e.page || site.lastRun?.finalUrl || site.url;
  const where = [{ label: 'Page', value: page }];
  for (const other of (e.pages || []).filter((p) => p !== page)) where.push({ label: 'Also on', value: other });
  if (e.url) where.push({ label: 'Request', value: `${e.method || 'GET'} ${e.url}${e.resource ? ` (${e.resource})` : ''}` });
  if (e.initiator) {
    const what = e.initiator.kind === 'html' ? 'the page HTML' : e.initiator.fn ? `${e.initiator.fn}()` : 'code';
    where.push({ label: 'Requested by', value: `${what} at ${loc(e.initiator)}` });
  }
  if (e.body) where.push({ label: 'Server said', value: e.body, mono: true });
  if (e.type === 'timeout') {
    return { where, steps: [`Open ${page} ${signedAs(site)}.`, 'Open DevTools (F12, or ⌥⌘I on Mac) → Network tab, then reload.', 'Wait: the spinner keeps going because some requests never finish. Sort by "Time" to find the slow or hanging ones.'] };
  }
  const steps = [
    `Open ${page} ${signedAs(site)}.`,
    'Open DevTools (F12, or ⌥⌘I on Mac) → Network tab, tick "Preserve log", then reload the page.',
    `Type "${fileName(e.url)}" in the Network filter box: the row shows ${e.status ? `status ${e.status}` : `"${e.message}"`}.`,
    `Click the row → "Initiator" tab to see the code that made the request${e.status ? ', and "Response" for what the server answered' : ''}.`,
  ];
  if (site.profile === 'none' && (e.method || 'GET') === 'GET' && e.url) steps.push({ text: 'Or check it from a terminal:', code: `curl -i "${e.url}"` });
  return { where, steps };
}

// What kind of file a key was found in. Runs before `resource` was saved: guessed from the URL.
function keyKind(k) {
  const r = k.resource;
  if (r === 'xhr' || r === 'fetch') return 'api';
  if (r === 'document') return 'page';
  if (r === 'script') return 'script';
  const path = (() => {
    try {
      return new URL(k.url).pathname;
    } catch {
      return '';
    }
  })();
  if (/\.(m?js|cjs)$/i.test(path)) return 'script';
  if (k.url === k.page) return 'page';
  return 'api';
}

const duration = (sec) => (sec >= 86400 ? `${Math.round(sec / 86400)} day(s)` : sec >= 3600 ? `${Math.round(sec / 3600)} hour(s)` : `${Math.round(sec / 60)} minute(s)`);

/** Where an exposed key is and how to see it yourself; the steps depend on whether it is in JS, the page or an API response. */
function keyHelp(k, site) {
  const search = k.masked.split('•')[0];
  const kind = keyKind(k);
  const page = k.page || site.lastRun?.finalUrl || site.url;
  const at = `line ${k.line}${k.column ? `, column ${k.column}` : ''}`;
  const where = [];
  if (k.original) where.push({ label: 'Source file', value: `${k.original.source}:${k.original.line}:${k.original.column}`, mono: true });
  where.push({ label: { api: 'API response', page: 'Page HTML', script: 'Built JS file' }[kind], value: `${k.url} · ${at}` });
  for (const f of (k.files || []).filter((f) => f !== k.url)) where.push({ label: 'Also in', value: f });
  where.push({ label: 'Loaded by page', value: page });
  for (const other of (k.pages || []).filter((p) => p !== page)) where.push({ label: 'Also on page', value: other });
  if (k.expiresIn) where.push({ label: 'Link valid for', value: duration(k.expiresIn) });

  const open = `Open ${page} ${signedAs(site)}.`;
  let steps;
  if (kind === 'api') {
    steps = [
      open,
      'Open DevTools (F12, or ⌥⌘I on Mac) → Network tab, tick "Preserve log", then reload the page.',
      `Click "Fetch/XHR" and type "${fileName(k.url)}" in the filter box.`,
      `Click the request → "Response" tab, click inside it and press ⌘F (Ctrl+F) to find "${search}".`,
      'This value comes from your backend, not the front-end bundle: look at the API endpoint that builds this response.',
    ];
  } else if (kind === 'page') {
    steps = [open, `Press ⌥⌘U (Ctrl+U) for the page source, then ⌘F (Ctrl+F) for "${search}" (${at}).`, 'It is in the HTML the server sends: look at the template or server-side code that renders this page.'];
  } else {
    steps = [
      open,
      'Open DevTools → Sources, press ⌥⌘F (Ctrl+Shift+F on Windows) to search every loaded script.',
      `Search for "${search}" (the start of the key): it is in ${fileName(k.url)} at ${at}. Click {} to pretty-print a minified file.`,
      k.original ? `In your repo, open ${k.original.source} at line ${k.original.line}.` : `In your repo, search the source for "${search}" or for the code around it: ${k.context}`,
    ];
  }

  let fix;
  if (k.rule === 'aws-presigned-url') {
    const long = k.expiresIn > 86400;
    fix = `Usually fine: a presigned S3 link carries only a temporary access key ID (not the secret) and a signature that expires${k.expiresIn ? ` (this one after ${duration(k.expiresIn)})` : ''}. Anyone holding the link can open that one file until then.${long ? ' This link lives long: consider a shorter expiry for private files.' : ''}`;
  } else if (k.severity === 'info') {
    fix = 'Public key: fine in the browser only if it is restricted (allowed domains / APIs) in its provider console.';
  } else if (kind === 'api') {
    fix = 'Rotate this key now, then stop the API from returning it: the browser (and anyone signed in) can read every API response.';
  } else {
    fix = 'Rotate this key now, then remove it from front-end code: call the service from your server instead. Env vars named VITE_*, NEXT_PUBLIC_*, REACT_APP_* or VUE_APP_* are built into the browser bundle.';
  }
  const sourceMapNote = k.sourceMap?.public ? `Your source maps are public (${fileName(k.sourceMap.url)}): anyone can read the original source. Consider not deploying .map files.` : null;
  return { where, steps, fix, sourceMapNote };
}

const pathOf = (u) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}` || '/';
  } catch {
    return u;
  }
};

const active = computed(() => sites.value.find((s) => s.id === activeId.value) || null);
const anyRunning = computed(() => sites.value.some((s) => s.running));
const profileLabel = (id) => profiles.value.find((p) => p.id === id)?.label || id;

// Tab name: the host, plus the path when two tabs share a host.
function tabLabel(site) {
  try {
    const u = new URL(site.url);
    const sameHost = sites.value.filter((s) => {
      try {
        return new URL(s.url).host === u.host;
      } catch {
        return false;
      }
    });
    return sameHost.length > 1 && u.pathname !== '/' ? `${u.host}${u.pathname}` : u.host;
  } catch {
    return site.url;
  }
}

function errorCount(site) {
  return networkErrors(site).reduce((n, e) => n + (e.count || 1), 0) + exposedKeys(site).length;
}

function apply(data) {
  profiles.value = data.profiles;
  sites.value = data.sites;
  challenge.value = data.challenge;
  if (!profiles.value.some((p) => p.id === profile.value)) profile.value = 'none';
  if (!sites.value.some((s) => s.id === activeId.value)) activeId.value = sites.value[0]?.id ?? null;
}

async function load() {
  try {
    apply(await api.monitor());
  } catch (e) {
    error.value = e.message;
  }
}

// Polls while a check runs (and while a sign-in waits for an OTP / CAPTCHA).
watch(anyRunning, (on) => {
  clearInterval(timer);
  timer = on ? setInterval(load, 2000) : null;
});

async function add() {
  if (!url.value.trim() || adding.value) return;
  adding.value = true;
  error.value = '';
  try {
    const before = new Set(sites.value.map((s) => s.id));
    apply(await api.addMonitorSite(url.value.trim(), profile.value));
    activeId.value = sites.value.find((s) => !before.has(s.id))?.id ?? activeId.value;
    url.value = '';
  } catch (e) {
    error.value = e.message;
  } finally {
    adding.value = false;
  }
}

async function run(site) {
  error.value = '';
  try {
    apply(await api.runMonitorSite(site.id));
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(site) {
  error.value = '';
  try {
    apply(await api.removeMonitorSite(site.id));
  } catch (e) {
    error.value = e.message;
  }
}

async function answerChallenge(value) {
  const pending = challenge.value;
  if (!pending) return;
  challengeBusy.value = true;
  try {
    apply(await api.answerMonitorChallenge(pending.profile, pending.id, value));
  } catch (e) {
    error.value = e.message;
  } finally {
    challengeBusy.value = false;
  }
}

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

onMounted(load);
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <section class="card monitor">
    <div class="card-head">
      <h2>Monitoring</h2>
      <span class="card-note">Network errors and keys exposed in each site's code</span>
    </div>

    <form class="monitor-add" @submit.prevent="add">
      <label class="field monitor-url">
        <span>Website URL</span>
        <input v-model="url" type="text" inputmode="url" placeholder="https://staging.example.com/dashboard" :disabled="adding" />
      </label>
      <label class="field monitor-profile">
        <span>Credentials</span>
        <select v-model="profile" :disabled="adding">
          <option v-for="p in profiles" :key="p.id" :value="p.id">
            {{ p.label }}{{ p.username ? ` · ${p.username}` : '' }}
          </option>
        </select>
      </label>
      <button type="submit" class="primary" :disabled="adding || !url.trim()">{{ adding ? 'Adding…' : 'Add' }}</button>
    </form>
    <p class="monitor-hint muted">
      Credentials come from <code>.env</code>: the default <code>PROJECT_USERNAME_EMAIL</code> account, and one profile per
      <code>PROJECT_&lt;NAME&gt;_USERNAME_EMAIL</code> + <code>PROJECT_&lt;NAME&gt;_PASSWORD</code> (optional <code>PROJECT_&lt;NAME&gt;_LOGIN_URL</code>). Restart the server after editing.
    </p>
    <p v-if="error" class="source-error" role="alert">{{ error }}</p>

    <div v-if="sites.length" class="monitor-results">
      <div class="screen-tabs" role="tablist" aria-label="Websites">
        <button
          v-for="s in sites"
          :key="s.id"
          type="button"
          role="tab"
          class="screen-tab"
          :class="{ active: s.id === activeId }"
          :aria-selected="s.id === activeId"
          :title="s.url"
          @click="activeId = s.id"
        >
          <span class="st-label">{{ tabLabel(s) }}</span>
          <span v-if="s.running" class="score-chip">…</span>
          <span v-else-if="s.lastRun?.status === 'failed'" class="score-chip bad">!</span>
          <span v-else-if="s.lastRun && isClean(s)" class="score-chip good" title="Clean">✓</span>
          <span v-else-if="s.lastRun" class="score-chip" :class="s.lastRun.status === 'errors' ? 'bad' : 'warn'">{{ errorCount(s) }}</span>
        </button>
      </div>

      <div v-if="active" class="monitor-site">
        <div class="monitor-site-head">
          <div class="monitor-site-info">
            <a :href="active.url" target="_blank" rel="noopener" class="monitor-site-url">{{ active.url }} ↗</a>
            <small class="muted">
              {{ profileLabel(active.profile) }}
              <template v-if="active.lastRun"> · checked {{ formatTime(active.lastRun.at) }}</template>
              <template v-if="active.lastRun?.httpStatus"> · HTTP {{ active.lastRun.httpStatus }}</template>
              <template v-if="active.lastRun?.finalUrl && active.lastRun.finalUrl !== active.url"> · ended on {{ active.lastRun.finalUrl }}</template>
            </small>
          </div>
          <button type="button" class="ghost" :disabled="active.running" @click="run(active)">{{ active.running ? 'Checking…' : 'Re-check' }}</button>
          <button type="button" class="ghost" :disabled="active.running" @click="remove(active)">Remove</button>
        </div>

        <p v-if="active.running" class="monitor-empty">
          <template v-if="active.progress">Checking page {{ active.progress.done + 1 }} of {{ active.progress.total }}{{ active.progress.total >= 40 ? '+' : '' }}: {{ pathOf(active.progress.current) }}</template>
          <template v-else>Signing in / starting…</template>
        </p>
        <p v-else-if="!active.lastRun" class="monitor-empty">No data</p>
        <p v-else-if="active.lastRun.status === 'failed'" class="source-error" role="alert">{{ active.lastRun.message }}</p>
        <div v-else-if="isClean(active)" class="monitor-clean" role="status">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          <div>
            <strong>Clean</strong>
            <span>No network errors and no exposed keys found<template v-if="active.lastRun.pages?.length"> on {{ active.lastRun.pages.length }} page{{ active.lastRun.pages.length === 1 ? '' : 's' }}</template>.</span>
          </div>
        </div>
        <template v-else>
          <section class="monitor-section">
            <h3>Network errors <span class="score-chip" :class="networkErrors(active).length ? 'bad' : 'good'">{{ networkErrors(active).length }}</span></h3>
            <ul v-if="networkErrors(active).length" class="monitor-errors">
              <li v-for="(e, i) in networkErrors(active)" :key="i">
                <span class="monitor-type" :class="e.type">{{ TYPE_LABEL[e.type] }}<template v-if="e.status"> {{ e.status }}</template></span>
                <div class="monitor-error-body">
                  <pre>{{ e.message }}</pre>
                  <small v-if="e.url" class="muted">{{ e.method ? `${e.method} ` : '' }}{{ e.url }}<template v-if="e.resource"> · {{ e.resource }}</template></small>
                  <details class="monitor-help">
                    <summary>Where to find it · How to replicate</summary>
                    <dl>
                      <template v-for="w in networkHelp(e, active).where" :key="w.label">
                        <dt>{{ w.label }}</dt>
                        <dd :class="{ mono: w.mono }">{{ w.value }}</dd>
                      </template>
                    </dl>
                    <ol>
                      <li v-for="(step, n) in networkHelp(e, active).steps" :key="n">
                        <template v-if="typeof step === 'string'">{{ step }}</template>
                        <template v-else>{{ step.text }} <code>{{ step.code }}</code></template>
                      </li>
                    </ol>
                  </details>
                </div>
                <span v-if="e.count > 1" class="monitor-count">×{{ e.count }}</span>
              </li>
            </ul>
            <p v-else class="monitor-ok">Clean: no network errors.</p>
          </section>

          <section class="monitor-section">
            <h3>Exposed keys <span class="score-chip" :class="exposedKeys(active).some((k) => k.severity !== 'info') ? 'bad' : exposedKeys(active).length ? 'warn' : 'good'">{{ exposedKeys(active).length }}</span></h3>
            <ul v-if="exposedKeys(active).length" class="monitor-errors">
              <li v-for="(k, i) in exposedKeys(active)" :key="i">
                <span class="monitor-type" :class="`sev-${k.severity}`">{{ SEVERITY_LABEL[k.severity] }}</span>
                <div class="monitor-error-body">
                  <pre><strong>{{ k.label }}</strong> {{ k.masked }}</pre>
                  <small class="muted monitor-context">{{ k.context }}</small>
                  <small class="muted">{{ k.original ? `${k.original.source}:${k.original.line}` : `${{ api: 'API response', page: 'Page HTML', script: 'JS' }[keyKind(k)]} · ${fileName(k.url)} · line ${k.line}${k.column ? `, col ${k.column}` : ''}` }}</small>
                  <details class="monitor-help">
                    <summary>Where to find it · How to replicate</summary>
                    <dl>
                      <template v-for="w in keyHelp(k, active).where" :key="w.label + w.value">
                        <dt>{{ w.label }}</dt>
                        <dd :class="{ mono: w.mono }">{{ w.value }}</dd>
                      </template>
                    </dl>
                    <ol>
                      <li v-for="(step, n) in keyHelp(k, active).steps" :key="n">{{ step }}</li>
                    </ol>
                    <p class="monitor-fix"><strong>Fix:</strong> {{ keyHelp(k, active).fix }}</p>
                    <p v-if="keyHelp(k, active).sourceMapNote" class="monitor-fix">{{ keyHelp(k, active).sourceMapNote }}</p>
                  </details>
                </div>
              </li>
            </ul>
            <p v-else-if="!keysScanned(active)" class="monitor-empty">Not scanned for keys yet: click Re-check.</p>
            <p v-else class="monitor-ok">Clean: no exposed keys in the site's code.</p>
          </section>
          <p class="monitor-hint muted">Keys are masked. "Public" keys (Google, Stripe publishable) are meant for browsers: make sure they are restricted to your domains in their console. Only the site's own files are scanned, not third-party scripts.</p>
        </template>

        <!-- What the crawl covered: every page opened (initial load only) and the writes it blocked. -->
        <div v-if="!active.running && active.lastRun?.pages" class="monitor-crawl">
          <p v-if="active.lastRun.note" class="monitor-hint">{{ active.lastRun.note }}</p>
          <details class="monitor-help">
            <summary>Pages checked ({{ active.lastRun.pages.length }}) · initial load only, read-only</summary>
            <ul class="monitor-pages">
              <li v-for="p in active.lastRun.pages" :key="p.url">
                <span class="score-chip" :class="p.errors ? 'bad' : 'good'">{{ p.errors ? p.errors : '✓' }}</span>
                <a :href="p.url" target="_blank" rel="noopener">{{ pathOf(p.url) }}</a>
                <small v-if="p.status" class="muted">HTTP {{ p.status }}</small>
                <small v-if="p.landed" class="muted">→ {{ pathOf(p.landed) }}</small>
              </li>
            </ul>
          </details>
          <details v-if="active.lastRun.blockedWrites?.length" class="monitor-help">
            <summary>Writes blocked ({{ active.lastRun.blockedWrites.length }}): requests the pages tried to send on load, stopped so nothing changed</summary>
            <ul class="monitor-pages">
              <li v-for="b in active.lastRun.blockedWrites" :key="b.method + b.url">
                <span class="score-chip">{{ b.method }}</span>
                <span class="mono">{{ pathOf(b.url) }}</span>
                <small class="muted">on {{ b.pages.map(pathOf).join(', ') }}<template v-if="b.count > 1"> · ×{{ b.count }}</template></small>
              </li>
            </ul>
          </details>
        </div>
      </div>
    </div>
    <p v-else class="monitor-empty">No data</p>
  </section>

  <SignInChallengeDialog :challenge="challenge" :busy="challengeBusy" @submit="answerChallenge" @cancel="answerChallenge(null)" />
</template>
