<script setup>
// Spotlight tour: blurs and dims the page except one element, with a short description next to it.
// It acts out the real flow through `tour` (App.vue): opens the New ticket modal, types a link, adds a
// throwaway ticket, simulates Retrieve, then removes the ticket when the tour ends.
// Targets are found by [data-tour="..."]; a step whose element is missing is skipped.
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';

const open = defineModel('open', { type: Boolean, default: false });
const props = defineProps({
  // { start, openDialog, typeUrl, addTicket, retrieve, end }
  tour: { type: Object, required: true },
});

// enter: runs when the step is shown. next: runs when Next is clicked, before moving on.
const STEPS = [
  { target: 'new-ticket', title: 'Add a ticket', text: 'Every check starts with a Jira ticket. Click New ticket.', next: (t) => t.openDialog() },
  { target: 'ticket-modal', title: 'Paste the Jira link, then Add ticket', text: 'Paste or type the ticket link; the key (TOUR-1) is read from it. Next clicks Add ticket, which uses no tokens.', enter: (t) => t.typeUrl(), next: (t) => t.addTicket() },
  { selector: '.nav-item[data-key="TOUR-1"]', title: 'Ticket added', text: 'The new ticket now shows in your ticket list. Click a ticket here to open it.' },
  { target: 'retrieve-jira', intro: { target: 'jira-section', title: 'Jira section', text: 'The ticket opens with its Jira link. Nothing is read from Jira yet.' }, title: 'Retrieve Jira', text: 'Click Retrieve to read the ticket and build its acceptance checklist.', next: (t) => t.retrieve() },
  { target: 'retrieve-figma', intro: { target: 'figma-section', title: 'Figma section', text: 'Choose where the design is read from, then paste the Figma file or frame link. The Figma API is free and needs no AI tokens.', enter: (t) => t.typeFigma() }, title: 'Retrieve Figma', text: 'Click Retrieve to download the design.', next: (t) => t.retrieveFigma() },
  { target: 'page-url', title: 'Page URL', text: 'The built page to compare and test. Use a staging, UAT or local URL, never production.', enter: (t) => t.typePageUrl() },
  { target: 'check-ui', intro: { target: 'check', title: '02 · Check UI', text: 'Compares the live page with the Figma design and the checklist, per screen.' }, title: 'Run Check UI', text: 'Click play to screenshot the page and list mismatches. This uses AI tokens.', next: (t) => t.checkUi() },
  { target: 'generate-tests', intro: { target: 'tests', title: '03 · Functional & API tests', text: 'Playwright tests for the checklist items that need clicking, typing or a server response.' }, title: 'Generate tests', text: 'Writes the test scripts from the checklist. This uses AI tokens.', next: (t) => t.generateTests() },
  { target: 'run-tests', title: 'Run tests', text: 'Runs the saved tests against the page. Running uses no AI tokens; failed ones can be re-run alone.', next: (t) => t.runTests() },
  { target: 'improve', title: '04 · Improvements', text: 'Optional AI suggestions for what could be better.' },
  { target: 'scores', title: 'Scores', text: 'A quick summary of how the ticket is doing across checks and tests.' },
  { target: 'connections', title: 'Connections', text: 'Jira, Figma and the AI agent status. Fix or recheck one if it is red. The tour ticket is removed when you finish.' },
];

const PAD = 8;
const index = ref(0);
const rect = ref(null);
const busy = ref(false);
// Last place something was highlighted. While hidden between steps the highlight fades out there, then
// slides from it to the next element, instead of snapping or flashing at the screen corner.
const last = ref(null);
watch(rect, (r) => r && (last.value = r));
// The drawn rect eases toward the target in JS, once per frame. The blur panels, highlight and tip all read
// this one rect, so they always move together: no gaps while the page scrolls, and no snapping between steps.
const shown = ref(null);
let lastTime = 0;
function ease(now) {
  const target = rect.value || last.value;
  const dt = Math.min(64, now - (lastTime || now));
  lastTime = now;
  easeTip(dt);
  if (!target) return (shown.value = null);
  const cur = shown.value;
  if (!cur) return (shown.value = { ...target });
  const k = 1 - Math.exp(-dt / 70); // ~0.3s to settle, frame-rate independent
  const next = {};
  let moving = false;
  for (const p of ['top', 'left', 'width', 'height']) {
    const d = target[p] - cur[p];
    next[p] = Math.abs(d) < 0.5 ? target[p] : cur[p] + d * k;
    if (next[p] !== target[p]) moving = true;
  }
  if (moving || ['top', 'left', 'width', 'height'].some((p) => cur[p] !== next[p])) shown.value = next;
}
// intro: a first element shown on its own for a moment, then the highlight glides to the step's target by itself.
const intro = ref(false);
const INTRO_MS = 1600;
const INTRO_AFTER_ACT_MS = 800;
const step = computed(() => {
  const s = STEPS[index.value];
  return intro.value && s.intro ? { ...s, ...s.intro, next: null } : s;
});

// A step points at [data-tour="target"], or at any element through `selector`.
const el = (s) => document.querySelector(s.selector || `[data-tour="${s.target}"]`);

// Follow the element every frame, so modal animations, smooth scrolling and layout shifts never leave the
// highlight behind.
let frame = 0;
function track(now = performance.now()) {
  measure();
  ease(now);
  frame = requestAnimationFrame(track);
}

function measure() {
  if (tipEl.value) {
    const { offsetWidth: w, offsetHeight: h } = tipEl.value;
    if (h && (w !== tipSize.value.w || h !== tipSize.value.h)) tipSize.value = { w, h };
  }
  const node = step.value && el(step.value);
  const r = node?.getBoundingClientRect();
  // Missing or zero-size (e.g. the modal just closed): hide the highlight and tip instead of drawing them at 0,0.
  if (!r || (!r.width && !r.height) ) return (rect.value = null);
  const c = rect.value;
  if (c && c.top === r.top - PAD && c.left === r.left - PAD && c.width === r.width + PAD * 2 && c.height === r.height + PAD * 2) return;
  rect.value = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

function visible(s) {
  const r = el(s)?.getBoundingClientRect();
  return Boolean(r && (r.width || r.height));
}

// Waits (a few frames at most) for a step's element to appear, e.g. the new ticket row after Add ticket.
async function waitVisible(st, ms = 800) {
  const end = performance.now() + ms;
  while (!visible(st) && performance.now() < end) await new Promise(requestAnimationFrame);
  return visible(st);
}

async function show(i) {
  // Skip steps whose element never shows up (e.g. a card hidden on this ticket).
  while (i < STEPS.length && !(await waitVisible(STEPS[i], i === index.value + 1 ? 800 : 0))) i++;
  if (i >= STEPS.length) return close();
  index.value = i;
  if (STEPS[i].intro && visible(STEPS[i].intro)) {
    intro.value = true;
    busy.value = true;
    const node = el(STEPS[i].intro);
    if (!inView(node)) node.scrollIntoView({ block: 'center', behavior: 'instant' });
    measure();
    // The intro can act too (e.g. type the Figma link). After the action, hold a shorter beat (the typing
    // already kept it on screen); a plain intro holds the full INTRO_MS.
    const act = STEPS[i].intro.enter;
    await act?.(props.tour)?.catch?.(() => {});
    await new Promise((r) => setTimeout(r, act ? INTRO_AFTER_ACT_MS : INTRO_MS));
    intro.value = busy.value = false;
    if (!open.value) return;
  }
  // Instant scroll under the blur: the element lands in one place at once and the eased highlight and tip
  // glide there, instead of chasing a moving target through a smooth scroll.
  if (!inView(el(STEPS[i]))) el(STEPS[i]).scrollIntoView({ block: 'center', behavior: 'instant' });
  measure();
  if (STEPS[i].enter) await run(STEPS[i].enter);
}

function inView(node) {
  const r = node.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
}

async function run(fn) {
  busy.value = true;
  try {
    await fn(props.tour);
  } catch {
    // A failed step (e.g. the server is down) should not trap the person in the tour.
  } finally {
    busy.value = false;
  }
  if (!open.value) return;
  await nextTick();
  measure();
}

function close() {
  open.value = false;
}
async function next() {
  if (busy.value) return;
  const s = step.value;
  if (s.next) await run(s.next);
  if (!open.value) return;
  if (index.value < STEPS.length - 1) show(index.value + 1);
  else close();
}
// Only Skip and Next work during the tour: page clicks are caught by .tour-block, and keys aimed at the page
// (typing, Tab into the page, Space/Enter on a page button) are swallowed.
function onKey(e) {
  const inTip = tipEl.value?.contains(e.target);
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const buttons = [...(tipEl.value?.querySelectorAll('button:not([disabled])') || [])];
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement);
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  } else if (inTip && (e.key === 'Enter' || e.key === ' ')) {
    // Let the focused Skip / Next button handle it.
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    e.preventDefault();
    next();
  } else if (!inTip) {
    e.preventDefault();
    e.stopPropagation();
  }
}

watch(open, async (on) => {
  if (on) {
    props.tour.start();
    window.addEventListener('keydown', onKey, true);
    track();
    await nextTick();
    show(0);
  } else {
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(frame);
    rect.value = last.value = shown.value = tipPos.value = null;
    side = null;
    lastTime = 0;
    props.tour.end();
  }
});
onBeforeUnmount(() => (open.value = false));

// Four blurred panels around the hole, so the highlighted element stays sharp.
const panels = computed(() => {
  const r = shown.value;
  if (!r) return [{ top: 0, left: 0, width: '100vw', height: '100vh' }];
  const px = (n) => `${Math.max(0, n)}px`;
  return [
    { top: 0, left: 0, width: '100vw', height: px(r.top) },
    { top: px(r.top + r.height), left: 0, width: '100vw', bottom: 0 },
    { top: px(r.top), left: 0, width: px(r.left), height: px(r.height) },
    { top: px(r.top), left: px(r.left + r.width), right: 0, height: px(r.height) },
  ];
});

// Real tip size, read every frame in measure(), so placement never guesses.
const tipEl = ref(null);
const tipSize = ref({ w: 300, h: 200 });
const GAP = 14;
const M = 16;
// The tip is placed from the element's real position (not the easing highlight), keeps the side it is on while
// that side still fits (so it never flips back and forth mid-move), then eases there on its own.
const SIDES = ['right', 'left', 'below', 'above'];
let side = null;
const tipPos = ref(null);
function tipTarget(r) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = tipSize.value;
  const clampY = (y) => Math.min(Math.max(M, y), vh - h - M);
  const clampX = (x) => Math.min(Math.max(M, x), vw - w - M);
  const spots = {
    right: r.left + r.width + GAP + w <= vw - M && { left: r.left + r.width + GAP, top: clampY(r.top) },
    left: r.left - GAP - w >= M && { left: r.left - GAP - w, top: clampY(r.top) },
    below: r.top + r.height + GAP + h <= vh - M && { left: clampX(r.left), top: r.top + r.height + GAP },
    above: r.top - GAP - h >= M && { left: clampX(r.left), top: r.top - GAP - h },
  };
  if (!(side && spots[side])) side = SIDES.find((s) => spots[s]) || 'corner';
  // Element fills the screen: bottom-right corner.
  return spots[side] || { left: vw - w - M, top: vh - h - M };
}
function easeTip(dt) {
  const r = rect.value || last.value;
  if (!r) return;
  const target = tipTarget(r);
  const cur = tipPos.value;
  if (!cur) return (tipPos.value = target);
  const k = 1 - Math.exp(-dt / 70);
  const step = (a, b) => (Math.abs(b - a) < 0.5 ? b : a + (b - a) * k);
  const next = { left: step(cur.left, target.left), top: step(cur.top, target.top) };
  if (next.left !== cur.left || next.top !== cur.top) tipPos.value = next;
}
// A new step chooses its side afresh.
watch(index, () => (side = null));
const tipStyle = computed(() =>
  tipPos.value ? { top: `${tipPos.value.top}px`, left: `${tipPos.value.left}px` } : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="tour" role="dialog" aria-modal="true" :aria-label="step.title">
      <div v-for="(p, i) in panels" :key="i" class="tour-mask" :style="p" />
      <!-- Catches every click on the page (the highlighted element included); only the tip's buttons work. -->
      <div class="tour-block" />
      <div
        v-if="shown"
        :class="{ faded: !rect }"
        class="tour-hole"
        :style="{ top: shown.top + 'px', left: shown.left + 'px', width: shown.width + 'px', height: shown.height + 'px' }"
      />
      <div ref="tipEl" class="tour-tip" :class="{ faded: !rect }" :style="tipStyle">
        <p class="tour-count">{{ index + 1 }} / {{ STEPS.length }}</p>
        <h3>{{ step.title }}</h3>
        <p class="tour-text">{{ step.text }}</p>
        <div class="tour-actions">
          <button class="ghost" @click="close">Skip tour</button>
          <span class="tour-spacer" />
          <button v-if="!intro" class="primary" :disabled="busy" @click="next">
            {{ busy ? 'Working…' : index === STEPS.length - 1 ? 'Done' : 'Next' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* No positioning on the wrapper: each layer below stacks on the page, so the tour's non-modal
   New ticket dialog (z-index 1001) can sit between the blur (1000) and the click blocker (1002),
   highlight (1003) and tip (1004). */
.tour { display: contents; }
.tour-mask {
  position: fixed;
  z-index: 1000;
  background: rgba(10, 10, 14, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.tour-hole {
  transition: opacity 0.2s ease;
  position: fixed;
  z-index: 1003;
  border-radius: 10px;
  box-shadow: 0 0 0 2px var(--accent), 0 0 24px 4px var(--accent-soft);
  pointer-events: none;
}
.tour-tip {
  transition: opacity 0.2s ease;
  position: fixed;
  z-index: 1004;
  width: 300px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.tour-block { position: fixed; inset: 0; z-index: 1002; }
.faded { opacity: 0; pointer-events: none; }
.tour-count { margin: 0 0 4px; font-size: 0.75rem; color: var(--subtle); }
.tour-tip h3 { margin: 0 0 6px; font-size: 1rem; color: var(--text); }
.tour-text { margin: 0 0 14px; font-size: 0.875rem; line-height: 1.45; color: var(--muted); }
.tour-actions { display: flex; align-items: center; gap: 8px; }
.tour-spacer { flex: 1; }
</style>
