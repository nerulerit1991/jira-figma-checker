<script setup>
import { computed } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  responsive: { type: Array, required: true },
  screenshots: { type: Array, default: () => [] },
  ticketKey: { type: String, required: true },
  checkedAt: { type: String, required: true },
  // Screenshot link per viewport; defaults to the main Check UI screenshots (the interaction flow passes its own).
  shotUrl: { type: Function, default: null },
});

const ORDER = ['desktop', 'tablet', 'mobile'];
const cards = computed(() =>
  [...props.responsive]
    .sort((a, b) => ORDER.indexOf(a.viewport) - ORDER.indexOf(b.viewport))
    .map((r) => ({ ...r, hasShot: props.screenshots.some((s) => s.viewport === r.viewport) })),
);
const shot = (vp) => (props.shotUrl ? props.shotUrl(vp) : api.screenshotUrl(props.ticketKey, vp, props.checkedAt));
</script>

<template>
  <div class="rv">
    <article v-for="c in cards" :key="c.viewport" class="rv-card" :class="c.passed ? 'pass' : 'fail'">
      <header class="rv-head">
        <span class="mark sm">
          <svg v-if="c.passed" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
          <svg v-else viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </span>
        <strong>{{ c.viewport }}</strong>
        <span class="meta">{{ c.width }}px</span>
      </header>
      <ul v-if="c.issues?.length" class="list rv-issues">
        <li v-for="(issue, i) in c.issues" :key="i">{{ issue }}</li>
      </ul>
      <p v-else class="rv-ok">No layout problems found.</p>
      <a v-if="c.hasShot" class="rv-shot" :href="shot(c.viewport)" target="_blank" rel="noopener">
        <img :src="shot(c.viewport)" :alt="`${c.viewport} screenshot`" loading="lazy" />
      </a>
    </article>
  </div>
</template>
