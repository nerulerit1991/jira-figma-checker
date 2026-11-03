<script setup>
import { ref, computed, nextTick } from 'vue';
import { statusClass } from '../status.js';

const props = defineProps({
  tickets: { type: Array, required: true },
  modelValue: { type: String, default: null },
  busyKeys: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue', 'reorder']);

const query = ref('');
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.tickets;
  return props.tickets.filter((t) => t.key.toLowerCase().includes(q) || (t.summary || '').toLowerCase().includes(q));
});

// Drag a ticket (or Alt+↑/↓ on it) to change the order. Off while searching, where only some tickets are shown.
const canReorder = computed(() => !query.value.trim() && props.tickets.length > 1);
const dragKey = ref(null);
const drop = ref(null); // { key, after }: the ticket the dragged one lands next to

function moveTo(key, targetKey, after) {
  const keys = props.tickets.map((t) => t.key).filter((k) => k !== key);
  const index = keys.indexOf(targetKey);
  if (index < 0) return;
  keys.splice(after ? index + 1 : index, 0, key);
  if (keys.join() !== props.tickets.map((t) => t.key).join()) emit('reorder', keys);
}

function onDragStart(event, key) {
  dragKey.value = key;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', key);
}
function onDragOver(event, key) {
  if (!dragKey.value) return;
  event.preventDefault();
  const box = event.currentTarget.getBoundingClientRect();
  drop.value = key === dragKey.value ? null : { key, after: event.clientY > box.top + box.height / 2 };
}
function onDrop() {
  if (dragKey.value && drop.value) moveTo(dragKey.value, drop.value.key, drop.value.after);
  onDragEnd();
}
function onDragEnd() {
  dragKey.value = null;
  drop.value = null;
}

async function onMoveKey(event, key, step) {
  if (!canReorder.value) return;
  const keys = props.tickets.map((t) => t.key);
  const target = keys[keys.indexOf(key) + step];
  if (!target) return;
  moveTo(key, target, step > 0);
  // The list re-renders in the new order; keep focus on the moved ticket.
  await nextTick();
  event.target.closest('.nav-list')?.querySelector(`[data-key="${key}"]`)?.focus();
}

const score = (t) => (t.total ? `${t.passed}/${t.total}` : null);
const scoreClass = (t) => (t.total ? (t.passed === t.total ? 'good' : 'bad') : '');
</script>

<template>
  <div class="ticket-nav">
    <label class="search">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <input v-model="query" type="search" placeholder="Search tickets" aria-label="Search tickets" />
    </label>

    <p class="nav-label">Tickets <span>{{ tickets.length }}</span></p>

    <ul class="nav-list">
      <li
        v-for="t in filtered"
        :key="t.key"
        :draggable="canReorder"
        :class="{ dragging: t.key === dragKey, 'drop-before': drop?.key === t.key && !drop.after, 'drop-after': drop?.key === t.key && drop.after }"
        @dragstart="onDragStart($event, t.key)"
        @dragover="onDragOver($event, t.key)"
        @drop.prevent="onDrop"
        @dragend="onDragEnd"
      >
        <button
          :data-key="t.key"
          :title="canReorder ? 'Drag to reorder (or Alt+↑/↓)' : undefined"
          @keydown.alt.up.prevent="onMoveKey($event, t.key, -1)"
          @keydown.alt.down.prevent="onMoveKey($event, t.key, 1)"
          class="nav-item"
          :class="{ active: t.key === modelValue, loading: busyKeys.includes(t.key) }"
          :aria-busy="busyKeys.includes(t.key) || undefined"
          :aria-current="t.key === modelValue ? 'page' : undefined"
          @click="emit('update:modelValue', t.key)"
        >
          <span class="nav-item-top">
            <span class="nav-key">
              {{ t.key }}
              <span v-if="t.status" class="status-chip nav-status" :class="statusClass(t.status)">{{ t.status }}</span>
            </span>
            <span v-if="score(t)" class="score-chip" :class="scoreClass(t)">{{ score(t) }}</span>
          </span>
          <span class="nav-summary" :class="{ dim: !t.summary }">{{ t.summary || 'Not retrieved yet' }}</span>
        </button>
      </li>
      <li v-if="!filtered.length" class="nav-empty">
        {{ tickets.length ? `No tickets match "${query}"` : 'No tickets yet' }}
      </li>
    </ul>
  </div>
</template>
