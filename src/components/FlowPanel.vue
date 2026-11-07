<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import FlowNode from './FlowNode.vue';
import { screenState, checkedScreens, itemsOnScreen } from '../../server/flowScope.js';

// The interaction flow as a chart: the ticket's frame and the pages and modals Figma's prototype links lead to
// (see server/flow.js). Nothing to switch on: Check UI follows the screens the Jira checklist talks about
// (flowScope.js) and shows their results in the tabs of the checklist, Figma and responsive sections.
const props = defineProps({
  flow: { type: Object, default: null },
  flowCheck: { type: Object, default: null },
  // The main Check UI result, for the starting screen's mark in the chart.
  check: { type: Object, default: null },
  // Figma data comes from the Figma API tab (the only source with the whole file's prototype links).
  apiFrame: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  locked: { type: Boolean, default: false },
});
const emit = defineEmits(['allow', 'run']);

// Bumped each time the panel opens so the chart remounts and its green reveal animation plays again.
const replay = ref(0);

const screens = computed(() => (props.flow?.screens || []).filter((s) => s.kind !== 'start'));
const checked = computed(() => checkedScreens(props.flow));
const stateOf = (s) => screenState(props.flow, s);
const itemCount = (id) => itemsOnScreen(props.flow, id);
const resultOf = (s) => props.flowCheck?.screens?.find((r) => r.id === s.id && r.nodeId === s.nodeId) || null;
const number = (id) => (props.flow?.screens || []).findIndex((s) => s.id === id) + 1;
const allPassed = (list) => (list || []).every((x) => x.passed);
// How each screen did in its last run: the chart marks it green, red, or red-dashed when it was not reached.
const status = (s) => {
  if (s.kind === 'start') {
    const c = props.check;
    if (!c) return null;
    const assignments = props.flow?.checklistScreens?.assignments;
    const results = assignments ? (c.results || []).filter((r) => (assignments[r.id] || 'S0') === 'S0') : c.results;
    return allPassed(results) && allPassed(c.designChecklist) && allPassed(c.responsive) ? 'pass' : 'fail';
  }
  const r = stateOf(s) === 'checked' && resultOf(s);
  if (!r) return null;
  if (!r.reached) return 'unreached';
  return !r.error && allPassed(r.results) && allPassed(r.designChecklist) && allPassed(r.responsive) ? 'pass' : 'fail';
};
const start = computed(() => props.flow?.screens?.find((s) => s.kind === 'start') || null);

// Chart order: under each screen, the branch with the fewest screens comes first, so short branches sit on the top
// rows and the longest chain of clicks is the last row (ties keep click order).
const childrenOf = computed(() => {
  const all = props.flow?.screens || [];
  const direct = (id) => all.filter((s) => s.parentId === id);
  const size = (id) => direct(id).reduce((n, c) => n + 1 + size(c.id), 0);
  const map = {};
  for (const s of all) map[s.id] = direct(s.id).map((c, i) => ({ c, i, n: size(c.id) })).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.c);
  return map;
});
const kids = (id) => childrenOf.value[id] || [];

// Reveal steps, one screen at a time in reading order (depth first through the chart order above), never two at
// once: each screen takes a trunk step (only when it hangs below a sibling), an arrow step, then its card step.
const steps = computed(() => {
  const out = {};
  let t = 0;
  const walk = (s, firstChild) => {
    const trunk = s.kind !== 'start' && !firstChild ? t++ : null;
    const arrow = s.kind !== 'start' ? t++ : null;
    out[s.id] = { trunk, arrow, ring: t++ };
    kids(s.id).forEach((c, i) => walk(c, i === 0));
  };
  if (start.value) walk(start.value, true);
  return out;
});
const timing = (id) => steps.value[id] || { trunk: 0, arrow: 0, ring: 0 };

// The chart scrolls sideways by itself to follow the reveal at the reveal's own speed: a "pen" moves along what is
// being drawn (an arrow left to right, then its card), linearly like the CSS animations, and the chart scrolls only
// as far as needed to keep the pen in view. Scrolling or clicking the chart hands control back to the person.
const chart = ref(null);
let frame = 0;
const stopFollow = () => { cancelAnimationFrame(frame); frame = 0; };
function follow() {
  stopFollow();
  const el = chart.value;
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const stepMs = (parseFloat(getComputedStyle(el).getPropertyValue('--fn-t')) || 0.45) * 1000;
  const box = el.getBoundingClientRect();
  const x = (node) => node.getBoundingClientRect().left - box.left + el.scrollLeft; // in chart content pixels
  // Where the pen is at each step boundary: [time, x]. Between two points it moves at a steady speed, so a trunk
  // step (drawing down to a row further left) also brings the view back left at that speed.
  const keys = [];
  for (const [id, t] of Object.entries(steps.value).sort((a, b) => a[1].ring - b[1].ring)) {
    const card = el.querySelector(`.fn-card[data-screen="${id}"]`);
    if (!card) continue;
    const edge = t.arrow == null ? null : card.parentElement.previousElementSibling; // the arrow into this card
    if (edge) keys.push([t.arrow * stepMs, x(edge)], [(t.arrow + 1) * stepMs, x(card)]);
    else keys.push([t.ring * stepMs, x(card)]);
    keys.push([(t.ring + 1) * stepMs, x(card) + card.offsetWidth]);
  }
  if (keys.length < 2) return;
  const pad = 24;
  const started = performance.now();
  const tick = (now) => {
    const ms = now - started;
    const i = keys.findIndex(([t]) => t > ms);
    let pen;
    if (i === -1) pen = keys[keys.length - 1][1];
    else if (i === 0) pen = keys[0][1];
    else {
      const [t0, x0] = keys[i - 1];
      const [t1, x1] = keys[i];
      pen = x0 + (x1 - x0) * ((ms - t0) / (t1 - t0));
    }
    if (pen + pad > el.scrollLeft + el.clientWidth) el.scrollLeft = pen + pad - el.clientWidth;
    else if (pen - pad < el.scrollLeft) el.scrollLeft = Math.max(0, pen - pad);
    frame = i === -1 ? 0 : requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
watch([replay, steps], () => nextTick(follow));
onBeforeUnmount(stopFollow);
const unreached = computed(() => checked.value.filter((s) => resultOf(s) && !resultOf(s).reached));
const pending = computed(() => screens.value.some((s) => stateOf(s) === 'pending'));
const notInTicket = computed(() => screens.value.filter((s) => stateOf(s) === 'not-in-ticket').length);
const skippedNotes = computed(() => {
  const k = props.flow?.skipped;
  if (!k) return [];
  const notes = [];
  if (k.noLabel?.length) notes.push(`${k.noLabel.length} link${k.noLabel.length === 1 ? '' : 's'} from icon-only layers (no text to click on the live page): ${k.noLabel.slice(0, 3).map((n) => `“${n.layer}” → ${n.goesTo}`).join(', ')}`);
  if (k.overLimit) notes.push(`${k.overLimit} more screen${k.overLimit === 1 ? '' : 's'} beyond the limit of ${screens.value.length}`);
  if (k.missing) notes.push(`${k.missing} link${k.missing === 1 ? '' : 's'} to frames missing from the saved file`);
  return notes;
});
</script>

<template>
  <details class="accordion flow" @toggle="(e) => e.target.open && replay++">
    <summary>
      <span class="acc-title">Interaction flow</span>
      <span v-if="screens.length" class="score-chip">{{ screens.length + 1 }} screens</span>
      <span v-else-if="flow" class="score-chip">no links</span>
      <svg class="acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </summary>

    <p v-if="!apiFrame" class="hint">
      Shows the pages and modals this frame's prototype links lead to in Figma, and checks the ones the Jira ticket talks
      about by clicking through on the live site. It reads the whole Figma file, so retrieve the frame on the Figma API tab.
    </p>
    <template v-else-if="flow">
      <p v-if="!screens.length" class="hint">“{{ flow.startName }}” has no prototype links to another frame or overlay in Figma, so Check UI checks this frame only.</p>
      <template v-else>
        <div :key="replay" ref="chart" class="flow-chart" @wheel.passive="stopFollow" @pointerdown="stopFollow" @touchstart.passive="stopFollow" role="group" aria-label="Screens and the clicks between them">
          <FlowNode
            :screen="start"
            :screens="flow.screens"
            :number="number"
            :status="status"
            :state="stateOf"
            :item-count="itemCount"
            :locked="locked"
            :kids="kids"
            :timing="timing"
            @allow="(id, on) => emit('allow', id, on)"
          />
        </div>
        <div class="flow-foot">
          <p class="meta">
            <template v-if="busy">Clicking through {{ checked.length }} screen{{ checked.length === 1 ? '' : 's' }} at desktop, tablet and mobile…</template>
            <template v-else-if="pending">Check UI splits the Jira checklist across these screens and checks the ones it talks about.</template>
            <template v-else-if="notInTicket">{{ notInTicket }} screen{{ notInTicket === 1 ? ' is' : 's are' }} marked “not in this ticket”: no Jira checklist item is about {{ notInTicket === 1 ? 'it' : 'them' }}, so Check UI skips {{ notInTicket === 1 ? 'it' : 'them' }}.</template>
          </p>
          <button v-if="checked.length" class="ghost small" :disabled="locked" :title="`Click through and check ${checked.length} screen${checked.length === 1 ? '' : 's'} without re-running the first one`" @click="emit('run')">
            <span v-if="busy" class="spinner" aria-hidden="true"></span>
            Check flow only
          </button>
        </div>
        <ul v-if="unreached.length || skippedNotes.length" class="flow-skipped">
          <li v-for="s in unreached" :key="s.id" class="bad">{{ number(s.id) }} · {{ s.name }} was not reached last run: {{ resultOf(s).error }}</li>
          <li v-for="(n, i) in skippedNotes" :key="i">Not followed: {{ n }}.</li>
        </ul>
      </template>
    </template>
  </details>
</template>
