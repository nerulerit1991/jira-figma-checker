<script setup>
import { ref, watch, nextTick } from 'vue';

// The OTP or CAPTCHA a sign-in is waiting for: { id, kind: 'otp' | 'captcha', image, message }, or null.
// Opens while a step is waiting and closes when it is answered, cancelled or times out on the server.
const props = defineProps({ challenge: { type: Object, default: null }, busy: Boolean });
const emit = defineEmits(['submit', 'cancel']);

const dialog = ref(null);
const input = ref(null);
const value = ref('');

watch(
  () => props.challenge?.id,
  async (id) => {
    value.value = '';
    if (!dialog.value) return;
    if (id && !dialog.value.open) dialog.value.showModal();
    if (!id && dialog.value.open) dialog.value.close();
    if (id) {
      await nextTick();
      input.value?.focus();
    }
  },
  { flush: 'post' },
);

function submit() {
  if (value.value.trim()) emit('submit', value.value.trim());
}
</script>

<template>
  <dialog ref="dialog" class="modal" @cancel.prevent="emit('cancel')">
    <form v-if="challenge" class="modal-body" @submit.prevent="submit">
      <label class="field-label" for="challenge-input">{{ challenge.kind === 'otp' ? 'OTP' : 'CAPTCHA' }}</label>
      <img v-if="challenge.image" class="challenge-image" :src="challenge.image" alt="CAPTCHA from the login page" />
      <p v-if="challenge.message" class="source-error" role="alert">{{ challenge.message }}</p>
      <input
        id="challenge-input"
        ref="input"
        v-model="value"
        class="challenge-input"
        autocomplete="off"
        :inputmode="challenge.kind === 'otp' ? 'numeric' : 'text'"
      />
      <div class="modal-actions">
        <button type="button" class="ghost" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="primary" :disabled="busy || !value.trim()">Submit</button>
      </div>
    </form>
  </dialog>
</template>
