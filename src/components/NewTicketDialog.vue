<script setup>
import { ref, computed, nextTick } from 'vue';
import { parseJiraKey } from '../api.js';

const props = defineProps({
  // async (jiraUrl) => void; throws to show an error in the dialog.
  create: { type: Function, required: true },
});
const dialog = ref(null);
const input = ref(null);
const url = ref('');
const error = ref('');
const busy = ref(false);
const inline = ref(false);
const key = computed(() => parseJiraKey(url.value));

// The tour opens it non-modal (`modal: false`): a modal dialog lives in the browser's top layer, where some
// browsers close or hide it under the tour's own overlay.
async function open({ modal = true } = {}) {
  url.value = '';
  error.value = '';
  inline.value = !modal;
  modal ? dialog.value.showModal() : dialog.value.show();
  await nextTick();
  input.value?.focus();
}

function close() {
  dialog.value.close();
}

async function submit() {
  // Enter pressed again while the ticket is being created must not send a second request.
  if (!key.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await props.create(url.value);
    close();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// Tour helpers: type a link into the field one character at a time, then submit like the Add button.
async function typeUrl(text, delay = 35) {
  url.value = '';
  for (const ch of text) {
    url.value += ch;
    await new Promise((r) => setTimeout(r, delay));
  }
}

defineExpose({ open, close, typeUrl, submit });
</script>

<template>
  <Teleport to="body">
  <dialog ref="dialog" class="modal" :class="{ 'modal-inline': inline }" @click.self="close">
    <form class="modal-body" data-tour="ticket-modal" @submit.prevent="submit">
      <h3>New ticket</h3>
      <label class="field">
        <span>Jira link</span>
        <input ref="input" v-model.trim="url" placeholder="https://your-site.atlassian.net/browse/ABC-123" />
        <small v-if="url && !key" class="error-text">No issue key found in this link.</small>
      </label>
      <p class="modal-text">
        <template v-if="key">Creates <strong>data/{{ key }}/</strong> for this ticket's JSON files.</template>
        Nothing is retrieved until you click Retrieve, so adding a ticket uses no tokens. Add the Figma link
        on the ticket once it is open.
      </p>
      <p v-if="error" class="error-text">{{ error }}</p>
      <div class="modal-actions">
        <button type="button" class="ghost" @click="close">Cancel</button>
        <button type="submit" class="primary" :disabled="!key || busy">Add ticket</button>
      </div>
    </form>
  </dialog>
  </Teleport>
</template>

<style scoped>
/* Non-modal (tour) version: centred like the modal, just above the tour's blur layer. */
.modal-inline { position: fixed; inset: 0; margin: auto; height: fit-content; z-index: 1001; }
</style>
