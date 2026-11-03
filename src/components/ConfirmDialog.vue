<script setup>
import { ref } from 'vue';

// Promise-based confirm: `const ok = await confirmRef.value.ask({ title, message, confirmLabel })`.
const dialog = ref(null);
const opts = ref({});
let resolver = null;

function ask(options) {
  opts.value = { confirmLabel: 'Delete', danger: true, ...options };
  dialog.value.showModal();
  return new Promise((resolve) => (resolver = resolve));
}

function close(result) {
  dialog.value.close();
  resolver?.(result);
  resolver = null;
}

defineExpose({ ask });
</script>

<template>
  <dialog ref="dialog" class="modal" @cancel.prevent="close(false)" @click.self="close(false)">
    <div class="modal-body">
      <h3>{{ opts.title }}</h3>
      <p class="modal-text">{{ opts.message }}</p>
      <div class="modal-actions">
        <button class="ghost" @click="close(false)">Cancel</button>
        <button :class="opts.danger ? 'danger' : 'primary'" autofocus @click="close(true)">{{ opts.confirmLabel }}</button>
      </div>
    </div>
  </dialog>
</template>
