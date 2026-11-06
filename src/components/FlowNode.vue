<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';

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
  depth: { type: Number, default: 0 }, // steps from the start screen; staggers the reveal animation
});
const emit = defineEmits(['allow']);

const children = computed(() => props.screens.filter((s) => s.parentId === props.screen.id));
const KIND = { start: 'Start', page: 'Page', overlay: 'Modal' };
const STATUS = { pass: 'Passed last run', fail: 'Has issues', unreached: 'Not reached last run' };
const st = computed(() => props.state(props.screen));
const items = computed(() => props.itemCount(props.screen.id));

// The green border draws as two halves: from the left middle (where the arrow in arrives) along the top and the
// bottom, meeting at the right middle (where the arrow out leaves). Paths are in pixels, so they follow the card's size.
const card = ref(null);
const size = ref({ w: 0, h: 0 });
let observer = null;
onMounted(() => {
  const measure = () => { size.value = { w: card.value.offsetWidth, h: card.value.offsetHeight }; };
  measure();
  observer = new ResizeObserver(measure);
  observer.observe(card.value);
});
onBeforeUnmount(() => observer?.disconnect());
const ring = computed(() => {
  const { w, h } = size.value;
  if (!w || !h) return null;
  const i = 0.75; // half the stroke, so it sits on the 1px border
  const r = 7.25; // card radius 8 minus the inset
  const m = h / 2;
  return {
    top: `M${i},${m} L${i},${i + r} A${r},${r} 0 0 1 ${i + r},${i} L${w - i - r},${i} A${r},${r} 0 0 1 ${w - i},${i + r} L${w - i},${m}`,
    bottom: `M${i},${m} L${i},${h - i - r} A${r},${r} 0 0 0 ${i + r},${h - i} L${w - i - r},${h - i} A${r},${r} 0 0 0 ${w - i},${h - i - r} L${w - i},${m}`,
  };
});
</script>

<template>
  <div class="fn">
    <div ref="card" class="fn-card" :class="[status(screen), st]" :style="{ '--d': depth }" :title="STATUS[status(screen)]">
      <svg v-if="ring" class="fn-ring" :viewBox="`0 0 ${size.w} ${size.h}`" aria-hidden="true">
        <path :d="ring.top" pathLength="100" />
        <path :d="ring.bottom" pathLength="100" />
      </svg>
      <div class="fn-top">
        <span class="fn-num">{{ number(screen.id) }}</span>
        <span class="tag">{{ KIND[screen.kind] }}</span>
        <span v-if="status(screen)" class="sr-only">{{ STATUS[status(screen)] }}</span>
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
          <span class="fn-line" aria-hidden="true">
            <span class="fn-fill" :style="{ '--d': depth }"></span>
          </span>
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
          :depth="depth + 1"
          @allow="(id, on) => emit('allow', id, on)"
        />
      </div>
    </div>
  </div>
</template>
