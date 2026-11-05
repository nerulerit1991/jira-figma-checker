<script setup>
import { computed } from 'vue';
import { highlightLines } from '../highlight.js';
import { scriptRisks } from '../scriptRisk.js';

// One generated script: its code with risky lines marked, and the Verify switch. Only verified scripts run.
const props = defineProps({
  name: { type: String, required: true },
  code: { type: String, default: '' },
  // { hash, verified, verifiedAt } from the server, for the code shown here.
  state: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['verify']);

// A review aid, not a guard: lines that change data, and whether they target the test's own Playwright-Test record.
const lines = computed(() => {
  const tokens = highlightLines(props.code);
  const risks = scriptRisks(props.code);
  return props.code.split('\n').map((_, i) => ({ n: i + 1, tokens: tokens[i] || [], risk: risks[i] }));
});
const riskyCount = computed(() => lines.value.filter((l) => l.risk?.level === 'risk').length);
const ownCount = computed(() => lines.value.filter((l) => l.risk?.level === 'own').length);
const verified = computed(() => Boolean(props.state?.verified));
// Every test starts with test.skip(true, …): nothing runs, so there is nothing to verify.
const skipOnly = computed(() => Boolean(props.state?.skipOnly));
</script>

<template>
  <div class="script-review" :class="{ verified: verified || skipOnly }">
    <div v-if="skipOnly" class="review-bar">
      <span class="score-chip good">Nothing to run</span>
      <span class="review-hint">Every test in this script is skipped, so it needs no verification.</span>
    </div>
    <div v-else class="review-bar">
      <span class="score-chip" :class="verified ? 'good' : 'warn'">{{ verified ? 'Verified' : 'Not verified' }}</span>
      <span v-if="riskyCount" class="risk-count">⚠ {{ riskyCount }} line{{ riskyCount === 1 ? '' : 's' }} to check</span>
      <span v-if="ownCount" class="own-count">✓ {{ ownCount }} on its own Playwright-Test record{{ ownCount === 1 ? '' : 's' }}</span>
      <span class="review-hint">{{ verified ? `Reviewed ${new Date(state.verifiedAt).toLocaleString()}` : 'Read the script, then verify it. Until then its tests are skipped.' }}</span>
      <button
        class="verify-btn"
        :class="verified ? 'ghost' : 'primary'"
        :disabled="busy || !state"
        @click="emit('verify', { file: name, hash: state.hash, verified: !verified })"
      >{{ busy ? 'Saving…' : verified ? 'Unverify' : 'Verify' }}</button>
    </div>
    <details class="more script" :open="!verified && !skipOnly && riskyCount > 0">
      <summary>Review <code>{{ name }}</code></summary>
      <pre class="review-code"><code><span
        v-for="l in lines"
        :key="l.n"
        class="code-line"
        :class="{ risky: l.risk?.level === 'risk', own: l.risk?.level === 'own' }"
        :title="l.risk?.message"
      ><span class="ln">{{ l.n }}</span><span v-for="(t, j) in l.tokens" :key="j" :class="`tok-${t.type}`">{{ t.text }}</span><span v-if="l.risk" class="risk-note">{{ l.risk.level === 'risk' ? '⚠' : '✓' }} {{ l.risk.message }}</span>
</span></code></pre>
    </details>
  </div>
</template>
