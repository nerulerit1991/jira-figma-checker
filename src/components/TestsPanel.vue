<script setup>
import { computed } from 'vue';
import globalTestCatalog from '../../data/global-test-cases/cases.json';

const props = defineProps({
  tests: { type: Object, default: null },
  globalTests: { type: Object, default: () => ({ cases: [], results: null }) },
  // Acceptance items meant for Playwright that no test covers yet; listed under Functionality as gaps.
  uncovered: { type: Array, default: () => [] },
});

const FILE_LABELS = { 'behavior.spec.js': 'Functionality', 'api.spec.js': 'API & health' };

// Last run's rows grouped by file; before the first run, list what was generated.
const groups = computed(() => {
  if (!props.tests) return [];
  const rows = props.tests.results?.rows ?? props.tests.tests.map((t) => ({ file: t.file, title: t.title, status: 'todo' }));
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  return [...byFile].map(([file, items]) => ({ file, label: FILE_LABELS[file] || file, items }));
});

const seconds = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);
const globalCases = computed(() => props.globalTests?.cases?.length ? props.globalTests.cases : globalTestCatalog.cases);
const globalResult = (testCase) => props.globalTests?.results?.rows?.find((r) => r.title.startsWith(`[${testCase.id}]`));
const groupFor = (file) => groups.value.find((g) => g.file === file);
const statusSvg = (status) => status === 'passed' ? 'check' : status === 'failed' ? 'cross' : status === 'skipped' ? 'skip' : '';
const rowClass = (status) => status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : status === 'skipped' ? 'skip' : 'todo';
const sectionScore = (rows) => rows?.length ? `${rows.filter((r) => r.status === 'passed').length}/${rows.length}` : '';
</script>

<template>
  <div class="tests">
    <p v-if="tests?.results" class="meta">
      Last ticket test run {{ new Date(tests.results.ranAt).toLocaleString() }} · {{ seconds(tests.results.durationMs) }} ·
      <span class="ok-text">{{ tests.results.passed }} passed</span> ·
      <span :class="{ 'bad-text': tests.results.failed }">{{ tests.results.failed }} failed</span> · {{ tests.results.skipped }} skipped
      <template v-if="tests.results.rerunAt"> · failed re-run {{ new Date(tests.results.rerunAt).toLocaleString() }}</template>
    </p>

    <details class="accordion suite-accordion">
        <summary>
          <span class="acc-title">Global test cases</span>
          <span v-if="globalTests.results" class="score-chip" :class="globalTests.results.failed ? 'bad' : 'good'">{{ globalTests.results.passed }}/{{ globalCases.length }}</span>
          <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </summary>
        <p v-if="globalTests.results" class="meta suite-run-meta">
          Last run {{ new Date(globalTests.results.ranAt).toLocaleString() }} · {{ seconds(globalTests.results.durationMs) }} ·
          <span class="ok-text">{{ globalTests.results.passed }} passed</span> ·
          <span :class="{ 'bad-text': globalTests.results.failed }">{{ globalTests.results.failed }} failed</span> · {{ globalTests.results.skipped }} skipped
          <template v-if="globalTests.results.rerunAt"> · failed re-run {{ new Date(globalTests.results.rerunAt).toLocaleString() }}</template>
        </p>
        <p v-else class="meta suite-run-meta">Shared checks run locally without AI tokens and are excluded from ticket-specific generation.</p>
        <ul class="checklist global-test-list">
          <li v-for="testCase in globalCases" :key="testCase.id" :class="rowClass(globalResult(testCase)?.status)">
            <span class="mark" :aria-label="globalResult(testCase)?.status || 'not run'">
              <svg v-if="globalResult(testCase)?.status === 'passed'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
              <svg v-else-if="globalResult(testCase)?.status === 'failed'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              <svg v-else-if="globalResult(testCase)?.status === 'skipped'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg>
            </span>
            <div class="row-body">
              <div class="item">{{ testCase.title }}</div>
              <div class="evidence">{{ testCase.covers }}</div>
              <pre v-if="globalResult(testCase)?.error" class="test-error">{{ globalResult(testCase).error }}</pre>
              <div v-if="globalResult(testCase)?.skipReason" class="evidence">Skipped: {{ globalResult(testCase).skipReason }}</div>
            </div>
            <div class="row-tags"><span class="tag">{{ testCase.id }}</span></div>
          </li>
        </ul>
    </details>

    <details class="accordion suite-accordion">
      <summary>
        <span class="acc-title">API &amp; health</span>
        <span v-if="groupFor('api.spec.js')" class="score-chip" :class="groupFor('api.spec.js').items.some((r) => r.status === 'failed') ? 'bad' : 'good'">{{ sectionScore(groupFor('api.spec.js').items) }}</span>
        <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <ul v-if="groupFor('api.spec.js')" class="checklist suite-list">
        <li v-for="(r, i) in groupFor('api.spec.js').items" :key="i" :class="r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : r.status === 'skipped' ? 'skip' : 'todo'">
          <span class="mark" :aria-label="r.status"><svg v-if="statusSvg(r.status) === 'check'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg><svg v-else-if="statusSvg(r.status) === 'cross'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg><svg v-else-if="statusSvg(r.status) === 'skip'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg></span>
          <div class="row-body"><div class="item">{{ r.title }}</div><pre v-if="r.error" class="test-error">{{ r.error }}</pre><div v-if="r.skipReason" class="evidence">Skipped: {{ r.skipReason }}</div></div>
          <div class="row-tags"><span v-if="r.durationMs != null" class="tag">{{ seconds(r.durationMs) }}</span></div>
        </li>
      </ul>
      <p v-else class="hint suite-empty">{{ tests ? 'No ticket-specific API tests were generated.' : 'Generate ticket-specific tests to see API checks.' }}</p>
    </details>

    <details class="accordion suite-accordion">
      <summary>
        <span class="acc-title">Functionality</span>
        <span v-if="groupFor('behavior.spec.js')" class="score-chip" :class="groupFor('behavior.spec.js').items.some((r) => r.status === 'failed') ? 'bad' : 'good'">{{ sectionScore(groupFor('behavior.spec.js').items) }}</span>
        <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <ul v-if="groupFor('behavior.spec.js') || uncovered.length" class="checklist suite-list">
        <li v-for="(r, i) in groupFor('behavior.spec.js')?.items || []" :key="i" :class="r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : r.status === 'skipped' ? 'skip' : 'todo'">
          <span class="mark" :aria-label="r.status"><svg v-if="statusSvg(r.status) === 'check'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg><svg v-else-if="statusSvg(r.status) === 'cross'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg><svg v-else-if="statusSvg(r.status) === 'skip'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg></span>
          <div class="row-body"><div class="item">{{ r.title }}</div><pre v-if="r.error" class="test-error">{{ r.error }}</pre><div v-if="r.skipReason" class="evidence">Skipped: {{ r.skipReason }}</div></div>
          <div class="row-tags"><span v-if="r.durationMs != null" class="tag">{{ seconds(r.durationMs) }}</span></div>
        </li>
        <li v-for="item in uncovered" :key="item.id" class="todo">
          <span class="mark" aria-label="no test"></span>
          <div class="row-body"><div class="item">[{{ item.id }}] {{ item.item }}</div><div class="evidence">No test covers this item. Regenerate the tests.</div></div>
          <div class="row-tags"><span class="tag">no test</span></div>
        </li>
      </ul>
      <p v-else class="hint suite-empty">{{ tests ? 'No ticket-specific functionality tests were generated.' : 'Generate ticket-specific tests to see functionality checks.' }}</p>
    </details>

    <!-- Acceptance items no test can verify (App.vue). -->
    <slot name="acceptance" />

    <template v-if="tests?.notes?.length">
      <p class="label">Not automated</p>
      <ul class="list"><li v-for="(n, i) in tests.notes" :key="i">{{ n }}</li></ul>
    </template>

    <details v-if="tests?.scripts" class="more scripts">
      <summary>View ticket-specific scripts</summary>
      <div v-for="(code, name) in tests.scripts" :key="name" class="script">
        <p class="script-name"><code>data/…/tests/{{ name }}</code></p>
        <pre><code>{{ code }}</code></pre>
      </div>
    </details>
  </div>
</template>
