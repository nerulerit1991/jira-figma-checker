<script setup>
import { computed } from 'vue';

// One screen of the interaction flow chart and, to its right, the screens its clicks lead to (drawn recursively).
// The map is a tree: each screen has one parent, the screen it is first reached from.
const props = defineProps({
  screen: { type: Object, required: true },
  screens: { type: Array, required: true },
  number: { type: Function, required: true }, // screen id → its number in click order (1 = start)
  status: { type: Function, required: true }, // screen → 'pass' | 'fail' | 'unreached' | null (last run)
  state: { type: Function, required: true }, // screen → flowScope.js screenState()
  itemCount: { type: Function, required: true }, // screen id → checklist items on it, or null before the split
  locked: { type: Boolean, default: false },
});
const emit = defineEmits(['allow']);

const children = computed(() => props.screens.filter((s) => s.parentId === props.screen.id));
const KIND = { start: 'Start', page: 'Page', overlay: 'Modal' };
const STATUS = { pass: 'Passed last run', fail: 'Has issues', unreached: 'Not reached last run' };
const st = computed(() => props.state(props.screen));
const items = computed(() => props.itemCount(props.screen.id));
</script>

<template>
  <div class="fn">
    <div class="fn-card" :class="[status(screen), st]">
      <div class="fn-top">
        <span class="fn-num">{{ number(screen.id) }}</span>
        <span class="tag">{{ KIND[screen.kind] }}</span>
        <span v-if="status(screen)" class="fn-dot" :class="status(screen)" :title="STATUS[status(screen)]" role="img" :aria-label="STATUS[status(screen)]"></span>
      </div>
      <strong class="fn-name" :title="screen.name">{{ screen.name }}</strong>
      <span v-if="st === 'not-in-ticket'" class="fn-meta">not in this ticket</span>
      <span v-else-if="items != null" class="fn-meta">{{ items }} checklist item{{ items === 1 ? '' : 's' }}</span>
      <template v-if="screen.risky && items">
        <span class="tag risky" title="A click on the way may change data or take payment on the site.">may change data</span>
        <button
          class="ghost small fn-allow"
          :disabled="locked"
          :title="screen.allowRisky ? 'Stop clicking through to this screen' : 'Click through to this screen too. Use a staging site with test data only.'"
          @click="emit('allow', screen.id, !screen.allowRisky)"
        >
          {{ screen.allowRisky ? 'Skip it' : 'Check it anyway' }}
        </button>
      </template>
    </div>

    <div v-if="children.length" class="fn-children">
      <div v-for="child in children" :key="child.id" class="fn-branch">
        <div class="fn-edge" :class="{ faded: state(child) === 'not-in-ticket' }">
          <span class="fn-click" :title="`Click “${child.steps.at(-1).text}”`">click “{{ child.steps.at(-1).text }}”</span>
          <span class="fn-line" aria-hidden="true"></span>
          <span class="fn-action">{{ child.kind === 'overlay' ? 'opens modal' : 'goes to page' }}</span>
        </div>
        <FlowNode
          :screen="child"
          :screens="screens"
          :number="number"
          :status="status"
          :state="state"
          :item-count="itemCount"
          :locked="locked"
          @allow="(id, on) => emit('allow', id, on)"
        />
      </div>
    </div>
  </div>
</template>
