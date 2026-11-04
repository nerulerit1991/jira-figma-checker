<script setup>
import { ref, watch, nextTick } from 'vue';

// The OTP or CAPTCHA a sign-in is waiting for: { id, kind: 'otp' | 'captcha' | 'manual', image, message }, or null.
// 'manual': a CAPTCHA widget the person solves in a browser window the server opened.
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
    <!-- A CAPTCHA widget: the person signs in in the browser window the server opened; nothing to type here. -->
    <div v-if="challenge?.kind === 'manual'" class="modal-body">
      <p class="field-label">Sign in in the browser window</p>
      <p>{{ challenge.message }}</p>
      <div class="modal-actions">
        <button type="button" class="ghost" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="button" class="primary" :disabled="busy" @click="emit('submit', 'done')">I've signed in</button>
      </div>
    </div>
    <form v-else-if="challenge" class="modal-body" @submit.prevent="submit">
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
