// Monitoring: a list of website URLs. Each check crawls the site from its URL in a headless browser (signed in with a
// chosen .env test-account profile, or signed out), opening every same-site page once (initial load only, read-only:
// writes are blocked) to collect network errors and keys exposed in the site's own HTML / JS / JSON (masked, see
// secretScan.js). No AI is involved.
//
// Stored in data/monitor/:
//   sites.json            [{ id, url, profile, addedAt, lastRun }]
//   <profile>/.auth/      sign-in session per profile (same files as a ticket's login, see login.js), so every site
//                         using a profile shares one session.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './store.js';
import { scanForSecrets, redact } from './secretScan.js';
import { originalPosition, sourceMapUrl, inlineSourceMap } from './sourceMap.js';
import { envProfiles, enableEnvLogin, getLoginSettings, prepareSession, answerChallenge } from './login.js';

const MONITOR_DIR = path.join(DATA_DIR, 'monitor');
const SITES_FILE = path.join(MONITOR_DIR, 'sites.json');
const NO_LOGIN = 'none';
const DEFAULT_PROFILE = 'default';
const PAGE_TIMEOUT_MS = 45_000;
// Extra time after the network goes quiet, for errors thrown by scripts that run a moment after load.
const SETTLE_MS = 2500;
const MAX_ERRORS = 200;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// login.js key for a profile's sign-in files: data/monitor/<profile>/.auth/.
const loginKey = (profile) => `monitor/${profile}`;
// login.js profile id: null for the default PROJECT_* account.
const envProfileId = (profile) => (profile === DEFAULT_PROFILE ? null : profile);

// Site ids being checked right now -> promise of the run.
const running = new Map();
// Site id -> { done, total, current }: the page a running crawl is on, for the UI.
const progress = new Map();
// Writes to sites.json one after another, so two runs finishing together never drop each other's result.
let writeQueue = Promise.resolve();

async function readSites() {
  try {
    const sites = JSON.parse(await fs.readFile(SITES_FILE, 'utf8'));
    return Array.isArray(sites) ? sites : [];
  } catch {
    return [];
  }
}

function updateSites(change) {
  const next = writeQueue.then(async () => {
    const sites = change(await readSites());
    await fs.mkdir(MONITOR_DIR, { recursive: true });
    await writeFileAtomic(SITES_FILE, JSON.stringify(sites, null, 2));
    return sites;
  });
  writeQueue = next.catch(() => {});
  return next;
}

/** Dropdown choices: signed out, then each .env profile that has both a username and a password. */
export function monitorProfiles() {
  return [
    { id: NO_LOGIN, label: 'No login' },
    ...envProfiles().map((p) => ({ id: p.id || DEFAULT_PROFILE, label: p.label, username: p.username, loginUrl: p.loginUrl })),
  ];
}

function normalizeUrl(input) {
  const text = String(input || '').trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw httpError(400, 'Enter a full website URL, e.g. https://staging.example.com.');
  }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, 'The URL must start with http:// or https://.');
  return url.href;
}

function checkProfile(profile) {
  if (!monitorProfiles().some((p) => p.id === profile)) {
    throw httpError(400, `Unknown credentials "${profile}". Add PROJECT_<NAME>_USERNAME_EMAIL and PROJECT_<NAME>_PASSWORD to .env and restart the server.`);
  }
}

/** Sites with their last run, whether a run is going, and any OTP / CAPTCHA a sign-in is waiting for. */
export async function getMonitor() {
  const sites = (await readSites()).map((s) => ({ ...s, running: running.has(s.id), progress: progress.get(s.id) || null }));
  const profiles = monitorProfiles();
  const challenges = [];
  for (const profile of new Set(sites.filter((s) => s.running && s.profile !== NO_LOGIN).map((s) => s.profile))) {
    const challenge = (await getLoginSettings(loginKey(profile)).catch(() => null))?.challenge;
    if (challenge) challenges.push({ ...challenge, profile });
  }
  return { profiles, sites, challenge: challenges[0] || null };
}

export async function addSite({ url, profile = NO_LOGIN }) {
  const href = normalizeUrl(url);
  checkProfile(profile);
  const site = { id: crypto.randomUUID(), url: href, profile, addedAt: new Date().toISOString(), lastRun: null };
  await updateSites((sites) => {
    if (sites.some((s) => s.url === href && s.profile === profile)) throw httpError(409, 'This URL is already monitored with these credentials.');
    return [...sites, site];
  });
  runSite(site.id);
  return site;
}

export async function removeSite(id) {
  await updateSites((sites) => sites.filter((s) => s.id !== id));
}

/** Starts a check of the site in the background (joins a check already running). */
export function runSite(id) {
  if (!running.has(id)) {
    const run = checkSite(id).finally(() => running.delete(id));
    running.set(id, run);
    run.catch((err) => console.error(`Monitor run failed for ${id}:`, err));
  }
  return running.get(id);
}

export function answerMonitorChallenge(profile, id, value) {
  return answerChallenge(loginKey(profile), id, value);
}

async function checkSite(id) {
  const site = (await readSites()).find((s) => s.id === id);
  if (!site) throw httpError(404, 'This site is no longer monitored.');
  const startedAt = Date.now();
  let lastRun;
  try {
    const storageState = await sessionFor(site);
    lastRun = await crawlSite(site.url, storageState, (p) => progress.set(id, p));
  } catch (err) {
    lastRun = { status: 'failed', message: err.message.split('\n')[0], errors: [] };
  }
  progress.delete(id);
  lastRun = { ...lastRun, at: new Date().toISOString(), durationMs: Date.now() - startedAt };
  await updateSites((sites) => sites.map((s) => (s.id === id ? { ...s, lastRun } : s)));
}

/** The profile's saved session file, signing in first when there is none or it no longer works. */
async function sessionFor(site) {
  if (site.profile === NO_LOGIN) return undefined;
  checkProfile(site.profile);
  const key = loginKey(site.profile);
  const settings = await getLoginSettings(key);
  const profileId = envProfileId(site.profile);
  if (!settings.enabled || settings.source !== 'env' || (settings.profile || null) !== profileId) {
    await enableEnvLogin(key, { profile: profileId });
  }
  return prepareSession(key, site.url);
}

// Downloaded files worth scanning for keys: the page, scripts, and API / JSON responses.
const SCANNED_TYPES = new Set(['document', 'script', 'xhr', 'fetch']);
const SCANNED_CONTENT = /javascript|ecmascript|json|html|text\/plain/i;
// Start of an API error response kept with the error (masked), e.g. {"message":"Unauthenticated."}.
const ERROR_BODY_CHARS = 400;
const MAX_SOURCE_MAP = 30 * 1024 * 1024;

// ---- Crawl: every same-site page reachable by links from the URL, initial load only ----
const MAX_PAGES = Number(process.env.MONITOR_MAX_PAGES) || 40;
// Pages per route shape (/users/1, /users/2 … count as one shape), so lists of records do not eat the budget.
const PER_ROUTE = 2;
// Read-only: requests with any other method are blocked before they leave the browser, and listed as blocked writes.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Links that look like actions are never opened, even though they are plain GET links.
const ACTION_LINK = /(^|[/_.?&=#-])(log-?out|sign-?out|logoff|delete|destroy|remove|cancel|unsubscribe|deactivate|disable|archive|approve|reject|accept|decline|revoke|reset|confirm|verify|activate|toggle|mark|undo|restore|purge|pay|checkout|export|download)([/_.?&=#-]|$)/i;
const FILE_LINK = /\.(pdf|zip|rar|7z|gz|png|jpe?g|gif|webp|svg|ico|mp4|mov|mp3|wav|csv|xlsx?|docx?|pptx?|txt|json|xml|apk|exe|dmg)$/i;

/** "/users/31333/paths/abc-…uuid" -> "/users/:id/paths/:id": one shape for every record's page. */
function routeShape(u) {
  return u.pathname
    .split('/')
    .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{20,}$/i.test(seg) ? ':id' : seg))
    .join('/')
    .replace(/\/$/, '') || '/';
}

/** Registrable-ish domain of a host (example.com, example.com.ph), to tell the site's own files from third parties'. */
function siteDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
  const twoPartSuffix = parts.at(-1).length === 2 && parts.at(-2).length <= 3; // com.ph, co.uk
  return parts.slice(twoPartSuffix ? -3 : -2).join('.');
}

/** "app.js:12:5 (loadUser)" from a CDP request initiator: the code or HTML that made the request. */
function describeInitiator(initiator) {
  const frame = initiator?.stack?.callFrames?.find((f) => f.url) || initiator?.stack?.parent?.callFrames?.find((f) => f.url);
  if (frame) return { url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1, fn: frame.functionName || null, kind: 'script' };
  if (initiator?.url) return { url: initiator.url, line: initiator.lineNumber != null ? initiator.lineNumber + 1 : null, column: null, fn: null, kind: initiator.type === 'parser' ? 'html' : initiator.type };
  return null;
}

/**
 * Crawls the site from `url`: opens each same-origin page found through links (initial load only: nothing is clicked,
 * typed or submitted, and every POST / PUT / PATCH / DELETE the pages try is blocked), and collects
 *   - network errors: failed requests and HTTP 4xx/5xx responses, with the page and the code that made them;
 *   - keys exposed in the site's own HTML, JS and API responses (masked; mapped to source files via public source maps).
 * `onProgress({ done, total, current })` reports which page is loading.
 */
async function crawlSite(url, storageState, onProgress = () => {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const start = new URL(url);
  const own = siteDomain(start.hostname);
  const isOwn = (u) => {
    try {
      const host = new URL(u).hostname;
      return host === own || host.endsWith(`.${own}`);
    } catch {
      return false;
    }
  };

  const errors = [];
  const seen = new Map();
  const secrets = new Map();
  const blocked = new Map();
  const blockedUrls = new Set();
  const pages = [];
  const initiators = new Map();
  const maps = new Map();
  let current = url;
  let stoppedReason = null;

  const add = (entry) => {
    const id = `${entry.type}|${entry.status || ''}|${entry.message}|${entry.url || ''}`;
    const existing = seen.get(id);
    if (existing) {
      existing.count++;
      if (entry.page && !existing.pages.includes(entry.page) && existing.pages.length < 10) existing.pages.push(entry.page);
      return existing;
    }
    if (errors.length >= MAX_ERRORS) return null;
    const item = { ...entry, message: String(entry.message || '').slice(0, 2000), count: 1, pages: entry.page ? [entry.page] : [] };
    seen.set(id, item);
    errors.push(item);
    return item;
  };

  try {
    const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
    // Read-only: block every write before it leaves the browser.
    await context.route('**/*', (route) => {
      const request = route.request();
      if (READ_METHODS.has(request.method())) return route.continue();
      blockedUrls.add(`${request.method()} ${request.url()}`);
      const shape = (() => {
        try {
          const u = new URL(request.url());
          return `${request.method()} ${u.origin}${routeShape(u)}`;
        } catch {
          return `${request.method()} ${request.url()}`;
        }
      })();
      const entry = blocked.get(shape) || { method: request.method(), url: request.url(), resource: request.resourceType(), pages: [], count: 0 };
      entry.count++;
      if (!entry.pages.includes(current) && entry.pages.length < 10) entry.pages.push(current);
      blocked.set(shape, entry);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page).catch(() => null);
    if (cdp) {
      await cdp.send('Network.enable').catch(() => {});
      cdp.on('Network.requestWillBeSent', (e) => {
        if (!initiators.has(e.request.url)) initiators.set(e.request.url, describeInitiator(e.initiator));
      });
    }
    const where = (request) => ({ page: current, initiator: initiators.get(request.url()) || null });
    const loadMap = (mapUrl) => {
      if (!maps.has(mapUrl)) {
        maps.set(
          mapUrl,
          (async () => {
            const inline = inlineSourceMap(mapUrl);
            if (inline) return inline;
            const res = await context.request.get(mapUrl, { timeout: 15_000 }).catch(() => null);
            if (!res?.ok()) return null;
            const body = await res.body().catch(() => null);
            return body && body.length <= MAX_SOURCE_MAP ? JSON.parse(body.toString('utf8')) : null;
          })().catch(() => null),
        );
      }
      return maps.get(mapUrl);
    };

    let scans = [];
    page.on('requestfailed', (request) => {
      // Writes this check blocked, and requests the page itself cancelled, are not errors.
      if (blockedUrls.has(`${request.method()} ${request.url()}`)) return;
      const reason = request.failure()?.errorText || 'Request failed';
      if (/ERR_ABORTED|NS_BINDING_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(reason)) return;
      add({ type: 'network', message: reason, url: request.url(), method: request.method(), resource: request.resourceType(), ...where(request) });
    });
    page.on('response', (response) => {
      const request = response.request();
      const pageUrl = current;
      if (response.status() >= 400) {
        const item = add({ type: 'http', status: response.status(), message: response.statusText() || `The server answered ${response.status()}`, url: response.url(), method: request.method(), resource: request.resourceType(), ...where(request) });
        // API errors: keep the start of the answer (masked), it usually says why.
        if (item && !item.body && ['xhr', 'fetch'].includes(request.resourceType())) {
          scans.push(response.text().then((text) => { if (text && !item.body) item.body = redact(text.slice(0, ERROR_BODY_CHARS)); }, () => {}));
        }
        return;
      }
      if (!SCANNED_TYPES.has(request.resourceType()) || !isOwn(response.url())) return;
      if (!SCANNED_CONTENT.test(response.headers()['content-type'] || '') && request.resourceType() !== 'script') return;
      scans.push(
        response.text().then(async (text) => {
          const hits = scanForSecrets(text);
          if (!hits.length) return;
          // Built files: map each key back to the original source file when the site publishes a source map.
          const mapUrl = request.resourceType() === 'script' ? sourceMapUrl(text, response.url(), response.headers()) : null;
          const map = mapUrl ? await loadMap(mapUrl) : null;
          for (const hit of hits) {
            const existing = secrets.get(hit.fingerprint);
            if (existing) {
              if (!existing.files.includes(response.url()) && existing.files.length < 5) existing.files.push(response.url());
              if (!existing.pages.includes(pageUrl) && existing.pages.length < 10) existing.pages.push(pageUrl);
              continue;
            }
            const { fingerprint, ...rest } = hit;
            secrets.set(fingerprint, {
              ...rest,
              column: hit.column + 1,
              url: response.url(),
              files: [response.url()],
              page: pageUrl,
              pages: [pageUrl],
              // document (page HTML), script (JS file), xhr / fetch (API response): decides where to look for it.
              resource: request.resourceType(),
              original: map ? originalPosition(map, hit.line, hit.column) : null,
              sourceMap: mapUrl && !mapUrl.startsWith('data:') ? { url: mapUrl, public: Boolean(map) } : null,
            });
          }
        }, () => {}),
      );
    });

    // Breadth-first over links: the start page, then the pages it links to, and so on.
    const queue = [start.href.replace(/#.*$/, '')];
    const queued = new Set(queue);
    const shapes = new Map();
    let firstStatus = null;
    for (let i = 0; i < queue.length && pages.length < MAX_PAGES; i++) {
      const target = queue[i];
      current = target;
      onProgress({ done: pages.length, total: Math.min(queue.length, MAX_PAGES), current: target });
      const errorsBefore = errors.reduce((n, e) => n + e.count, 0);
      const response = await page.goto(target, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS }).catch((err) => {
        if (/Timeout/i.test(err.message)) {
          add({ type: 'timeout', message: `The page kept loading for over ${PAGE_TIMEOUT_MS / 1000}s (network never went quiet).`, url: target, page: target });
        } else {
          add({ type: 'network', message: err.message.split('\n')[0], url: target, method: 'GET', resource: 'document', page: target });
        }
        return null;
      });
      await page.waitForTimeout(SETTLE_MS);
      await Promise.all(scans);
      scans = [];
      firstStatus ??= response?.status() ?? null;
      const landed = page.url();
      pages.push({ url: target, landed: landed !== target ? landed : undefined, status: response?.status() ?? null, errors: errors.reduce((n, e) => n + e.count, 0) - errorsBefore });

      // Sent back to a sign-in page: the session ended (or the page needs another role); stop rather than check login pages.
      const onLogin = pages.length > 1 && new URL(landed).pathname !== new URL(target).pathname && (await page.locator('input[type=password]:visible').count().catch(() => 0)) > 0;
      if (onLogin) {
        stoppedReason = `Stopped at ${target}: it sent the browser to a sign-in page (${landed}), so the session ended or this account cannot open it.`;
        break;
      }

      // Same-site links on this page (plain <a href> only: nothing is clicked).
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
      for (const href of hrefs) {
        let u;
        try {
          u = new URL(href);
        } catch {
          continue;
        }
        if (u.origin !== start.origin || !/^https?:$/.test(u.protocol)) continue;
        u.hash = '';
        const next = u.href;
        if (queued.has(next) || ACTION_LINK.test(u.pathname + u.search) || FILE_LINK.test(u.pathname)) continue;
        const shape = routeShape(u);
        if ((shapes.get(shape) || 0) >= PER_ROUTE) continue;
        shapes.set(shape, (shapes.get(shape) || 0) + 1);
        queued.add(next);
        queue.push(next);
      }
    }
    if (!stoppedReason && queue.length > MAX_PAGES) stoppedReason = `Checked the first ${MAX_PAGES} pages of ${queue.length} found (limit: MONITOR_MAX_PAGES in .env).`;

    const order = { high: 0, medium: 1, info: 2 };
    const keys = [...secrets.values()].sort((a, b) => order[a.severity] - order[b.severity]);
    return {
      status: errors.length || keys.some((k) => k.severity !== 'info') ? 'errors' : 'ok',
      httpStatus: firstStatus,
      finalUrl: pages[0]?.landed || pages[0]?.url || url,
      errors,
      secrets: keys,
      pages,
      blockedWrites: [...blocked.values()],
      note: stoppedReason,
    };
  } finally {
    await browser.close();
  }
}
