<script setup>
import { computed } from 'vue';

const props = defineProps({
  match: { type: Object, required: true },
});

// Mismatches first, so problems are at the top.
const rows = computed(() => [...(props.match.rows || [])].sort((a, b) => Number(a.match) - Number(b.match)));
const matched = computed(() => rows.value.filter((r) => r.match).length);
</script>

<template>
  <div class="dm">
    <p class="meta">
      {{ matched }}/{{ rows.length }} properties match · compared at {{ match.comparedAt }} width
    </p>
    <div class="dm-table" role="table" aria-label="Figma vs live comparison">
      <div class="dm-row dm-head" role="row">
        <span role="columnheader"></span>
        <span role="columnheader">Element</span>
        <span role="columnheader">Property</span>
        <span role="columnheader">Figma</span>
        <span role="columnheader">Live</span>
      </div>
      <div v-for="(r, i) in rows" :key="i" class="dm-row" :class="r.match ? 'pass' : 'fail'" role="row">
        <span class="mark sm" role="cell" :aria-label="r.match ? 'Match' : 'Mismatch'">
          <svg v-if="r.match" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
          <svg v-else viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </span>
        <span class="dm-el" role="cell">{{ r.element }}<small v-if="r.section || r.note">{{ [r.section, r.note].filter(Boolean).join(' · ') }}</small></span>
        <span class="dm-prop" role="cell">{{ r.property }}</span>
        <code role="cell" data-label="Figma">{{ r.figma }}</code>
        <code role="cell" data-label="Live" :class="{ off: !r.match }">{{ r.live }}</code>
      </div>
    </div>
  </div>
</template>
