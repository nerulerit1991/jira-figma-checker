<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  status: { type: Object, default: null },
  loading: Boolean,
  signingOut: Boolean,
  // Per-connection fix progress: { [key]: { state: 'running' | 'done' | 'error', message, url } }
  fixing: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['fix', 'select-agent']);
const menuOpen = ref(false);
const provider = computed(() => props.status?.provider || 'claude');
const agentLabel = computed(() => provider.value === 'codex' ? 'Codex' : 'Claude');
function selectAgent(next) {
  menuOpen.value = false;
  if (next !== provider.value) emit('select-agent', next);
}

const LABELS = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs auth',
  pending: 'Connecting',
  disabled: 'Disabled',
  'not-configured': 'Not added',
  configured: 'Connected',
  installed: 'Installed',
  missing: 'Missing',
};

const items = computed(() => {
  const s = props.status;
  if (!s) return [];
  const mcp = (key, label, x) => ({
    key,
    label,
    ok: ['connected', 'configured'].includes(x.status),
    state: x.status,
    title: `${x.name || 'No server'}${x.error ? ' · ' + x.error : ''}`,
  });
  return [
    { key: 'jira', label: 'Jira', ok: ['connected', 'configured'].includes(s.jira?.status), state: s.jira?.status || 'not-configured', title: `${s.jira?.name || 'No server'}${s.jira?.error ? ' · ' + s.jira.error : ''}` },
    mcp('figma', 'Figma', s.figma),
    ...(s.figmaBridge ? [mcp('figmaBridge', 'Figma bridge', s.figmaBridge)] : []),
    { key: 'browser', label: 'Browser', ok: s.browser?.status === 'installed', state: s.browser?.status || 'missing', title: 'Chromium, used to capture the live page' },
  ];
});

const stateText = (item) => (item.key === 'claude' && !item.ok ? 'Not logged in' : LABELS[item.state] || item.state);
</script>

<template>
  <div class="conn">
    <ul v-if="status" class="conn-list">
      <li class="agent-picker">
        <div class="conn-item agent-row" :class="status.authenticated ? 'on' : 'off'">
          <span class="conn-main">
            <i class="dot" />
            <button class="agent-select" :disabled="signingOut" :aria-expanded="menuOpen" aria-haspopup="menu" :aria-label="`Choose Claude or Codex. Current agent: ${agentLabel}.`" @click="menuOpen = !menuOpen">
              <span class="conn-name">{{ agentLabel }}<svg class="agent-arrow" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></span>
            </button>
          </span>
          <span v-if="status.authenticated" class="conn-state">Connected</span>
          <button v-else class="conn-state agent-reconnect" :disabled="signingOut || fixing[provider]?.state === 'running'" @click="$emit('fix', provider)">
            {{ fixing[provider]?.state === 'running' ? 'Connecting…' : 'Reconnect' }}
          </button>
        </div>
        <div v-if="menuOpen" class="agent-menu">
          <button v-for="option in ['claude', 'codex']" :key="option" class="agent-option" :class="{ selected: option === provider }" @click="selectAgent(option)">
            <span>{{ option === 'claude' ? 'Claude' : 'Codex' }}</span>
            <svg v-if="option === provider" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true"><path d="m2.5 6 2.2 2.2 4.8-4.8" /></svg>
          </button>
        </div>
        <p v-if="fixing[provider]?.message && fixing[provider].state !== 'done'" class="conn-note" :class="{ err: fixing[provider].state === 'error' }">
          {{ fixing[provider].message }}
          <a v-if="fixing[provider].url" :href="fixing[provider].url" target="_blank" rel="noopener">Open page</a>
        </p>
      </li>
      <li v-for="item in items" :key="item.key">
        <button
          v-if="!item.ok"
          class="conn-item fixable"
          :class="fixing[item.key]?.state === 'running' ? 'wait' : 'off'"
          :title="`${item.title} — click to reconnect`"
          :disabled="signingOut || fixing[item.key]?.state === 'running'"
          @click="$emit('fix', item.key)"
        >
          <span class="conn-main"><i class="dot" /><span class="conn-name">{{ item.label }}</span></span>
          <span class="conn-state">
            <template v-if="fixing[item.key]?.state === 'running'">Connecting…</template>
            <template v-else>Reconnect</template>
          </span>
        </button>
        <div v-else class="conn-item on" :title="item.title">
          <span class="conn-main"><i class="dot" /><span class="conn-name">{{ item.label }}</span></span>
          <span class="conn-state">{{ stateText(item) }}</span>
        </div>
        <p v-if="fixing[item.key]?.message && fixing[item.key].state !== 'done'" class="conn-note" :class="{ err: fixing[item.key].state === 'error' }">
          {{ fixing[item.key].message }}
          <a v-if="fixing[item.key].url" :href="fixing[item.key].url" target="_blank" rel="noopener">Open page</a>
        </p>
      </li>
    </ul>
    <p v-else class="conn-item wait"><i class="dot" /> {{ loading ? 'Checking…' : 'Unavailable' }}</p>
  </div>
</template>
