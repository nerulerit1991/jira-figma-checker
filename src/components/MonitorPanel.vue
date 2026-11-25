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
const isClean = (site) => site.lastRun && site.lastRun.status !== 'failed' && !networkErrors(site).length && !exposedKeys(site).length;

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

        <p v-if="active.running" class="monitor-empty">Checking the page…</p>
        <p v-else-if="!active.lastRun" class="monitor-empty">No data</p>
        <p v-else-if="active.lastRun.status === 'failed'" class="source-error" role="alert">{{ active.lastRun.message }}</p>
        <div v-else-if="isClean(active)" class="monitor-clean" role="status">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          <div>
            <strong>Clean</strong>
            <span>No network errors and no exposed keys found.</span>
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
                  <small v-for="f in k.files" :key="f" class="muted">{{ f }}<template v-if="f === k.url"> · line {{ k.line }}</template></small>
                </div>
              </li>
            </ul>
            <p v-else class="monitor-ok">Clean: no exposed keys in the site's code.</p>
          </section>
          <p class="monitor-hint muted">Keys are masked. "Public" keys (Google, Stripe publishable) are meant for browsers: make sure they are restricted to your domains in their console. Only the site's own files are scanned, not third-party scripts.</p>
        </template>
      </div>
    </div>
    <p v-else class="monitor-empty">No data</p>
  </section>

  <SignInChallengeDialog :challenge="challenge" :busy="challengeBusy" @submit="answerChallenge" @cancel="answerChallenge(null)" />
</template>
