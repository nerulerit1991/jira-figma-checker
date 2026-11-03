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
const key = computed(() => parseJiraKey(url.value));

async function open() {
  url.value = '';
  error.value = '';
  dialog.value.showModal();
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

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal" @click.self="close">
    <form class="modal-body" @submit.prevent="submit">
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
</template>
