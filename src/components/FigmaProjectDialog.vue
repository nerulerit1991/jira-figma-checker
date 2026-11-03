<script setup>
import { ref, computed, nextTick } from 'vue';
import { api } from '../api.js';

// Which whole Figma file to work from: one already saved under data/full-figma/<project>/.
// Clicking a project picks it. `const pick = await ref.value.ask();` resolves to { fileKey, project } or null.
const dialog = ref(null);
const search = ref(null);
const query = ref('');
const saved = ref([]);
const loading = ref(false);
const error = ref('');
let resolver = null;

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? saved.value.filter((p) => p.project.toLowerCase().includes(q)) : saved.value;
});

async function ask() {
  query.value = '';
  error.value = '';
  saved.value = [];
  dialog.value.showModal();
  loading.value = true;
  try {
    saved.value = (await api.figmaProjects()).projects;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
    await nextTick();
    search.value?.focus();
  }
  return new Promise((resolve) => (resolver = resolve));
}

function close(result) {
  dialog.value.close();
  resolver?.(result);
  resolver = null;
}

const savedOn = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown date');

defineExpose({ ask });
</script>

<template>
  <dialog ref="dialog" class="modal frame-modal" @cancel.prevent="close(null)" @click.self="close(null)">
    <div class="modal-body">
      <h3>Which Figma project?</h3>
      <p class="modal-text">
        Whole files already downloaded with the Figma API, newest first. Using one needs no API call and no AI tokens.
      </p>

      <label class="frame-search">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input ref="search" v-model="query" type="search" placeholder="Search projects, e.g. AXSA" aria-label="Search saved Figma projects" />
      </label>

      <p v-if="loading" class="frame-empty">Loading saved files…</p>
      <p v-else-if="error" class="error-text">{{ error }}</p>
      <ul v-else class="frame-list" aria-label="Saved Figma projects">
        <li v-for="p in filtered" :key="p.fileKey" tabindex="0" @click="close(p)" @keydown.enter.prevent="close(p)">
          <span class="frame-name">{{ p.project }}</span>
          <span class="frame-meta">saved {{ savedOn(p.savedAt) }} · {{ p.fileKey.slice(0, 8) }}</span>
        </li>
        <li v-if="!filtered.length" class="frame-empty">
          {{ query ? `No saved project matches “${query}”.` : 'Nothing saved yet. Paste a Figma link and click Retrieve Figma.' }}
        </li>
      </ul>

      <div class="modal-actions">
        <button type="button" class="ghost" @click="close(null)">Cancel</button>
      </div>
    </div>
  </dialog>
</template>
