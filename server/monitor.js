// Monitoring: a list of website URLs, each opened in a headless browser (signed in with a chosen .env test-account
// profile, or signed out) to collect network errors (failed requests, HTTP 4xx/5xx) and keys exposed in the site's
// own HTML / JS / JSON (see secretScan.js; values are masked). No AI is involved.
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
import { scanForSecrets } from './secretScan.js';
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
  const sites = (await readSites()).map((s) => ({ ...s, running: running.has(s.id) }));
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
    lastRun = await collectErrors(site.url, await sessionFor(site));
  } catch (err) {
    lastRun = { status: 'failed', message: err.message.split('\n')[0], errors: [] };
  }
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

/** Registrable-ish domain of a host (example.com, example.com.ph), to tell the site's own files from third parties'. */
function siteDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
  const twoPartSuffix = parts.at(-1).length === 2 && parts.at(-2).length <= 3; // com.ph, co.uk
  return parts.slice(twoPartSuffix ? -3 : -2).join('.');
}

/**
 * Opens `url` and collects (1) network errors: failed requests and HTTP 4xx/5xx responses, and (2) keys exposed in
 * the site's own code: secrets found in the HTML, JS and JSON it downloads (third-party files are skipped).
 */
async function collectErrors(url, storageState) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const errors = [];
  const secrets = new Map();
  const seen = new Map();
  const own = siteDomain(new URL(url).hostname);
  const isOwn = (u) => {
    try {
      const host = new URL(u).hostname;
      return host === own || host.endsWith(`.${own}`);
    } catch {
      return false;
    }
  };
  const add = (entry) => {
    const id = `${entry.type}|${entry.status || ''}|${entry.message}|${entry.url || ''}`;
    const existing = seen.get(id);
    if (existing) return void existing.count++;
    if (errors.length >= MAX_ERRORS) return;
    const item = { ...entry, message: String(entry.message || '').slice(0, 2000), count: 1 };
    seen.set(id, item);
    errors.push(item);
  };
  const scans = [];
  try {
    const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText || 'Request failed';
      // Requests the page itself cancelled (navigation, aborted fetches) are not errors.
      if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) return;
      add({ type: 'network', message: reason, url: request.url(), method: request.method(), resource: request.resourceType() });
    });
    page.on('response', (response) => {
      const request = response.request();
      if (response.status() >= 400) {
        add({ type: 'http', status: response.status(), message: response.statusText() || `The server answered ${response.status()}`, url: response.url(), method: request.method(), resource: request.resourceType() });
        return;
      }
      if (!SCANNED_TYPES.has(request.resourceType()) || !isOwn(response.url())) return;
      if (!SCANNED_CONTENT.test(response.headers()['content-type'] || '') && request.resourceType() !== 'script') return;
      scans.push(
        response.text().then((text) => {
          for (const hit of scanForSecrets(text)) {
            const existing = secrets.get(hit.fingerprint);
            if (existing) {
              if (!existing.files.includes(response.url()) && existing.files.length < 5) existing.files.push(response.url());
              continue;
            }
            const { fingerprint, ...rest } = hit;
            secrets.set(fingerprint, { ...rest, url: response.url(), files: [response.url()] });
          }
        }, () => {}),
      );
    });

    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS }).catch(async (err) => {
      if (!/Timeout/i.test(err.message)) throw err;
      add({ type: 'timeout', message: `The page kept loading for over ${PAGE_TIMEOUT_MS / 1000}s (network never went quiet).` });
      return null;
    });
    await page.waitForTimeout(SETTLE_MS);
    await Promise.all(scans);
    const order = { high: 0, medium: 1, info: 2 };
    const keys = [...secrets.values()].sort((a, b) => order[a.severity] - order[b.severity]);
    return {
      status: errors.length || keys.some((k) => k.severity !== 'info') ? 'errors' : 'ok',
      httpStatus: response?.status() ?? null,
      finalUrl: page.url(),
      title: await page.title().catch(() => ''),
      errors,
      secrets: keys,
    };
  } finally {
    await browser.close();
  }
}
