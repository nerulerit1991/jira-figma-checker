<script setup>
import { computed } from 'vue';

const props = defineProps({
  items: { type: Array, required: true },
});

const TYPE_LABELS = {
  'missing-scenario': 'Missing scenario',
  loophole: 'Loophole',
  ux: 'UX',
  accessibility: 'Accessibility',
  security: 'Security',
  content: 'Content',
  performance: 'Performance',
};
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Most important first; the AI already orders them, this only keeps high before medium before low.
const sorted = computed(() => [...props.items].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)));
</script>

<template>
  <ul class="improvements">
    <li v-for="item in sorted" :key="item.id" :class="`sev-${item.severity}`">
      <div class="imp-head">
        <span class="imp-sev">{{ item.severity }}</span>
        <span class="imp-title">{{ item.title }}</span>
        <span class="tag">{{ TYPE_LABELS[item.type] || item.type }}</span>
      </div>
      <p class="imp-eli5">{{ item.eli5 }}</p>
      <dl class="imp-details">
        <template v-if="item.example">
          <dt>Try this</dt>
          <dd>{{ item.example }}</dd>
        </template>
        <template v-if="item.question">
          <dt>Ask the client / BA</dt>
          <dd>{{ item.question }}</dd>
        </template>
        <template v-if="item.relatedAc?.length">
          <dt>Related AC</dt>
          <dd>{{ item.relatedAc.join(' · ') }}</dd>
        </template>
      </dl>
      <details v-if="item.technical" class="imp-tech">
        <summary>For developers</summary>
        <p>{{ item.technical }}</p>
      </details>
    </li>
  </ul>
</template>

<style scoped>
.improvements { list-style: none; margin: 0; padding: 12px; display: grid; gap: 10px; }
.improvements > li { padding: 12px 14px; border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius); background: var(--surface); }
.sev-high { border-left-color: #ff4d5e !important; }
.sev-medium { border-left-color: #fbbf24 !important; }
.sev-low { border-left-color: var(--border-strong) !important; }
.imp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.imp-title { font-weight: 600; font-size: 0.9rem; flex: 1; min-width: 0; }
.imp-sev { font-family: var(--mono); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; }
.sev-high .imp-sev { color: #ff4d5e; background: rgba(255, 77, 94, 0.12); }
.sev-medium .imp-sev { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
.sev-low .imp-sev { color: var(--muted); background: var(--inset); }
.imp-eli5 { margin: 8px 0 0; font-size: 0.88rem; line-height: 1.5; color: var(--text); }
.imp-details { margin: 10px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 0.8rem; }
.imp-details dt { color: var(--subtle); }
.imp-details dd { margin: 0; color: #d4d3de; }
.imp-tech { margin-top: 8px; font-size: 0.78rem; color: var(--muted); }
.imp-tech summary { cursor: pointer; color: var(--subtle); }
.imp-tech p { margin: 6px 0 0; font-family: var(--mono); font-size: 0.74rem; line-height: 1.5; white-space: pre-wrap; }
@media (max-width: 600px) {
  .imp-details { grid-template-columns: 1fr; }
  .imp-details dd { margin-bottom: 6px; }
}
</style>
