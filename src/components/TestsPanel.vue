<script setup>
import { computed } from 'vue';
import globalTestCatalog from '../../data/global-test-cases/cases.json';
import ScriptReview from './ScriptReview.vue';
import FailureDetails from './FailureDetails.vue';
import { hasTestCalls } from '../highlight.js';

const props = defineProps({
  tests: { type: Object, default: null },
  globalTests: { type: Object, default: () => ({ cases: [], results: null }) },
  // Acceptance items meant for Playwright that no test covers yet; listed under Functionality as gaps.
  uncovered: { type: Array, default: () => [] },
  // The script whose Verify switch is being saved.
  verifyBusy: { type: String, default: null },
});
defineEmits(['verify']);

const FILE_LABELS = { 'behavior.spec.js': 'Functionality', 'api.spec.js': 'API & health' };

// Before a run, a test of a skip-only script is already known to be skipped, with its reason.
const pendingRow = (t) => {
  const skip = props.tests.verification?.[t.file]?.skipped?.find((s) => s.title === t.title);
  return skip ? { file: t.file, title: t.title, status: 'skipped', skipReason: skip.reason } : { file: t.file, title: t.title, status: 'todo' };
};

// Last run's rows grouped by file; before the first run, list what was generated.
const groups = computed(() => {
  if (!props.tests) return [];
  const rows = props.tests.results?.rows ?? props.tests.tests.map(pendingRow);
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  return [...byFile].map(([file, items]) => ({ file, label: FILE_LABELS[file] || file, items }));
});

// The element a test acts on, in plain words, from the generator's "target". Code locators are not shown to users.
function targetOf(r) {
  const meta = props.tests?.tests?.find((t) => t.file === r.file && t.title === r.title);
  return meta?.target?.element ? meta.target : null;
}

const seconds = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);
const globalCases = computed(() => props.globalTests?.cases?.length ? props.globalTests.cases : globalTestCatalog.cases);
const globalResult = (testCase) => props.globalTests?.results?.rows?.find((r) => r.title.startsWith(`[${testCase.id}]`));
const groupFor = (file) => groups.value.find((g) => g.file === file);
const statusSvg = (status) => status === 'passed' ? 'check' : status === 'failed' ? 'cross' : status === 'skipped' ? 'skip' : '';
const rowClass = (status) => status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : status === 'skipped' ? 'skip' : 'todo';
const verifiedOf = (file) => Boolean(props.tests?.verification?.[file]?.verified);
// A script with no tests runs nothing, so it is not shown for review and needs no verification.
const hasTests = (file) => props.tests?.scripts?.[file] != null && hasTestCalls(props.tests.scripts[file]);
// A skip-only script (every test is test.skip(true, …)) runs nothing either, so it needs no verification.
const needsReview = (file) => hasTests(file) && !verifiedOf(file) && !props.tests?.verification?.[file]?.skipOnly;
// Scripts outside the two sections (none today) are still listed for review at the bottom.
const otherScripts = computed(() => Object.keys(props.tests?.scripts || {}).filter((f) => !FILE_LABELS[f] && hasTests(f)));
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
          <span class="acc-title">Default test cases</span>
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
              <FailureDetails v-if="globalResult(testCase)?.error" :error="globalResult(testCase).error" />
              <div v-if="globalResult(testCase)?.skipReason" class="evidence">Skipped: {{ globalResult(testCase).skipReason }}</div>
            </div>
            <div class="row-tags"><span class="tag">{{ testCase.id }}</span></div>
          </li>
        </ul>
    </details>

    <details class="accordion suite-accordion">
      <summary>
        <span class="acc-title">API &amp; health</span>
        <span v-if="needsReview('api.spec.js')" class="score-chip warn">Not verified</span>
        <span v-if="groupFor('api.spec.js')" class="score-chip" :class="groupFor('api.spec.js').items.some((r) => r.status === 'failed') ? 'bad' : 'good'">{{ sectionScore(groupFor('api.spec.js').items) }}</span>
        <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <ScriptReview
        v-if="hasTests('api.spec.js')"
        name="api.spec.js"
        :code="tests.scripts['api.spec.js']"
        :state="tests.verification?.['api.spec.js']"
        :busy="verifyBusy === 'api.spec.js'"
        @verify="$emit('verify', $event)"
      />
      <ul v-if="groupFor('api.spec.js')" class="checklist suite-list">
        <li v-for="(r, i) in groupFor('api.spec.js').items" :key="i" :class="r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : r.status === 'skipped' ? 'skip' : 'todo'">
          <span class="mark" :aria-label="r.status"><svg v-if="statusSvg(r.status) === 'check'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg><svg v-else-if="statusSvg(r.status) === 'cross'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg><svg v-else-if="statusSvg(r.status) === 'skip'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg></span>
          <div class="row-body"><div class="item">{{ r.title }}</div><FailureDetails v-if="r.error" :error="r.error" /><div v-if="r.skipReason" class="evidence">Skipped: {{ r.skipReason }}</div></div>
          <div class="row-tags"><span v-if="r.durationMs != null" class="tag">{{ seconds(r.durationMs) }}</span></div>
        </li>
      </ul>
      <p v-else class="hint suite-empty">{{ tests ? 'No ticket-specific API tests were generated.' : 'Generate ticket-specific tests to see API checks.' }}</p>
    </details>

    <details class="accordion suite-accordion">
      <summary>
        <span class="acc-title">Functionality</span>
        <span v-if="needsReview('behavior.spec.js')" class="score-chip warn">Not verified</span>
        <span v-if="groupFor('behavior.spec.js')" class="score-chip" :class="groupFor('behavior.spec.js').items.some((r) => r.status === 'failed') ? 'bad' : 'good'">{{ sectionScore(groupFor('behavior.spec.js').items) }}</span>
        <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <ScriptReview
        v-if="hasTests('behavior.spec.js')"
        name="behavior.spec.js"
        :code="tests.scripts['behavior.spec.js']"
        :state="tests.verification?.['behavior.spec.js']"
        :busy="verifyBusy === 'behavior.spec.js'"
        @verify="$emit('verify', $event)"
      />
      <ul v-if="groupFor('behavior.spec.js') || uncovered.length" class="checklist suite-list">
        <li v-for="(r, i) in groupFor('behavior.spec.js')?.items || []" :key="i" :class="r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : r.status === 'skipped' ? 'skip' : 'todo'">
          <span class="mark" :aria-label="r.status"><svg v-if="statusSvg(r.status) === 'check'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg><svg v-else-if="statusSvg(r.status) === 'cross'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg><svg v-else-if="statusSvg(r.status) === 'skip'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12" /></svg></span>
          <div class="row-body">
            <div class="item">{{ r.title }}</div>
            <div v-if="targetOf(r)" class="test-target">
              <span class="tt-label">Element</span>
              <template v-if="targetOf(r).section"><span>{{ targetOf(r).section }}</span><span class="tt-sep">›</span></template>
              <span>{{ targetOf(r).element }}</span>
            </div>
            <FailureDetails v-if="r.error" :error="r.error" :target="targetOf(r)" /><div v-if="r.skipReason" class="evidence">Skipped: {{ r.skipReason }}</div>
          </div>
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

    <div v-if="otherScripts.length" class="scripts">
      <p class="label">Other ticket-specific scripts</p>
      <ScriptReview
        v-for="name in otherScripts"
        :key="name"
        :name="name"
        :code="tests.scripts[name]"
        :state="tests.verification?.[name]"
        :busy="verifyBusy === name"
        @verify="$emit('verify', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.test-target { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; margin-top: 4px; font-size: 0.78rem; color: var(--muted); }
.tt-label { font-family: var(--mono); font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--subtle); }
.tt-sep { color: var(--subtle); }
</style>
