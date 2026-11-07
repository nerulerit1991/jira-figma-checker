<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

// The viewports every page is rendered at for the responsive check. Shared by all tickets; used from the next check on.
const props = defineProps({
  viewports: { type: Array, required: true },
  // Editing is locked while a check runs, since that check is already rendering the current list.
  locked: { type: Boolean, default: false },
  max: { type: Number, default: 6 },
});
const emit = defineEmits(['change']);

const adding = ref(false);
const saving = ref(false);
const error = ref('');
const draft = ref({ name: '', width: '', height: '' });

async function save(list) {
  saving.value = true;
  error.value = '';
  try {
    const { viewports } = await api.setViewports(list.map(({ name, width, height }) => ({ name, width, height })));
    emit('change', viewports);
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    saving.value = false;
  }
}

const remove = (name) => save(props.viewports.filter((v) => v.name !== name));

async function add() {
  const { name, width, height } = draft.value;
  const ok = await save([...props.viewports, { name: name.trim().toLowerCase(), width: Number(width), height: Number(height) }]);
  if (ok) cancel();
}

function cancel() {
  adding.value = false;
  error.value = '';
  draft.value = { name: '', width: '', height: '' };
}
</script>

<template>
  <div class="vp">
    <div class="vp-row">
      <span class="vp-label">Checks at</span>
      <span v-for="v in viewports" :key="v.name" class="vp-chip" :title="v.required ? 'Required: the Figma comparison and page content use it' : `${v.width} × ${v.height}px`">
        <strong>{{ v.name }}</strong>
        <span class="vp-size">{{ v.width }}×{{ v.height }}</span>
        <button
          v-if="!v.required"
          class="vp-del"
          :disabled="locked || saving || viewports.length <= 1"
          :aria-label="`Delete ${v.name} viewport`"
          @click="remove(v.name)"
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </span>
      <button
        v-if="!adding"
        class="vp-add"
        :disabled="locked || saving || viewports.length >= max"
        :title="viewports.length >= max ? `At most ${max} viewports` : 'Add a viewport'"
        @click="adding = true"
      >
        + Add viewport
      </button>
    </div>

    <form v-if="adding" class="vp-form" @submit.prevent="add">
      <input v-model="draft.name" placeholder="name, e.g. small-laptop" maxlength="24" aria-label="Viewport name" required />
      <input v-model="draft.width" type="number" min="240" max="3840" placeholder="width" aria-label="Width in px" required />
      <span class="vp-x">×</span>
      <input v-model="draft.height" type="number" min="320" max="2400" placeholder="height" aria-label="Height in px" required />
      <button class="ghost" type="submit" :disabled="saving || locked">{{ saving ? 'Saving…' : 'Add' }}</button>
      <button class="ghost" type="button" :disabled="saving" @click="cancel">Cancel</button>
    </form>

    <p v-if="error" class="warn-text vp-error">{{ error }}</p>
    <p class="vp-note">Shared by all tickets. Changes apply from the next check; each extra viewport adds screenshots and tokens.</p>
  </div>
</template>

<style scoped>
.vp { padding: 12px 0 4px; }
.vp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.vp-label { font-family: var(--mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-right: 4px; }
.vp-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 4px 0 10px;
  border: 1px solid var(--border); border-radius: 999px; font-size: 0.78rem; background: var(--surface);
}
.vp-chip:not(:has(.vp-del)) { padding-right: 10px; }
.vp-size { font-family: var(--mono); font-size: 0.7rem; color: var(--muted); }
button.vp-del {
  width: 18px; height: 18px; padding: 0; border-radius: 999px; background: transparent; color: var(--muted); border: 0;
}
button.vp-del:hover:not(:disabled) { color: var(--red); background: var(--red-bg); }
button.vp-add {
  height: 26px; padding: 0 10px; font-size: 0.75rem; font-weight: 500; border-radius: 999px;
  background: transparent; color: var(--muted); border: 1px dashed var(--border-strong);
}
button.vp-add:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.vp-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.vp-form input { height: 32px; font-size: 0.8rem; padding: 0 10px; }
.vp-form input:first-child { flex: 1 1 160px; }
.vp-form input[type='number'] { flex: 0 0 90px; width: 90px; }
.vp-form button { height: 32px; padding: 0 12px; font-size: 0.8rem; }
.vp-x { color: var(--subtle); }
.vp-error { margin: 8px 0 0; font-size: 0.8rem; }
.vp-note { margin: 8px 0 0; font-size: 0.75rem; color: var(--subtle); }
</style>
