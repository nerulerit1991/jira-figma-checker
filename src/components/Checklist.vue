<script setup>
import { computed } from 'vue';

const props = defineProps({
  items: { type: Array, required: true },
  check: { type: Object, default: null },
  showScore: { type: Boolean, default: true },
});

const rows = computed(() => {
  const results = new Map((props.check?.results || []).map((r) => [r.id, r]));
  return props.items.map((item) => ({ ...item, result: results.get(item.id) }));
});
const passed = computed(() => rows.value.filter((r) => r.result?.passed).length);
</script>

<template>
  <div class="checklist-wrap">
    <div v-if="check && showScore" class="score">
      <span class="score-num">{{ passed }}<span>/{{ rows.length }}</span></span>
      <span class="score-label">passed</span>
      <div class="bar"><i :style="{ width: `${rows.length ? (passed / rows.length) * 100 : 0}%` }" /></div>
    </div>
    <ul class="checklist">
      <li v-for="row in rows" :key="row.id" :class="row.result ? (row.result.passed ? 'pass' : 'fail') : 'todo'">
        <span class="mark" :aria-label="row.result ? (row.result.passed ? 'Done' : 'Not done') : 'Not checked'">
          <svg v-if="row.result?.passed" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
          <svg v-else-if="row.result" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </span>
        <div class="row-body">
          <div class="item">{{ row.item }}</div>
          <div v-if="row.result" class="evidence">{{ row.result.evidence }}</div>
        </div>
        <div class="row-tags">
          <span class="tag">{{ row.category }}</span>
          <span v-if="row.result" class="tag">{{ row.result.confidence }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>
