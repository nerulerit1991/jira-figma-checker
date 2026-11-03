<script setup>
import { ref, computed, nextTick } from 'vue';
import { api } from '../api.js';

// Where the Figma API tab saves the whole file it is about to download: an existing project folder
// (its saved copies are replaced) or a new one. `const save = await ref.value.ask({ savedProject });`
// resolves to { project, overwrite, redownload } or null on cancel.
const dialog = ref(null);
const search = ref(null);
const newName = ref(null);
const query = ref('');
const project = ref('');
const projects = ref([]);
const loading = ref(false);
const error = ref('');
const savedProject = ref(null);
const savedFileKey = ref(null);
const redownload = ref(true);
// The picked row awaiting the "this replaces what is saved there" confirmation, or null.
const pending = ref(null);
let resolver = null;

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? projects.value.filter((p) => p.project.toLowerCase().includes(q)) : projects.value;
});

// What the download deletes: every copy in the target folder except the picked one.
const replacedFiles = computed(() =>
  pending.value
    ? projects.value.filter((p) => p.project === pending.value.project && p.fileKey !== pending.value.fileKey)
    : [],
);

async function ask({ savedProject: saved } = {}) {
  query.value = '';
  project.value = '';
  error.value = '';
  projects.value = [];
  pending.value = null;
  savedProject.value = saved?.project || null;
  savedFileKey.value = saved?.fileKey || null;
  redownload.value = true;
  dialog.value.showModal();
  loading.value = true;
  try {
    projects.value = (await api.figmaProjects()).projects;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
    await nextTick();
    (savedProject.value ? search.value : newName.value)?.focus();
  }
  return new Promise((resolve) => (resolver = resolve));
}

function close(result) {
  dialog.value.close();
  resolver?.(result);
  resolver = null;
}

// Reusing the copy already on disk needs a project other than the one holding it; that project
// would just re-read itself, so it is the only choice blocked while "download again" is unticked.
const blocked = (name) => !redownload.value && name === savedProject.value;

function pickExisting(entry) {
  if (blocked(entry.project)) return;
  const overwrite = redownload.value;
  // Any download into an existing project replaces that folder's contents, so it always confirms.
  if (overwrite) pending.value = { project: entry.project, fileKey: entry.fileKey };
  else close({ project: entry.project, overwrite, redownload: redownload.value });
}

function createNew() {
  const name = project.value.trim();
  if (name) close({ project: name, overwrite: false, redownload: true });
}

const savedOn = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown date');

defineExpose({ ask });
</script>

<template>
  <dialog ref="dialog" class="modal frame-modal" @cancel.prevent="close(null)" @click.self="close(null)">
    <form class="modal-body" @submit.prevent="createNew">
      <h3>Where to save the Figma file?</h3>
      <p v-if="savedProject" class="modal-text">
        This file is already saved in <strong>{{ savedProject }}</strong>.
        <label class="redownload-row">
          <input v-model="redownload" type="checkbox" />
          <span>Download it again from the Figma API (overwrites the saved copy)</span>
        </label>
      </p>
      <p v-else class="modal-text">
        The whole file is fetched from the Figma API (no AI tokens) and saved under
        <strong>data/full-figma/</strong>, where every ticket can reuse it. Pick a project to save it into
        (replacing what is saved there), or create a new one.
      </p>

      <template v-if="pending">
        <p v-if="replacedFiles.length" class="modal-text">
          Overwrite <strong>{{ pending.project }}</strong>? The download replaces this project's saved Figma
          file — deleted:
          <span v-for="(f, i) in replacedFiles" :key="f.fileKey"
            >{{ i ? ', ' : '' }}<strong>{{ f.fileKey.slice(0, 8) }}</strong> (saved {{ savedOn(f.savedAt) }})</span
          >. Any ticket using a deleted copy has to download the whole file from the Figma API again.
        </p>
        <p v-else class="modal-text">
          Overwrite <strong>{{ pending.project }}</strong>? The download replaces the saved copy
          <strong>{{ pending.fileKey.slice(0, 8) }}</strong> in this project with the current version from the
          Figma API.
        </p>
        <div class="modal-actions">
          <button type="button" class="ghost" @click="pending = null">Cancel</button>
          <button type="button" class="danger" @click="close({ project: pending.project, overwrite: true, redownload: true })">Proceed</button>
        </div>
      </template>

      <template v-else>
        <p v-if="savedProject && !redownload" class="source-hint">Unticked: no API call — pick another project to reuse its saved copy, or tick “Download again” to refresh this one.</p>

        <label class="frame-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input ref="search" v-model="query" type="search" placeholder="Search projects, e.g. AXSA" aria-label="Search saved Figma projects" />
        </label>

        <p v-if="loading" class="frame-empty">Loading saved files…</p>
        <p v-else-if="error" class="error-text">{{ error }}</p>
        <ul v-else class="frame-list" aria-label="Saved Figma projects">
          <li
            v-for="p in filtered"
            :key="p.fileKey"
            tabindex="0"
            :class="{ disabled: blocked(p.project) }"
            @click="pickExisting(p)"
            @keydown.enter.prevent="pickExisting(p)"
          >
            <span class="frame-name">{{ p.project }}</span>
            <span class="frame-meta">{{ p.fileKey === savedFileKey ? 'this file · ' : '' }}saved {{ savedOn(p.savedAt) }} · {{ p.fileKey.slice(0, 8) }}</span>
          </li>
          <li v-if="!filtered.length" class="frame-empty">
            {{ query ? `No saved project matches “${query}”.` : 'Nothing saved yet.' }}
          </li>
        </ul>

        <label class="field">
          <span>New project</span>
          <input ref="newName" v-model.trim="project" placeholder="Project folder name" aria-label="New Figma project name" />
        </label>

        <div class="modal-actions">
          <button type="button" class="ghost" @click="close(null)">Cancel</button>
          <button type="submit" class="primary" :disabled="!project.trim()">Create project and save</button>
        </div>
      </template>
    </form>
  </dialog>
</template>
