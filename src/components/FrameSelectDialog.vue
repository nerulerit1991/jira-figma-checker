<script setup>
import { ref, computed, nextTick } from 'vue';
import { api } from '../api.js';

// Searchable list of the frames in a saved whole Figma file (data/full-figma/<project>/<fileKey>.json).
// `const frame = await ref.value.ask(ticketKey, fileKey);` resolves to { id, name, ... } or null on cancel.
// Without a fileKey it lists the file the ticket's own Figma link points at.
const dialog = ref(null);
const search = ref(null);
const query = ref('');
const frames = ref([]);
const fileName = ref('');
const selectedId = ref(null);
const loading = ref(false);
const error = ref('');
let resolver = null;

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return frames.value;
  return frames.value.filter((f) => `${f.name} ${f.section || ''} ${f.page}`.toLowerCase().includes(q));
});
const selected = computed(() => frames.value.find((f) => f.id === selectedId.value) || null);

// The promise exists before the frames load, so closing the dialog while they load (Esc, backdrop) still answers null.
function ask(ticketKey, fileKey) {
  query.value = '';
  error.value = '';
  frames.value = [];
  selectedId.value = null;
  dialog.value.showModal();
  const answer = new Promise((resolve) => (resolver = resolve));
  loadFrames(ticketKey, fileKey);
  return answer;
}

async function loadFrames(ticketKey, fileKey) {
  loading.value = true;
  try {
    const res = await api.figmaFrames(ticketKey, fileKey);
    // Page-sized frames first (most likely what a ticket checks), then by name.
    frames.value = [...res.frames].sort((a, b) => (b.width >= 1000) - (a.width >= 1000) || a.name.localeCompare(b.name));
    fileName.value = res.fileName;
    selectedId.value = res.current;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
    if (dialog.value.open) {
      await nextTick();
      search.value?.focus();
      dialog.value.querySelector('.frame-list li.on')?.scrollIntoView({ block: 'center' });
    }
  }
}

function close(result) {
  dialog.value.close();
  resolver?.(result);
  resolver = null;
}

defineExpose({ ask });
</script>

<template>
  <dialog ref="dialog" class="modal frame-modal" @cancel.prevent="close(null)" @click.self="close(null)">
    <form class="modal-body" @submit.prevent="selected && close(selected)">
      <h3>Which Figma frame to check?</h3>
      <p class="modal-text">
        From the saved file{{ fileName ? ' ' : '' }}<strong v-if="fileName">{{ fileName }}</strong>. Picking a frame uses no tokens.
      </p>

      <label class="frame-search">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input ref="search" v-model="query" type="search" placeholder="Search frames, e.g. Home V4" aria-label="Search frames" />
      </label>

      <p v-if="loading" class="frame-empty">Loading frames…</p>
      <p v-else-if="error" class="error-text">{{ error }}</p>
      <ul v-else class="frame-list" role="listbox" aria-label="Figma frames">
        <li
          v-for="f in filtered"
          :key="f.id"
          role="option"
          :aria-selected="f.id === selectedId"
          :class="{ on: f.id === selectedId }"
          tabindex="0"
          @click="selectedId = f.id"
          @dblclick="close(f)"
          @keydown.space.prevent="selectedId = f.id"
          @keydown.enter.prevent="close(f)"
        >
          <span class="frame-name">{{ f.name }}</span>
          <span class="frame-meta">
            <template v-if="f.section">{{ f.section }} · </template>{{ f.width }}×{{ f.height }}
          </span>
        </li>
        <li v-if="!filtered.length" class="frame-empty">No frames match "{{ query }}"</li>
      </ul>

      <div class="modal-actions">
        <span class="frame-count">{{ filtered.length }} of {{ frames.length }} frames</span>
        <button type="button" class="ghost" @click="close(null)">Cancel</button>
        <button type="submit" class="primary" :disabled="!selected">Check this frame</button>
      </div>
    </form>
  </dialog>
</template>
