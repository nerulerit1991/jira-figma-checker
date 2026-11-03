<script setup>
import { ref, watch } from 'vue';

// Floats "-N tokens" up from where it is placed, then fades out.
// Pass a new { id, tokens } each time an AI call finishes; only bursts for this `target` show here.
const props = defineProps({
  burst: { type: Object, default: null },
  target: { type: String, required: true },
});

const items = ref([]);
watch(
  () => props.burst?.id,
  () => {
    const b = props.burst;
    if (b && b.target === props.target && b.tokens > 0) items.value.push(b);
  },
);
const remove = (id) => (items.value = items.value.filter((b) => b.id !== id));
</script>

<template>
  <span class="burst-layer" aria-live="polite">
    <span v-for="b in items" :key="b.id" class="token-burst" @animationend="remove(b.id)">
      -{{ b.tokens.toLocaleString() }} tokens
    </span>
  </span>
</template>
