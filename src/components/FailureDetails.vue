<script setup>
import { computed } from 'vue';
import { explainFailure } from '../failureText.js';

// A failed test in plain words (what was expected, what was found), with Playwright's own message folded underneath.
const props = defineProps({
  error: { type: String, required: true },
  target: { type: Object, default: null },
});
const plain = computed(() => explainFailure(props.error, props.target));
</script>

<template>
  <div class="failure">
    <dl v-if="plain" class="failure-plain">
      <template v-if="plain.expected"><dt>Expected</dt><dd>{{ plain.expected }}</dd></template>
      <template v-if="plain.found"><dt>Found</dt><dd>{{ plain.found }}</dd></template>
    </dl>
    <details v-if="plain" class="failure-raw">
      <summary>Technical details</summary>
      <pre class="test-error">{{ error }}</pre>
    </details>
    <pre v-else class="test-error">{{ error }}</pre>
  </div>
</template>

<style scoped>
.failure-plain { display: grid; grid-template-columns: max-content 1fr; gap: 2px 8px; margin: 6px 0 0; font-size: 0.82rem; }
.failure-plain dt { font-family: var(--mono); font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--subtle); padding-top: 2px; }
.failure-plain dd { margin: 0; color: var(--text); }
.failure-raw { margin-top: 4px; font-size: 0.74rem; color: var(--muted); }
.failure-raw summary { cursor: pointer; width: max-content; }
</style>
