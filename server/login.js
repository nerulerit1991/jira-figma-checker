// Optional sign-in for pages behind a login, per ticket. Works on most username/email + password forms
// without per-site setup: it finds the password box, the username/email box before it, and submits.
//
// Two kinds of login:
//   - .env test account ("Requires login" under Page URL in card 01): PROJECT_USERNAME_EMAIL + PROJECT_PASSWORD, signing in at
//     PROJECT_LOGIN_URL or wherever the page under test sends a signed-out visitor. Turned on automatically when a
//     run finds the page redirects to a login form (see prepareSession).
//   - a saved account per ticket (PUT /login with loginUrl, username, password).
// The password is only ever typed on the site under test (or PROJECT_LOGIN_URL's site), never on a page another
// site redirects to.
//
// Stored in data/<KEY>/.auth/ (git-ignored, owner-only file permissions, deleted with the ticket):
//   credentials.json  { loginUrl, username, password }, { source: 'env', loginUrl, auto }, or { off: true } when the
//                     user switched "Requires login" off (runs then stop turning it on by themselves); never sent to the AI
//   session.json      Playwright storage state (cookies + local storage) after a successful sign-in
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const authDir = (key) => path.join(DATA_DIR, key, '.auth');
const credsFile = (key) => path.join(authDir(key), 'credentials.json');
export const sessionFile = (key) => path.join(authDir(key), 'session.json');
const resultFile = (key) => path.join(authDir(key), 'last-login.json');

const LOGIN_TIMEOUT_MS = 30_000;
const SUBMIT_TEXT = /^(log\s*in|sign\s*in|login|signin|continue|next|submit|enter)$/i;
const ERROR_TEXT = /invalid|incorrect|wrong|failed|not\s+match|try again|denied|locked/i;
// A redirect to a route named like one of these (a whole path or hash segment) means the page wants a signed-in visitor.
const LOGIN_ROUTE = /(^|[/#?._-])(log-?in|sign-?in|auth|oauth|sso|saml)([/#?._-]|$)/i;
// One-time-code boxes shown after the password: automated sign-in cannot get past them.
const OTP_FIELD = [
  'input[autocomplete="one-time-code"]',
  ...['otp', 'totp', 'mfa', '2fa', 'verification'].flatMap((word) => [`input[name*="${word}" i]`, `input[id*="${word}" i]`]),
].map((selector) => `${selector}:visible`).join(', ');
const CAPTCHA = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile';

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// Written to a temporary file and renamed, so a parallel reader never sees half a file.
async function writePrivate(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The .env test account, or null when PROJECT_USERNAME_EMAIL / PROJECT_PASSWORD are not both set. */
function envAccount() {
  const username = process.env.PROJECT_USERNAME_EMAIL?.trim();
  const password = process.env.PROJECT_PASSWORD;
  return username && password ? { username, password } : null;
}

/** The ticket's login with the .env account filled in. Throws when it uses .env and .env has no account. */
async function readCreds(key) {
  const creds = await readJson(credsFile(key));
  if (creds?.off) return null;
  if (creds?.source !== 'env') return creds;
  const account = envAccount();
  if (!account) {
    throw Object.assign(new Error('"Requires login" is on, but PROJECT_USERNAME_EMAIL and PROJECT_PASSWORD are not set in .env. Add them and restart the server.'), { status: 400 });
  }
  return { ...creds, ...account };
}

/** Login settings for the UI: never includes the password. */
export async function getLoginSettings(key) {
  const creds = await readJson(credsFile(key));
  const last = await readJson(resultFile(key));
  if (!creds || creds.off) return { enabled: false, off: Boolean(creds?.off), last: null };
  if (creds.source === 'env') {
    const account = envAccount();
    return { enabled: true, source: 'env', auto: Boolean(creds.auto), loginUrl: creds.loginUrl, username: account?.username, hasPassword: Boolean(account), last };
  }
  return { enabled: true, source: 'saved', loginUrl: creds.loginUrl, username: creds.username, hasPassword: Boolean(creds.password), last };
}

/**
 * Turns on login with the .env test account. `loginUrl` is where to sign in; without it, sign-in starts at
 * PROJECT_LOGIN_URL or the page under test. `auto` marks a login turned on by a run, not by the user.
 */
export async function enableEnvLogin(key, { loginUrl = null, auto = false } = {}) {
  await writePrivate(credsFile(key), { source: 'env', loginUrl, auto });
  await fs.rm(sessionFile(key), { force: true });
  await fs.rm(resultFile(key), { force: true });
  return getLoginSettings(key);
}

/** Saves the login page, username and (optionally) a new password; an empty password keeps the saved one. */
export async function saveLoginSettings(key, { loginUrl, username, password }) {
  let url;
  try {
    url = new URL(String(loginUrl || '').trim());
  } catch {
    throw Object.assign(new Error('Enter the full login page URL, e.g. https://staging.example.com/login.'), { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('The login page must be an http(s) URL.'), { status: 400 });
  const name = String(username || '').trim();
  if (!name) throw Object.assign(new Error('Enter the username or email of the test account.'), { status: 400 });
  const previous = await readJson(credsFile(key));
  const pass = password ? String(password) : previous?.password;
  if (!pass) throw Object.assign(new Error('Enter the password of the test account.'), { status: 400 });
  await writePrivate(credsFile(key), { loginUrl: url.href, username: name, password: pass });
  await fs.rm(sessionFile(key), { force: true });
  return getLoginSettings(key);
}

/** Switches login off and forgets the account and session; runs no longer turn it back on by themselves. */
export async function removeLoginSettings(key) {
  await fs.rm(authDir(key), { recursive: true, force: true });
  await writePrivate(credsFile(key), { off: true });
}

// Runs in the page: the visible username/email box that comes before the password box (or the first one when
// there is no password box yet, for two-step logins). Marks it so Playwright can fill it.
function markUserField(passwordPresent) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly;
  };
  const textual = (el) => ['', 'text', 'email', 'tel'].includes((el.getAttribute('type') || '').toLowerCase());
  const pw = [...document.querySelectorAll('input[type=password]')].find(visible) || null;
  const scope = pw?.form || pw?.closest('form') || document;
  let inputs = [...scope.querySelectorAll('input')].filter((el) => textual(el) && visible(el));
  if (passwordPresent && pw) inputs = inputs.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  const hint = (el) => [el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label')].join(' ');
  const scored = inputs.map((el, i) => ({ el, score: (/user|email|e-mail|login|account|mail/i.test(hint(el)) ? 2 : 0) + i / 1000 }));
  scored.sort((a, b) => b.score - a.score);
  const field = passwordPresent ? scored[0]?.el : inputs[0];
  if (!field) return false;
  field.setAttribute('data-qa-login-user', '1');
  return true;
}

async function submit(page, field) {
  await field.press('Enter');
  // Some forms ignore Enter; click their sign-in button if the page has not moved on.
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  if (await field.isVisible().catch(() => false)) {
    const button = page.locator('button, input[type=submit], [role=button]').filter({ hasText: SUBMIT_TEXT }).first();
    const submitInput = page.locator('form input[type=submit], form button[type=submit]').first();
    const target = (await button.count()) ? button : submitInput;
    if (await target.count()) await target.click({ timeout: 3000 }).catch(() => {});
  }
}

/**
 * Fills and submits the login form at creds.loginUrl in `page`. Returns { ok, message }.
 * Nothing is typed unless the page is on one of `sites` (origins), so a redirect to another site never gets the password.
 */
async function signIn(page, creds, sites) {
  await page.goto(creds.loginUrl, { waitUntil: 'networkidle', timeout: LOGIN_TIMEOUT_MS }).catch(() => page.waitForLoadState('load'));
  const offSite = () => {
    const origin = originOf(page.url());
    return sites.has(origin)
      ? null
      : { ok: false, message: `The sign-in page is on another site (${origin}), so the password was not entered. If that is your test site's sign-in, set PROJECT_LOGIN_URL to it.` };
  };

  const password = page.locator('input[type=password]:visible').first();
  let hasPassword = await password.waitFor({ timeout: 5000 }).then(() => true, () => false);

  // Two-step logins: username/email first, then the password on the next screen.
  if (!hasPassword) {
    if (!(await page.evaluate(markUserField, false))) {
      return offSite() || { ok: false, message: 'No sign-in form found on the login page. Check the login page URL.' };
    }
    const user = page.locator('[data-qa-login-user]');
    const blocked = offSite();
    if (blocked) return blocked;
    await user.fill(creds.username);
    await submit(page, user);
    hasPassword = await password.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!hasPassword) return offSite() || { ok: false, message: 'Entered the username, but no password box appeared.' };
  } else if (await page.evaluate(markUserField, true)) {
    const blocked = offSite();
    if (blocked) return blocked;
    await page.locator('[data-qa-login-user]').fill(creds.username);
  }

  const blocked = offSite();
  if (blocked) return blocked;
  await password.fill(creds.password);
  await submit(page, password);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // Still showing a password box means the sign-in did not go through.
  if (await page.locator('input[type=password]:visible').count()) {
    if (await page.locator(CAPTCHA).count()) {
      return { ok: false, message: 'Sign-in failed: the login page has a CAPTCHA, which automated sign-in cannot pass. Use a test environment without it.' };
    }
    const error = await page
      .locator('[role=alert], .error, .alert, [class*="error"], [class*="invalid"]')
      .filter({ hasText: ERROR_TEXT })
      .first()
      .innerText()
      .catch(() => '');
    return { ok: false, message: error ? `Sign-in failed: ${error.trim().slice(0, 160)}` : 'Sign-in failed: the login form is still showing. Check the username and password.' };
  }
  if (await page.locator(OTP_FIELD).count()) {
    return { ok: false, message: 'Sign-in stopped at a one-time code (MFA) screen, which automated sign-in cannot pass. Use a test account without MFA.' };
  }
  return { ok: true, message: 'Signed in' };
}

/**
 * Opens `url` signed out. Returns the login page it ends up on when it is behind a login, otherwise null:
 *   - redirected, on the same site (or PROJECT_LOGIN_URL's), to a password form or a login-named route (path or #hash);
 *   - answered 401/403: PROJECT_LOGIN_URL, when set (there is no login page to find otherwise).
 * A page that is itself a login form, with no redirect, is the page under test and does not count.
 */
export async function detectLoginWall(url) {
  const envLoginUrl = process.env.PROJECT_LOGIN_URL?.trim() || null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: LOGIN_TIMEOUT_MS }).catch(() => null);
    // Client-side redirects (single-page apps) can land a moment after the network goes quiet.
    await page.waitForTimeout(1000);
    if ([401, 403].includes(response?.status())) return envLoginUrl;
    const from = new URL(url);
    const to = new URL(page.url());
    if (to.origin !== from.origin && to.origin !== originOf(envLoginUrl)) return null;
    if (to.origin === from.origin && to.pathname === from.pathname && to.hash === from.hash) return null;
    const hasPassword = (await page.locator('input[type=password]:visible').count()) > 0;
    return hasPassword || LOGIN_ROUTE.test(to.pathname + to.hash) ? to.href : null;
  } finally {
    await browser.close();
  }
}

// One sign-in at a time per ticket: parallel jobs (check, tests, login test) share it instead of racing on session.json.
const signingIn = new Map();
function oncePerTicket(key, fn) {
  if (!signingIn.has(key)) signingIn.set(key, fn().finally(() => signingIn.delete(key)));
  return signingIn.get(key);
}

/**
 * Signs in with the ticket's test account and saves the session. Returns { ok, message, at, landedOn }.
 * `pageUrl` (the page under test) is where an .env login starts when no login page is known.
 * Throws only when nothing is configured.
 */
export function performLogin(key, pageUrl) {
  return oncePerTicket(key, () => signInAndSave(key, pageUrl));
}

async function signInAndSave(key, pageUrl) {
  const saved = await readCreds(key);
  if (!saved) throw Object.assign(new Error('No login is set up for this ticket.'), { status: 400 });
  const envLoginUrl = saved.source === 'env' ? process.env.PROJECT_LOGIN_URL?.trim() : null;
  const creds = { ...saved, loginUrl: saved.loginUrl || envLoginUrl || pageUrl };
  if (!creds.loginUrl) throw Object.assign(new Error('Enter the page URL first: sign-in starts there.'), { status: 400 });
  // Sites the password may be typed on: the page under test, the login page and PROJECT_LOGIN_URL.
  const sites = new Set([pageUrl, creds.loginUrl, envLoginUrl].map(originOf).filter(Boolean));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const at = new Date().toISOString();
  const finish = async (result) => {
    const saved = { ...result, at };
    await writePrivate(resultFile(key), saved);
    return saved;
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const result = await signIn(page, creds, sites);
    if (!result.ok) return finish(result);

    await writePrivate(sessionFile(key), await context.storageState());
    return finish({ ok: true, message: 'Signed in', landedOn: page.url() });
  } catch (err) {
    return finish({ ok: false, message: `Sign-in failed: ${err.message.split('\n')[0]}` });
  } finally {
    await browser.close();
  }
}

/**
 * Before a check, scan or test run of `url`: signs in fresh when a login is set up (sessions expire, and signing in
 * takes only a few seconds). With login never set for the ticket and an .env test account set, first checks whether
 * `url` is behind a login and, if so, turns "Requires login" on (not after the user switched it off). Returns the session
 * file path, or undefined when the ticket has no login. Throws if sign-in fails.
 */
export async function prepareSession(key, url) {
  const result = await oncePerTicket(key, async () => {
    const creds = await readJson(credsFile(key));
    if (creds?.off) return null;
    if (!creds) {
      const loginUrl = url && envAccount() ? await detectLoginWall(url) : null;
      if (!loginUrl) return null;
      await enableEnvLogin(key, { loginUrl, auto: true });
    }
    return signInAndSave(key, url);
  });
  if (!result) return undefined;
  if (!result.ok) throw Object.assign(new Error(`${result.message} ("Requires login" under Page URL in card 01.)`), { status: 400 });
  return sessionFile(key);
}
