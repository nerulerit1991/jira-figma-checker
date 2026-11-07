import { readAppSettings, updateAppSettings } from './agentSettings.js';

// The widths every page is rendered at for the responsive check. People can add and delete their own in the
// Responsive layout section; "desktop" stays because the DOM summary and the Figma comparison are taken from it.
export const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
];

export const REQUIRED_VIEWPORT = 'desktop';
export const MAX_VIEWPORTS = 6;
const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const LIMITS = { width: [240, 3840], height: [320, 2400] };

/** Safe to use in a screenshot file name. */
export const isViewportName = (name) => NAME.test(String(name || ''));

// Claude scales each image down to ~1568px on the long edge, so long pages are sent as several tiles instead of
// one tall, unreadable image. maxTiles caps the token cost per viewport; narrower screens get taller tiles.
function withCaptureDefaults(v) {
  const wide = v.width >= 1024;
  return {
    ...v,
    tileHeight: wide ? 1200 : v.width >= 600 ? 1400 : 1600,
    maxTiles: wide ? 6 : 3,
    isMobile: v.width < 600,
    hasTouch: v.width < 1024,
  };
}

/**
 * The live list, widest first. Mutated in place on load and save, so every module importing it sees the change.
 * @type {Array<{ name: string, width: number, height: number, tileHeight: number, maxTiles: number, isMobile: boolean, hasTouch: boolean }>}
 */
export const VIEWPORTS = [];

function apply(list) {
  VIEWPORTS.splice(0, VIEWPORTS.length, ...[...list].sort((a, b) => b.width - a.width).map(withCaptureDefaults));
}
apply(DEFAULT_VIEWPORTS);

const publicList = () => VIEWPORTS.map(({ name, width, height }) => ({ name, width, height, required: name === REQUIRED_VIEWPORT }));

function validate(input) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!Array.isArray(input) || !input.length) throw bad('Keep at least one viewport.');
  if (input.length > MAX_VIEWPORTS) throw bad(`Use at most ${MAX_VIEWPORTS} viewports; each one adds screenshots and tokens to every check.`);
  const seen = new Set();
  const list = input.map((v) => {
    const name = String(v?.name || '').trim().toLowerCase();
    if (!isViewportName(name)) throw bad(`"${v?.name ?? ''}" is not a valid name: use 1–24 lowercase letters, digits or dashes.`);
    if (seen.has(name)) throw bad(`There is already a viewport named "${name}".`);
    seen.add(name);
    const size = {};
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const n = Number(v[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name}: ${key} must be a whole number from ${min} to ${max}px.`);
      size[key] = n;
    }
    return { name, ...size };
  });
  if (!seen.has(REQUIRED_VIEWPORT)) throw bad(`The "${REQUIRED_VIEWPORT}" viewport cannot be deleted; the Figma comparison and page content use it.`);
  return list;
}

/** Loads the saved list once at start-up; a missing or broken setting keeps the defaults. */
export async function loadViewports() {
  const saved = (await readAppSettings()).viewports;
  try {
    if (saved) apply(validate(saved));
  } catch (err) {
    console.warn(`Saved viewports ignored (${err.message}); using the defaults.`);
  }
  return publicList();
}

export const getViewports = () => publicList();

export async function setViewports(input) {
  const list = validate(input);
  await updateAppSettings({ viewports: list });
  apply(list);
  return publicList();
}
