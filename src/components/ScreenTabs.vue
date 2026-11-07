<script setup>
// One tab per screen of the interaction flow (1 = the ticket's frame, then each page or modal reached by clicking),
// with that screen's score for the section the tabs sit in.
defineProps({
  tabs: { type: Array, required: true }, // [{ id, label, kind, off, score: { passed, total } | null }]
  modelValue: { type: String, required: true },
});
const emit = defineEmits(['update:modelValue']);
const KIND = { start: 'Start', page: 'Page', overlay: 'Modal' };
</script>

<template>
  <div class="screen-tabs" role="tablist" aria-label="Screens">
    <button
      v-for="(t, i) in tabs"
      :key="t.id"
      type="button"
      role="tab"
      class="screen-tab"
      :class="{ active: t.id === modelValue, off: t.off }"
      :aria-selected="t.id === modelValue"
      :title="`${t.label} (${KIND[t.kind]}${t.off ? ', turned off' : ''})`"
      @click="emit('update:modelValue', t.id)"
    >
      <span class="st-num">{{ i + 1 }}</span>
      <span class="st-label">{{ t.label }}</span>
      <span v-if="t.score?.total" class="score-chip" :class="t.score.passed === t.score.total ? 'good' : 'bad'">{{ t.score.passed }}/{{ t.score.total }}</span>
    </button>
  </div>
</template>
