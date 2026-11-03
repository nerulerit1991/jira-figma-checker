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
//                     user switched "Requires login" off (runs then stop turning it on by themselves); never sent to the AI.
//                     "humanCheck": true once sign-in asked the person for an OTP or CAPTCHA (typed in the app).
//   session.json      Playwright storage state (cookies + local storage) after a successful sign-in; reused by runs
//                     while it still gets past the login, replaced by a new sign-in once it does not
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const authDir = (key) => path.join(DATA_DIR, key, '.auth');
const credsFile = (key) => path.join(authDir(key), 'credentials.json');
export const sessionFile = (key) => path.join(authDir(key), 'session.json');
const resultFile = (key) => path.join(authDir(key), 'last-login.json');
// What the page showed when the last sign-in failed, to see why (git-ignored and owner-only like the rest of .auth).
const failureShot = (key) => path.join(authDir(key), 'last-login-failed.png');

const LOGIN_TIMEOUT_MS = 30_000;
const SUBMIT_TEXT = /^(log\s*in|sign\s*in|login|signin|continue|next|submit|enter|confirm|verify)$/i;
const ERROR_TEXT = /invalid|incorrect|wrong|failed|not\s+match|try again|denied|locked|expired/i;
// A redirect to a route named like one of these (a whole path or hash segment) means the page wants a signed-in visitor.
const LOGIN_ROUTE = /(^|[/#?._-])(log-?in|sign-?in|auth|oauth|sso|saml)([/#?._-]|$)/i;
// One-time-code boxes shown after the password: automated sign-in cannot get past them.
const OTP_FIELD = [
  'input[autocomplete="one-time-code"]',
  ...['otp', 'totp', 'mfa', '2fa', 'verification'].flatMap((word) => [`input[name*="${word}" i]`, `input[id*="${word}" i]`]),
].map((selector) => `${selector}:visible`).join(', ');
// Wording of a one-time-code prompt, for code boxes whose name gives nothing away (e.g. six single-digit inputs).
const OTP_TEXT = /\b(otp|one[-\s]?time\s+(pass(word|code)?|code|pin)|verification\s+code|authentication\s+code|security\s+code|2fa|two[-\s]factor|enter\s+the\s+\d[-\s]?digit)\b/i;
// Text boxes for an image CAPTCHA the person reads and types (widget CAPTCHAs such as reCAPTCHA are CAPTCHA below).
const CAPTCHA_INPUT = ['name', 'id', 'placeholder', 'aria-label']
  .map((attr) => `input[${attr}*="captcha" i]:visible`)
  .join(', ');
// How long sign-in waits for the person to type an OTP or CAPTCHA in the app, and how many tries each gets.
const PERSON_WAIT_MS = 5 * 60_000;
const PERSON_TRIES = 3;
// How long, after a submit, sign-in waits for the page to move on to the next screen.
const SETTLE_MS = 10_000;
// Sign-in steps waiting for the person, per ticket: { id, kind: 'otp' | 'captcha', image, message, settle }.
// The UI polls the login settings, shows the input and posts the value back to answerChallenge().
const challenges = new Map();
const CAPTCHA ='iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile';

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
  // humanCheck: sign-in asked the person for an OTP or CAPTCHA; challenge: the step waiting for them right now.
  const session = await fs.stat(sessionFile(key)).catch(() => null);
  const pending = challenges.get(key);
  const challenge = pending ? { id: pending.id, kind: pending.kind, image: pending.image, message: pending.message } : null;
  const shared = { humanCheck: Boolean(creds.humanCheck), sessionSavedAt: session?.mtime.toISOString() ?? null, challenge, last };
  if (creds.source === 'env') {
    const account = envAccount();
    return { enabled: true, source: 'env', auto: Boolean(creds.auto), loginUrl: creds.loginUrl, username: account?.username, hasPassword: Boolean(account), ...shared };
  }
  return { enabled: true, source: 'saved', loginUrl: creds.loginUrl, username: creds.username, hasPassword: Boolean(creds.password), ...shared };
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
  // Whether Enter sent the form (a page load or a fetch/XHR). Only a form that ignored Enter gets its button
  // clicked: clicking after a rejected attempt would send the same wrong password, CAPTCHA or OTP a second time.
  let sent = false;
  const onRequest = (request) => {
    if (request.isNavigationRequest() || ['xhr', 'fetch'].includes(request.resourceType())) sent = true;
  };
  page.on('request', onRequest);
  await field.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  page.off('request', onRequest);
  if (!sent && (await field.isVisible().catch(() => false))) {
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
async function signIn(page, creds, sites, ask) {
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

  // An image CAPTCHA on the login form is read and typed by the person in the app. A wrong one is asked again with
  // the new image; the username and password are filled again too, since sites often clear them after a failure.
  let failure = null;
  for (let attempt = 1; ; attempt++) {
    await password.fill(creds.password);
    const captchaBox = page.locator(CAPTCHA_INPUT).first();
    if (await captchaBox.count()) {
      const value = await ask('captcha', { image: await captchaImage(page, captchaBox), message: failure });
      if (value === null) return { ok: false, message: 'Sign-in stopped: no CAPTCHA was entered.' };
      await captchaBox.fill('');
      await captchaBox.pressSequentially(value, { delay: 40 });
      await submit(page, captchaBox);
    } else {
      await submit(page, password);
    }
    const outcome = await settleAfterSubmit(page, { leaving: 'login' });

    if (outcome === 'otp') return enterOtp(page, ask);
    if (outcome === 'done') return { ok: true, message: 'Signed in' };
    if (await page.locator(CAPTCHA).count()) {
      return { ok: false, message: 'Sign-in failed: the login page has a CAPTCHA widget (e.g. reCAPTCHA), which cannot be answered from the app. Use a test environment without it.' };
    }
    const error = await pageError(page);
    if (!(await page.locator(CAPTCHA_INPUT).count()) || attempt >= PERSON_TRIES) {
      return { ok: false, message: error ? `Sign-in failed: ${error}` : 'Sign-in failed: the login form is still showing. Check the username and password.' };
    }
    failure = error || 'The site did not accept the CAPTCHA. Try again.';
    if (await page.evaluate(markUserField, true)) await page.locator('[data-qa-login-user]').first().fill(creds.username);
  }
}

/**
 * After a submit, waits (up to SETTLE_MS) for the page to show where the sign-in went, instead of looking once:
 * single-page apps often keep the login form on screen for a moment (a loader or transition) before switching to
 * the next screen. Returns 'otp' (a one-time-code screen), 'done' (neither a password box nor a code screen), or
 * 'stuck' (still on the screen being left, `leaving` 'login' or 'otp'; shown an error, or out of time).
 */
async function settleAfterSubmit(page, { leaving }) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  for (const end = Date.now() + SETTLE_MS; ; ) {
    const otp = await otpShowing(page).catch(() => false);
    const password = await page.locator('input[type=password]:visible').count().catch(() => 1);
    if (otp && leaving === 'login') return 'otp';
    if (!otp && !password) return 'done';
    if (Date.now() >= end || (await pageError(page))) return 'stuck';
    await page.waitForTimeout(500);
  }
}

/** The error message the page shows (e.g. "Invalid captcha"), or '' when there is none. */
async function pageError(page) {
  const text = await page
    .locator('[role=alert], .error, .alert, [class*="error"], [class*="invalid"], .text-danger, .invalid-feedback')
    .filter({ hasText: ERROR_TEXT })
    .first()
    .innerText({ timeout: 2000 })
    .catch(() => '');
  return text.trim().replace(/\s+/g, ' ').slice(0, 160);
}

// Runs in the page, on the CAPTCHA text box: marks the CAPTCHA picture (an img/canvas/svg named "captcha", or else
// the nearest one above the box) so it can be photographed. Small icons such as a refresh button are skipped.
function markCaptchaImage(input) {
  const big = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 60 && r.height >= 20;
  };
  const pictures = [...document.querySelectorAll('img, canvas, svg')].filter(big);
  const named = pictures.find((el) => /captcha/i.test([el.getAttribute('src'), el.getAttribute('alt'), el.id, el.getAttribute('class')].join(' ')));
  const top = input.getBoundingClientRect().top;
  const above = pictures
    .filter((el) => el.getBoundingClientRect().bottom <= top + 4)
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  const picture = named || above;
  if (!picture) return false;
  document.querySelectorAll('[data-qa-captcha-img]').forEach((el) => el.removeAttribute('data-qa-captcha-img'));
  picture.setAttribute('data-qa-captcha-img', '1');
  return true;
}

/** A PNG data URL of the CAPTCHA picture; the visible page when the picture cannot be found. */
async function captchaImage(page, captchaBox) {
  const found = await captchaBox.evaluate(markCaptchaImage).catch(() => false);
  const buffer = found
    ? await page.locator('[data-qa-captcha-img]').first().screenshot({ type: 'png' })
    : await page.screenshot({ type: 'png' });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/**
 * On a one-time-code screen: asks the person for the code, types it (into one box, or one digit per box when the
 * site shows a box per digit) and submits. A rejected code is asked again, up to PERSON_TRIES times.
 */
async function enterOtp(page, ask) {
  let message = null;
  for (let attempt = 1; attempt <= PERSON_TRIES; attempt++) {
    const code = await ask('otp', { message });
    if (code === null) return { ok: false, message: 'Sign-in stopped: no OTP was entered.' };
    const named = page.locator(OTP_FIELD);
    const fields = (await named.count())
      ? named
      : page.locator('input:visible:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])');
    const count = await fields.count();
    if (!count) return { ok: false, message: 'Sign-in failed: no box to type the OTP into was found.' };
    if (count > 1 && count >= code.length) {
      for (let i = 0; i < code.length; i++) {
        await fields.nth(i).fill('');
        await fields.nth(i).pressSequentially(code[i]);
      }
    } else {
      await fields.first().fill('');
      await fields.first().pressSequentially(code, { delay: 40 });
    }
    await submit(page, fields.last());
    if ((await settleAfterSubmit(page, { leaving: 'otp' })) === 'done') return { ok: true, message: 'Signed in with OTP' };
    message = (await pageError(page)) || 'The site did not accept the code. Check it and try again.';
  }
  return { ok: false, message: `Sign-in failed: the OTP was not accepted after ${PERSON_TRIES} tries.` };
}

/**
 * Returns ask(kind, { image, message }) for `key`: shows an OTP or CAPTCHA input in the app (through the login
 * settings the UI polls) and resolves with what the person typed, or null when they cancel or after PERSON_WAIT_MS.
 */
function askPerson(key) {
  return (kind, { image = null, message = null } = {}) =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      const settle = (value) => {
        clearTimeout(timer);
        if (challenges.get(key)?.id === id) challenges.delete(key);
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), PERSON_WAIT_MS);
      challenges.set(key, { id, kind, image, message, settle });
    });
}

/** The person's answer to the step `id` waiting on `key`; `value` null cancels the sign-in. */
export function answerChallenge(key, id, value) {
  const pending = challenges.get(key);
  if (!pending || pending.id !== id) {
    throw Object.assign(new Error('This sign-in step is no longer waiting (it finished, timed out or was replaced).'), { status: 409 });
  }
  if (value === null) return pending.settle(null);
  const text = String(value ?? '').trim();
  if (!text) throw Object.assign(new Error(`Enter the ${pending.kind === 'otp' ? 'OTP' : 'CAPTCHA'} first.`), { status: 400 });
  pending.settle(text.slice(0, 64));
}

/** Whether the page asks for a one-time code: a code box, or a visible prompt for one next to any input. */
async function otpShowing(page) {
  if (await page.locator(OTP_FIELD).count()) return true;
  if (!(await page.locator('input:visible').count())) return false;
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return OTP_TEXT.test(text);
}

/**
 * Whether a saved session still gets past the login: opens `url` with it and checks it was not sent back to a
 * login page (same rules as detectLoginWall) and is not asked for a one-time code.
 */
async function sessionWorks(url, file) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: file, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: LOGIN_TIMEOUT_MS }).catch(() => null);
    await page.waitForTimeout(1000);
    if (!response || [401, 403].includes(response.status())) return false;
    if (await otpShowing(page)) return false;
    const from = new URL(url);
    const to = new URL(page.url());
    if (to.origin !== from.origin) return false;
    if (to.pathname === from.pathname && to.hash === from.hash) return true;
    const hasPassword = (await page.locator('input[type=password]:visible').count()) > 0;
    return !(hasPassword || LOGIN_ROUTE.test(to.pathname + to.hash));
  } catch {
    return false;
  } finally {
    await browser.close();
  }
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
  const at = new Date().toISOString();
  const finish = async (result) => {
    const saved = { ...result, at };
    await writePrivate(resultFile(key), saved);
    return saved;
  };
  // Set when the site asked the person for an OTP or CAPTCHA, so the UI can say runs may ask again.
  let asked = false;
  const askThisTicket = askPerson(key);
  const ask = (kind, details) => {
    asked = true;
    return askThisTicket(kind, details);
  };
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const result = await signIn(page, creds, sites, ask);
    if (asked) await writePrivate(credsFile(key), { ...(await readJson(credsFile(key))), humanCheck: true });
    if (!result.ok) {
      const shot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      if (!shot) return finish(result);
      await fs.writeFile(failureShot(key), shot, { mode: 0o600 });
      return finish({ ...result, message: `${result.message} What the page showed: data/${key}/.auth/last-login-failed.png` });
    }
    await fs.rm(failureShot(key), { force: true });

    await writePrivate(sessionFile(key), await context.storageState());
    return finish({ ok: true, message: result.message, landedOn: page.url() });
  } catch (err) {
    return finish({ ok: false, message: `Sign-in failed: ${err.message.split('\n')[0]}` });
  } finally {
    challenges.get(key)?.settle(null);
    await browser?.close();
  }
}

/** Deletes the ticket's saved session; the next run signs in again (asking for an OTP or CAPTCHA if the site does). */
export async function forgetSession(key) {
  await fs.rm(sessionFile(key), { force: true });
  await fs.rm(resultFile(key), { force: true });
  return getLoginSettings(key);
}

/**
 * Before a check, scan or test run of `url`: reuses the saved session while it still gets past the login, and signs
 * in again only when it does not (on sites with an OTP or CAPTCHA, the app asks the person for it). With login never set
 * for the ticket and an .env test account set, first checks whether `url` is behind a login and, if so, turns
 * "Requires login" on (not after the user switched it off). Returns the session file path, or undefined when the
 * ticket has no login. Throws if sign-in fails.
 */
export async function prepareSession(key, url) {
  const result = await oncePerTicket(key, async () => {
    const creds = await readJson(credsFile(key));
    if (creds?.off) return null;
    if (!creds) {
      const loginUrl = url && envAccount() ? await detectLoginWall(url) : null;
      if (!loginUrl) return null;
      await enableEnvLogin(key, { loginUrl, auto: true });
    } else if (url && (await fs.stat(sessionFile(key)).catch(() => null)) && (await sessionWorks(url, sessionFile(key)))) {
      return { ok: true, reused: true };
    }
    return signInAndSave(key, url);
  });
  if (!result) return undefined;
  if (!result.ok) throw Object.assign(new Error(`${result.message} ("Requires login" under Page URL in card 01.)`), { status: 400 });
  return sessionFile(key);
}
