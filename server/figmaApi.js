// Reads a Figma frame straight from the Figma REST API with a personal access token (FIGMA_TOKEN).
// No AI is involved, so it costs no tokens. The whole file is saved once in data/full-figma/<fileKey>.json;
// each ticket's figma.json holds one frame from it, in the same shape as the AI fetch.

const API = 'https://api.figma.com/v1';
const MAX_TEXTS = 90;
const MAX_BOXES = 40;
const MAX_ICONS = 25;
const ICON_MAX_SIZE = 64; // px; small vector-only groups are treated as icons
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON']);

// Figma's limits depend on the account's seat; a "low" seat may be blocked for days after a few reads.
// While blocked, the API tab says so instead of calling Figma again.
let blockedUntil = 0;
export const figmaApiBlockedUntil = () => (blockedUntil > Date.now() ? new Date(blockedUntil).toISOString() : null);
export const figmaApiEnabled = () => Boolean(process.env.FIGMA_TOKEN) && !figmaApiBlockedUntil();

async function figmaGet(pathAndQuery) {
  let res;
  try {
    res = await fetch(`${API}${pathAndQuery}`, { headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN } });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach the Figma API (${err.cause?.code || err.message}).`), { status: 502 });
  }
  if (res.ok) return res.json();
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after')) || 60;
    blockedUntil = Date.now() + seconds * 1000;
    const until = new Date(blockedUntil).toLocaleString();
    throw Object.assign(new Error(`Figma API limit reached for this account (${res.headers.get('x-figma-rate-limit-type') || 'unknown'} tier) until ${until}.`), { status: 429, rateLimited: true });
  }
  const body = await res.json().catch(() => ({}));
  const detail = body.err || body.message || '';
  if (res.status === 403 && /scope/i.test(detail)) {
    throw Object.assign(new Error('The Figma token is missing the "File content: Read" scope. Create a new token with File content: Read and File versions: Read, put it in .env as FIGMA_TOKEN and restart the app.'), { status: 502 });
  }
  const messages = {
    400: 'Figma rejected the request. Check the link has a valid node-id.',
    403: 'The Figma token was refused, or it cannot open this file. Check FIGMA_TOKEN in .env has "File content: Read" and your account can view the file.',
    404: 'Figma file or frame not found. Check the link.',
  };
  throw Object.assign(new Error(messages[res.status] || `Figma API error (${res.status}).`), { status: 502 });
}

// ---- Value helpers ----

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
const hex = ({ r, g, b }, alpha = 1) => {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${alpha < 1 ? h(alpha) : ''}`.toUpperCase();
};
/** The first visible solid fill as hex, or a short description of a gradient/image. */
function paint(fills) {
  const p = (fills || []).find((f) => f.visible !== false);
  if (!p) return null;
  if (p.type === 'SOLID') return hex(p.color, (p.opacity ?? 1) * (p.color.a ?? 1));
  if (p.type.startsWith('GRADIENT')) return `${p.type.toLowerCase().replace('_', ' ')} (${(p.gradientStops || []).map((s) => hex(s.color, s.color.a ?? 1)).join(' → ')})`;
  if (p.type === 'IMAGE') return 'image';
  return null;
}
const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };

function lineHeight(style) {
  if (style.lineHeightUnit === 'INTRINSIC_%' || style.lineHeightPx == null) return 'normal';
  return `${round(style.lineHeightPx)}px`;
}
function sides(t, r, b, l) {
  if ([t, r, b, l].every((v) => !v)) return null;
  return t === b && r === l ? (t === r ? `${t}px` : `${t}px ${r}px`) : `${t}px ${r}px ${b}px ${l}px`;
}
function radius(node) {
  if (node.rectangleCornerRadii) {
    const [a, b, c, d] = node.rectangleCornerRadii;
    return a === b && b === c && c === d ? (a ? `${a}px` : null) : `${a}px ${b}px ${c}px ${d}px`;
  }
  return node.cornerRadius ? `${node.cornerRadius}px` : null;
}
function border(node) {
  const color = paint(node.strokes);
  return color && node.strokeWeight ? `${node.strokeWeight}px ${color}` : null;
}

/**
 * Parts of a text layer styled differently from its base style (e.g. a bold first line), or null if uniform.
 * Figma stores per-character override ids in characterStyleOverrides, mapped to styles in styleOverrideTable.
 */
function segments(node) {
  const ids = node.characterStyleOverrides;
  const table = node.styleOverrideTable || {};
  if (!ids?.some((id) => id && table[id])) return null;
  const base = node.style || {};
  const chars = [...(node.characters || '')];
  const parts = [];
  for (let i = 0; i < chars.length; i++) {
    const id = ids[i] || 0; // characters past the end of the array use the base style
    if (parts.length && parts.at(-1).id === id) parts.at(-1).text += chars[i];
    else parts.push({ id, text: chars[i] });
  }
  const out = parts
    .map(({ id, text }) => {
      const s = { ...base, ...(table[id] || {}) };
      return { text: text.replace(/\s+/g, ' ').trim().slice(0, 80), font: `${s.fontWeight} ${round(s.fontSize)}px/${lineHeight(s)} ${s.fontFamily}`, color: paint(table[id]?.fills) || undefined };
    })
    .filter((p) => p.text);
  return new Set(out.map((p) => p.font + p.color)).size > 1 ? out.slice(0, 6) : null;
}

// ---- Tree walk ----

const isVisible = (n) => n.visible !== false && (n.opacity ?? 1) > 0;
const allVectors = (n) => (n.children?.length ? n.children.filter(isVisible).every(allVectors) : VECTOR_TYPES.has(n.type));

/** Where an icon's drawing is visible: the union of its vectors' rendered bounds (a frame's own box includes empty space). */
function renderBounds(n) {
  const boxes = [];
  const collect = (x) => {
    if (!isVisible(x)) return;
    if (VECTOR_TYPES.has(x.type)) {
      const b = x.absoluteRenderBounds || x.absoluteBoundingBox;
      if (b) boxes.push(b);
    } else (x.children || []).forEach(collect);
  };
  collect(n);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Turns a frame's node tree into the figma.json shape used by the check:
 * texts, colours, typography and up to ~150 positioned specs (x/y relative to the frame's top-left).
 */
function extract(root) {
  const origin = root.absoluteBoundingBox || { x: 0, y: 0 };
  const texts = [];
  const boxes = [];
  const icons = [];
  const colorUse = new Map();
  const typeUse = new Map();
  let decorative = 0;

  const pos = (b) => ({ x: round(b.x - origin.x), y: round(b.y - origin.y), width: round(b.width), height: round(b.height) });
  const useColor = (color, usage) => {
    if (!color || !color.startsWith('#')) return;
    const c = colorUse.get(color) || { hex: color, uses: new Set(), count: 0 };
    c.uses.add(usage);
    c.count++;
    colorUse.set(color, c);
  };

  function walk(node, section) {
    if (!isVisible(node)) return;
    const box = node.absoluteBoundingBox;

    if (node.type === 'TEXT' && box) {
      const s = node.style || {};
      const color = paint(node.fills);
      const text = (node.characters || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      useColor(color, 'text');
      const typeKey = `${s.fontFamily}|${s.fontWeight}|${s.fontSize}|${lineHeight(s)}|${s.letterSpacing || 0}`;
      const t = typeUse.get(typeKey) || { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: lineHeight(s), letterSpacing: s.letterSpacing ? `${round(s.letterSpacing)}px` : null, examples: [], count: 0 };
      t.count++;
      if (t.examples.length < 2) t.examples.push(text.slice(0, 40));
      typeUse.set(typeKey, t);
      texts.push({
        section, element: `text "${node.name}"`, text: text.slice(0, 120), ...pos(box), segments: segments(node),
        fontFamily: s.fontFamily ?? null, fontSize: s.fontSize ?? null, fontWeight: s.fontWeight ?? null,
        lineHeight: lineHeight(s), letterSpacing: s.letterSpacing ? `${round(s.letterSpacing)}px` : null,
        textTransform: TEXT_CASE[s.textCase] || null, textAlign: s.textAlignHorizontal?.toLowerCase() || null, color,
      });
      return;
    }

    // Icons: small groups made only of vectors. Record the frame and where the visible drawing actually sits.
    if (box && node.type !== 'TEXT' && box.width <= ICON_MAX_SIZE && box.height <= ICON_MAX_SIZE && allVectors(node)) {
      const visible = renderBounds(node);
      const dx = visible ? round(visible.x - box.x) : 0;
      const dy = visible ? round(visible.y - box.y) : 0;
      icons.push({
        section, element: `icon "${node.name}"`, text: null, ...pos(box),
        visualOffset: dx || dy ? `drawing starts ${dy}px from the top, ${dx}px from the left of its ${round(box.width)}x${round(box.height)} frame` : null,
        visibleBox: visible ? pos(visible) : null,
        color: paint(node.fills) || paint(node.children?.[0]?.fills) || paint(node.strokes) || null,
      });
      return;
    }
    // Large free vectors are illustrations or background shapes; not useful for spacing checks.
    if (VECTOR_TYPES.has(node.type)) {
      decorative++;
      return;
    }

    if (box && node !== root) {
      const background = paint(node.fills);
      const padding = node.layoutMode && node.layoutMode !== 'NONE' ? sides(node.paddingTop || 0, node.paddingRight || 0, node.paddingBottom || 0, node.paddingLeft || 0) : null;
      const gap = node.layoutMode && node.layoutMode !== 'NONE' && node.itemSpacing ? `${round(node.itemSpacing)}px ${node.layoutMode === 'HORIZONTAL' ? 'horizontal' : 'vertical'}` : null;
      const r = radius(node);
      const b = border(node);
      useColor(background, 'background');
      if (background || padding || gap || r || b) {
        boxes.push({ section, element: `${node.type.toLowerCase()} "${node.name}"`, text: null, ...pos(box), padding, gap, background, borderRadius: r, border: b });
      }
    }

    for (const child of node.children || []) walk(child, node === root ? sectionLabel(child) : section);
  }

  // Designers often reuse names ("Hero" for every section) or leave defaults ("Frame 142"),
  // so such sections are also labelled by their first text, e.g. 'Hero · "Our Story"'.
  const topNames = (root.children || []).filter(isVisible).map((c) => c.name);
  const firstText = (n) => (n.type === 'TEXT' && isVisible(n) ? n.characters?.trim() : (n.children || []).map(firstText).find(Boolean));
  function sectionLabel(child) {
    const generic = /^(frame|group|section|rectangle|component)\s*\d*$/i.test(child.name);
    const repeated = topNames.filter((n) => n === child.name).length > 1;
    const text = (generic || repeated) && firstText(child)?.replace(/\s+/g, ' ').slice(0, 40);
    return text ? `${child.name} · "${text}"` : child.name;
  }
  const sectionLabels = (root.children || []).filter(isVisible).map(sectionLabel);
  walk(root, null);

  const specs = [...texts.slice(0, MAX_TEXTS), ...boxes.slice(0, MAX_BOXES), ...icons.slice(0, MAX_ICONS)]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)));

  const notes = [];
  if (texts.length > MAX_TEXTS) notes.push(`${texts.length - MAX_TEXTS} more text layers were left out of specs.`);
  if (boxes.length > MAX_BOXES) notes.push(`${boxes.length - MAX_BOXES} more styled containers were left out of specs.`);
  if (decorative) notes.push(`${decorative} decorative vector shapes were skipped.`);
  if (!boxes.some((x) => x.padding)) notes.push('No auto-layout in this frame, so Figma has no padding/gap values; compare positions instead.');
  notes.push('Positions (x, y) are measured from the top-left corner of the frame.');

  return {
    texts: [...new Set(texts.map((t) => t.text))].slice(0, 120),
    colors: [...colorUse.values()].sort((a, b) => b.count - a.count).slice(0, 20).map((c) => ({ name: null, hex: c.hex, usage: [...c.uses].join(', ') })),
    typography: [...typeUse.values()].sort((a, b) => b.count - a.count).slice(0, 15).map(({ examples, count, ...t }) => ({ name: null, ...t, usage: `${count} text layers, e.g. "${examples.join('", "')}"` })),
    specs,
    notes,
    sections: sectionLabels,
  };
}

/** Last editor of the file, from its version history (needs the "File versions: Read" scope). */
async function lastVersion(fileKey) {
  try {
    const { versions } = await figmaGet(`/files/${fileKey}/versions?page_size=1`);
    const v = versions?.[0];
    return v ? { at: v.created_at, by: v.user?.handle || null } : null;
  } catch {
    return null;
  }
}

/** Checks the API can be used now; says why not (no token, or Figma's rate limit) instead of calling it. */
function requireFigmaApi() {
  if (!process.env.FIGMA_TOKEN) {
    throw Object.assign(new Error('No Figma API token. Add a personal access token to .env as FIGMA_TOKEN (scopes: File content: Read, File versions: Read) and restart the app, or use the MCP or Desktop bridge tab.'), { status: 400 });
  }
  const until = figmaApiBlockedUntil();
  if (until) {
    throw Object.assign(new Error(`Figma API limit reached for this account until ${new Date(until).toLocaleString()}. Try again then, or use the MCP or Desktop bridge tab.`), { status: 429 });
  }
}

/**
 * Downloads the whole Figma file (every page and frame) in one API call, plus who last edited it.
 * @returns {{ file: object, version: { at: string, by: string | null } | null }}
 */
export async function fetchFigmaFile(fileKey) {
  requireFigmaApi();
  try {
    const [file, version] = await Promise.all([figmaGet(`/files/${fileKey}`), lastVersion(fileKey)]);
    return { file, version };
  } catch (err) {
    if (err.rateLimited) err.message += ' Use the MCP or Desktop bridge tab meanwhile.';
    throw err;
  }
}

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const firstFrame = (page) => page?.children?.find((c) => c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'SECTION');

const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);

/** Every top-level frame on every page (frames inside sections too), for picking which one to check. */
export function listFrames(file) {
  const frames = [];
  const add = (node, page, section) => {
    if (node.visible === false) return;
    if (node.type === 'SECTION') return (node.children || []).forEach((c) => add(c, page, node.name));
    if (!FRAME_TYPES.has(node.type)) return;
    const box = node.absoluteBoundingBox;
    frames.push({ id: node.id, name: node.name, type: node.type, page: page.name, section: section || null, width: box ? round(box.width) : null, height: box ? round(box.height) : null });
  };
  for (const page of file.document?.children || []) (page.children || []).forEach((c) => add(c, page));
  return frames;
}

/**
 * Picks one frame out of a downloaded file: the link's node-id, or the first frame of the first page when
 * the link has none (or points at a whole page). Returns data in the same shape as the AI fetch.
 */
export function frameFromFile({ file, version }, nodeId) {
  const pages = file.document?.children || [];
  let root = nodeId ? findNode(file.document, nodeId) : firstFrame(pages[0]);
  if (nodeId && !root) throw Object.assign(new Error(`Frame ${nodeId} was not found in the Figma file "${file.name}". Check the link's node-id, or re-fetch if the frame was added after the file was saved.`), { status: 404 });
  if (root?.type === 'CANVAS') root = firstFrame(root);
  if (!root) throw Object.assign(new Error('Found no frame to read: the link has no node-id and the page has no frames. Copy the link of a frame in Figma (right-click → Copy link to selection).'), { status: 400 });

  const page = pages.find((p) => findNode(p, root.id));
  const box = root.absoluteBoundingBox;
  const extracted = extract(root);
  return {
    fileName: file.name || null,
    pageName: page?.name || null,
    nodeId: root.id,
    nodeName: root.name,
    nodeType: root.type,
    frameWidth: box ? round(box.width) : null,
    frameHeight: box ? round(box.height) : null,
    lastModified: version?.at || file.lastModified || null,
    lastModifiedBy: version?.by || null,
    summary: `${root.type.toLowerCase()} "${root.name}"${box ? ` (${round(box.width)}x${round(box.height)}px)` : ''} with ${extracted.sections.length} top-level sections: ${extracted.sections.slice(0, 15).join(', ')}.`,
    texts: extracted.texts,
    colors: extracted.colors,
    typography: extracted.typography,
    specs: extracted.specs,
    notes: extracted.notes,
  };
}
