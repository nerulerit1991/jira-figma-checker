// Interaction flow: the pages and modals a person reaches by clicking from the ticket's Figma frame.
//
// 1. Map (no AI, no Figma API call): follow the prototype links ("On click → Navigate to / Open overlay") in the
//    whole Figma file saved by the Figma API tab, starting at the ticket's frame. Each destination frame becomes a
//    screen, with the clicks that lead to it. Saved to data/<KEY>/flow.json.
// 2. Run: for each screen, open the page in Playwright, click the same buttons by their visible text, capture the
//    page (or just the modal) and compare it with that screen's Figma frame. Saved to data/<KEY>/flow-check.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { findNode, frameFromFile } from './figmaApi.js';
import { collectStyles, detectLayoutIssues, preparePage, VIEWPORTS } from './capture.js';
import { sameSite } from './tests.js';
import { checkedScreens } from './flowScope.js';

// Keeps a run to a few minutes and its token cost predictable.
export const MAX_SCREENS = 8;
const MAX_DEPTH = 4;
const CLICK_TRIGGERS = new Set(['ON_CLICK', 'ON_PRESS']);
// Navigate to a frame, open an overlay, or swap the open overlay for another. CHANGE_TO (component variants such
// as hover states), SCROLL_TO and BACK do not show another frame.
const FRAME_ACTIONS = { NAVIGATE: 'page', OVERLAY: 'overlay', SWAP: 'overlay' };
// Clicks that may change saved data or move money. Screens behind them are mapped but skipped until allowed.
const RISKY = /\b(delete|remove|destroy|deactivate|disable|archive|cancel|revoke|reset|send|invite|publish|approve|reject|pay|purchase|buy|place order|transfer|save|submit|confirm|unsubscribe|sign ?out|log ?out)\b/i;

const visible = (n) => n.visible !== false && (n.opacity ?? 1) > 0;
const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** The text a person sees on a clickable layer (its own characters or first text layers), and its first text alone. */
function labelOf(node) {
  if (node.type === 'TEXT') {
    const text = clean(node.characters).slice(0, 80);
    return text ? { text, first: null } : null;
  }
  const texts = [];
  (function walk(n) {
    if (texts.length >= 2 || !visible(n)) return;
    if (n.type === 'TEXT' && clean(n.characters)) texts.push(clean(n.characters));
    else (n.children || []).forEach(walk);
  })(node);
  if (!texts.length) return null;
  // A card's name and title are separate elements on the live page, so the first text is also tried on its own.
  return { text: texts.join(' ').slice(0, 80), first: texts.length > 1 ? texts[0].slice(0, 80) : null };
}

/** Click interactions inside a frame that show another frame. */
function triggersIn(root) {
  const found = [];
  let variantChanges = 0;
  (function walk(node) {
    if (!visible(node)) return;
    for (const it of node.interactions || []) {
      if (!CLICK_TRIGGERS.has(it?.trigger?.type)) continue;
      for (const a of it.actions || []) {
        if (a?.type !== 'NODE' || !a.destinationId) continue;
        if (a.navigation === 'CHANGE_TO') variantChanges++;
        const kind = FRAME_ACTIONS[a.navigation];
        if (!kind) continue;
        found.push({ node, kind, destinationId: a.destinationId });
      }
    }
    // Files from before Figma's interactions model only have transitionNodeID (a click that navigates). Newer files
    // also set it for variant changes, so it only counts on layers without any interactions.
    if (!node.interactions?.length && node.transitionNodeID) found.push({ node, kind: 'page', destinationId: node.transitionNodeID });
    (node.children || []).forEach(walk);
  })(root);
  return { found, variantChanges };
}

/**
 * Screens reachable by clicking from the start frame, breadth first (shortest click path wins), at most
 * MAX_SCREENS besides the start. `previous` keeps the person's on/off choices for screens mapped before.
 */
export function buildFlowMap(full, startNodeId, previous = null) {
  const { file } = full;
  const start = findNode(file.document, startNodeId);
  if (!start) throw Object.assign(new Error(`Frame ${startNodeId} is not in the saved Figma file. Re-fetch Figma, then map again.`), { status: 404 });
  // A risky screen the person allowed stays allowed when the map is rebuilt.
  const allowed = new Set((previous?.screens || []).filter((s) => s.allowRisky).map((s) => s.nodeId));
  const screens = [{ id: 'S0', nodeId: start.id, name: start.name, kind: 'start', steps: [] }];
  const seen = new Set([start.id]);
  const skipped = { variantChanges: 0, noLabel: [], missing: 0, overLimit: 0 };
  // Variants of a component (children of a component set) are states of one element, never a screen.
  const variants = new Set();
  (function walk(n) {
    if (n.type === 'COMPONENT_SET') (n.children || []).forEach((c) => variants.add(c.id));
    (n.children || []).forEach(walk);
  })(file.document);

  for (let i = 0; i < screens.length; i++) {
    const from = screens[i];
    if (from.steps.length >= MAX_DEPTH) continue;
    const { found, variantChanges } = triggersIn(findNode(file.document, from.nodeId));
    skipped.variantChanges += variantChanges;
    for (const t of found) {
      if (seen.has(t.destinationId)) continue;
      const dest = findNode(file.document, t.destinationId);
      if (!dest) {
        skipped.missing++;
        continue;
      }
      if (variants.has(dest.id)) {
        skipped.variantChanges++;
        continue;
      }
      seen.add(dest.id);
      const label = labelOf(t.node);
      // Icon-only buttons have no text to find on the live page.
      if (!label) {
        skipped.noLabel.push({ layer: t.node.name, goesTo: dest.name });
        continue;
      }
      if (screens.length > MAX_SCREENS) {
        skipped.overLimit++;
        continue;
      }
      const steps = [...from.steps, { text: label.text, ...(label.first && { first: label.first }), layer: t.node.name, kind: t.kind, from: from.name }];
      const risky = steps.some((s) => RISKY.test(s.text));
      const box = dest.absoluteBoundingBox;
      screens.push({
        id: `S${screens.length}`,
        nodeId: dest.id,
        name: dest.name,
        kind: t.kind,
        steps,
        frameWidth: box ? Math.round(box.width) : null,
        frameHeight: box ? Math.round(box.height) : null,
        // Opened from a page (not another modal): the viewport of the frame it was opened from.
        parentId: from.id,
        risky,
        ...(risky && allowed.has(dest.id) && { allowRisky: true }),
      });
    }
  }
  return {
    fileKey: full.fileKey,
    figmaFetchedAt: full.fetchedAt,
    startNodeId: start.id,
    startName: start.name,
    startFrameWidth: start.absoluteBoundingBox ? Math.round(start.absoluteBoundingBox.width) : null,
    builtAt: new Date().toISOString(),
    screens,
    skipped,
  };
}

/** Live viewport for a screen: a page by its own frame width, a modal by the page it opens on. */
export function viewportOfScreen(map, screen) {
  let s = screen;
  while (s.kind === 'overlay' && s.parentId) s = map.screens.find((x) => x.id === s.parentId) || { kind: 'start' };
  const width = s.kind === 'start' ? map.startFrameWidth : s.frameWidth;
  if (!width) return { ...VIEWPORTS[0] };
  const preset = VIEWPORTS.reduce((best, v) => (Math.abs(v.width - width) < Math.abs(best.width - width) ? v : best));
  return preset.name === 'desktop' && width >= 1024 && width <= 2560 ? { ...preset, width } : { ...preset };
}

/** Every configured viewport a screen is captured at, with the compared one at its frame's width. */
export function viewportsOfScreen(map, screen) {
  const compare = viewportOfScreen(map, screen);
  return VIEWPORTS.map((v) => (v.name === compare.name ? compare : { ...v }));
}

/** The visible element a person would click for this label: a button or link first, then any matching text. */
async function findClickable(page, text) {
  const candidates = [
    page.getByRole('button', { name: text, exact: true }),
    page.getByRole('link', { name: text, exact: true }),
    page.getByRole('button', { name: text }),
    page.getByRole('link', { name: text }),
    page.getByText(text, { exact: true }),
    page.getByText(text),
  ];
  for (const locator of candidates) {
    const count = Math.min(await locator.count(), 6);
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

const DIALOG = '[role=dialog]:visible, [role=alertdialog]:visible, dialog[open], [aria-modal=true]:visible';

/**
 * Opens `startUrl`, clicks through `screen.steps` and captures where it lands. Never leaves the site under test:
 * a click that goes to another site stops the run for that screen before anything is captured there.
 */
async function captureScreen(browser, { startUrl, screen, viewport, storageState, shotPath }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    storageState,
  });
  try {
    let page = await context.newPage();
    try {
      await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (err) {
      if (!page.url() || page.url() === 'about:blank') throw new Error(`Could not open ${startUrl} (${err.message.split('\n')[0]}).`);
    }

    for (const [i, step] of screen.steps.entries()) {
      const el = (await findClickable(page, step.text)) || (step.first && (await findClickable(page, step.first)));
      if (!el) return { reached: false, error: `Step ${i + 1}: no visible button, link or text "${step.text}" on ${page.url()}.` };
      const opened = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
      await el.click({ timeout: 8000 });
      const newTab = await opened;
      if (newTab) page = newTab;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600); // open/transition animations
      if (!sameSite(page.url(), startUrl)) {
        return { reached: false, error: `Step ${i + 1}: clicking "${step.text}" left the site (${new URL(page.url()).host}). Other sites are not checked.` };
      }
    }

    const landedUrl = page.url();
    if (screen.kind === 'overlay') {
      const dialog = page.locator(DIALOG).last();
      const found = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
      if (found) {
        await dialog.evaluate((el) => el.setAttribute('data-flow-root', ''));
        const buffer = await dialog.screenshot({ type: 'jpeg', quality: 65 });
        await fs.writeFile(shotPath, buffer);
        const box = await dialog.boundingBox();
        return {
          reached: true, landedUrl, viewport: viewport.name, width: viewport.width, pageHeight: Math.round(box?.height || 0), scoped: true,
          tiles: [{ from: 0, to: Math.round(box?.height || 0), base64: buffer.toString('base64') }],
          styles: await page.evaluate(collectStyles, { root: '[data-flow-root]' }),
          layout: await page.evaluate(detectLayoutIssues),
        };
      }
      // A modal without dialog semantics: compare the visible screen instead.
      const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
      await fs.writeFile(shotPath, buffer);
      return {
        reached: true, landedUrl, viewport: viewport.name, width: viewport.width, pageHeight: viewport.height, scoped: false,
        note: 'No element with role="dialog" or aria-modal was found, so the whole visible screen was captured; compare the modal part of it.',
        tiles: [{ from: 0, to: viewport.height, base64: buffer.toString('base64') }],
        styles: await page.evaluate(collectStyles, viewport.height),
        layout: await page.evaluate(detectLayoutIssues),
      };
    }

    await page.evaluate(preparePage);
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: shotPath, type: 'jpeg', quality: 60, fullPage: true });
    const tiles = [];
    for (let y = 0; y < pageHeight && tiles.length < viewport.maxTiles; y += viewport.tileHeight) {
      const height = Math.min(viewport.tileHeight, pageHeight - y);
      if (height < 50) break;
      const buffer = await page.screenshot({ type: 'jpeg', quality: 65, clip: { x: 0, y, width: viewport.width, height }, fullPage: true });
      tiles.push({ from: y, to: y + height, base64: buffer.toString('base64') });
    }
    return {
      reached: true, landedUrl, viewport: viewport.name, width: viewport.width, pageHeight,
      tiles,
      styles: await page.evaluate(collectStyles, pageHeight),
      layout: await page.evaluate(detectLayoutIssues),
    };
  } catch (err) {
    return { reached: false, error: err.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

export const flowShotPath = (ticketDir, screenId, viewport) => path.join(ticketDir, 'flow', `${screenId}-${viewport}.jpg`);

/**
 * Captures every checked screen (flowScope.js; the start frame is Check UI's job) at desktop, tablet and mobile, and asks
 * `compare(screen, figma, { compare, others })` for the design verdict (at the viewport matching the Figma frame) and
 * the responsive verdict (all three). One browser, a fresh signed-in context per screen and viewport, so one run's
 * clicks never affect another. A viewport where the clicks cannot be repeated (e.g. the button is behind a mobile
 * menu) fails its responsive check with the reason instead of being judged.
 */
export async function runFlow({ map, full, startUrl, ticketDir, storageState, compare, itemsFor = () => [] }) {
  const { chromium } = await import('playwright');
  const screens = checkedScreens(map);
  await fs.rm(path.join(ticketDir, 'flow'), { recursive: true, force: true });
  await fs.mkdir(path.join(ticketDir, 'flow'), { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const screen of screens) {
      const compareViewport = viewportOfScreen(map, screen);
      const base = { id: screen.id, nodeId: screen.nodeId, name: screen.name, kind: screen.kind, steps: screen.steps };
      const captures = [];
      for (const viewport of viewportsOfScreen(map, screen)) {
        const capture = await captureScreen(browser, { startUrl, screen, viewport, storageState, shotPath: flowShotPath(ticketDir, screen.id, viewport.name) });
        captures.push({ ...capture, viewport: viewport.name, width: viewport.width });
      }
      const main = captures.find((c) => c.viewport === compareViewport.name);
      const checklist = itemsFor(screen);
      if (!main.reached) {
        // The screen's checklist items fail with the reason: what they describe could not be reached.
        const results_ = checklist.map((i) => ({ id: i.id, item: i.item, passed: false, confidence: 'high', evidence: `Screen not reached: ${main.error}` }));
        results.push({ ...base, reached: false, error: main.error, viewport: main.viewport, width: main.width, results: results_ });
        continue;
      }
      // The design is compared at one viewport only, so the other viewports' styles are not sent.
      const others = captures.filter((c) => c !== main && c.reached).map(({ styles, ...c }) => c);
      const unreached = captures.filter((c) => !c.reached).map((c) => ({
        viewport: c.viewport, width: c.width, passed: false, issues: [`Could not reach this screen at ${c.width}px: ${c.error}`],
      }));
      const figma = frameFromFile(full, screen.nodeId);
      const verdict = await compare(screen, figma, { compare: main, others }, checklist).catch((err) => ({ error: err.message }));
      const order = VIEWPORTS.map((v) => v.name);
      results.push({
        ...base,
        reached: true,
        landedUrl: main.landedUrl,
        viewport: main.viewport,
        width: main.width,
        note: main.note || null,
        screenshots: captures.filter((c) => c.reached).map((c) => ({ viewport: c.viewport, width: c.width })),
        ...(verdict.error
          ? { error: `Captured, but the comparison failed: ${verdict.error}`, responsive: unreached }
          : {
              results: (verdict.data.results || []).filter((r) => checklist.some((i) => i.id === r.id)),
              designChecklist: verdict.data.designChecklist || [],
              designMatch: verdict.data.designMatch || null,
              responsive: [...(verdict.data.responsive || []).filter((r) => !unreached.some((u) => u.viewport === r.viewport)), ...unreached]
                .sort((a, b) => order.indexOf(a.viewport) - order.indexOf(b.viewport)),
              summary: verdict.data.summary || '',
            }),
      });
    }
  } finally {
    await browser.close();
  }
  return results;
}
