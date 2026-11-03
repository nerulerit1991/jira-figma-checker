<script setup>
import { computed } from 'vue';
import { verifyByOf, testStatusOf } from '../../server/checklist.js';

const props = defineProps({
  items: { type: Array, required: true },
  check: { type: Object, default: null },
  // The ticket's Playwright tests (readTests()); Playwright items take their result from these.
  tests: { type: Object, default: null },
  showScore: { type: Boolean, default: true },
});

// Callers pass the items of one step (App.vue splits them by verifyBy). Every row as { state: pass | fail | skip | todo, evidence, confidence? } from the step that verifies it.
const rows = computed(() => {
  const results = new Map((props.check?.results || []).map((r) => [r.id, r]));
  return props.items.map((item) => {
    const verifyBy = verifyByOf(item);
    if (verifyBy === 'not-testable') {
      return { ...item, verifyBy, state: 'skip', evidence: item.reason || 'Cannot be verified automatically; check it manually.' };
    }
    if (verifyBy === 'playwright') {
      const t = testStatusOf(item.id, props.tests);
      const state = { passed: 'pass', failed: 'fail', skipped: 'skip' }[t.status] || 'todo';
      return { ...item, verifyBy, state, evidence: t.detail };
    }
    const r = results.get(item.id);
    return { ...item, verifyBy, state: r ? (r.passed ? 'pass' : 'fail') : 'todo', evidence: r?.evidence, confidence: r?.confidence };
  });
});
const scored = computed(() => rows.value.filter((r) => r.verifyBy !== 'not-testable'));
const passed = computed(() => scored.value.filter((r) => r.state === 'pass').length);
</script>

<template>
  <div class="checklist-wrap">
    <div v-if="check && showScore" class="score">
      <span class="score-num">{{ passed }}<span>/{{ scored.length }}</span></span>
      <span class="score-label">passed</span>
      <div class="bar"><i :style="{ width: `${scored.length ? (passed / scored.length) * 100 : 0}%` }" /></div>
    </div>
    <ul class="checklist">
      <li v-for="row in rows" :key="row.id" :class="row.state">
        <span class="mark" :aria-label="{ pass: 'Done', fail: 'Not done', skip: 'Not verified', todo: 'Not checked' }[row.state]">
          <svg v-if="row.state === 'pass'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
          <svg v-else-if="row.state === 'fail'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          <svg v-else-if="row.state === 'skip'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg>
        </span>
        <div class="row-body">
          <div class="item">{{ row.item }}</div>
          <div v-if="row.evidence" class="evidence">{{ row.evidence }}</div>
        </div>
        <div class="row-tags">
          <span class="tag">{{ row.category }}</span>
          <span v-if="row.confidence" class="tag">{{ row.confidence }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>
