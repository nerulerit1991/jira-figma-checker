// Each check opens the ticket's page URL (baseURL = TEST_BASE_URL), not the site root.
import { test, expect } from '@playwright/test';

// Empties only the list response that fills the table, in the browser only (route.fulfill): the server and its data are
// never touched. Every other request (permissions, filters, and any write) passes on unchanged, as on a normal load.
const emptyLists = (value) => {
  if (Array.isArray(value)) return [];
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, typeof v === 'number' && /^(total|count|total_?count|total_?items|total_?records|records_?total|records_?filtered)$/i.test(k) ? 0 : emptyLists(v)]));
};

/** Lengths of every array of records (objects) inside a JSON body. */
const recordListLengths = (value, out = []) => {
  if (Array.isArray(value)) {
    if (value.length && value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) out.push(value.length);
    value.forEach((v) => recordListLengths(v, out));
  } else if (value && typeof value === 'object') Object.values(value).forEach((v) => recordListLengths(v, out));
  return out;
};

// Default checks below skip ("Not applicable") when the page has nothing they apply to. None of them sends a write to the server.

/** Blocks every write so default checks can click and type without changing data. */
const blockWrites = (page) => page.route('**/*', (route) =>
  ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method().toUpperCase())
    ? route.fulfill({ status: 503, body: 'Blocked by the global test to prevent real writes.' })
    : route.continue());

const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {}); };

/** Collects the page's same-site API (fetch/xhr) traffic during a load. */
async function collectApi(page, baseURL) {
  const site = (url) => new URL(url).hostname.split('.').slice(-2).join('.');
  const api = { calls: [], failed: [], slow: [], bodies: [] };
  const started = new Map();
  page.on('request', (r) => { if (['fetch', 'xhr'].includes(r.resourceType())) started.set(r, Date.now()); });
  page.on('requestfailed', (r) => { if (started.has(r)) api.failed.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`); });
  page.on('response', (res) => {
    const r = res.request();
    if (!started.has(r)) return;
    api.calls.push(`${r.method()} ${res.url()}`);
    if (Date.now() - started.get(r) > 10_000) api.slow.push(res.url());
    if (res.status() >= 400) api.failed.push(`${res.status()} ${r.method()} ${res.url()}`);
    if (site(res.url()) === site(baseURL) && (res.headers()['content-type'] || '').includes('json')) {
      api.bodies.push(res.json().then((body) => ({ url: res.url(), body })).catch(() => ({ url: res.url(), invalid: true })));
    }
  });
  await page.goto(baseURL);
  await settle(page);
  api.bodies = await Promise.all(api.bodies);
  return api;
}

// Failure-state helpers: responses are changed in the browser only (route.fulfill); the server is never touched.

const sameSite = (a, b) => new URL(a).hostname.split('.').slice(-2).join('.') === new URL(b).hostname.split('.').slice(-2).join('.');
const isApiGet = (request, pageUrl) => ['fetch', 'xhr'].includes(request.resourceType()) && request.method() === 'GET' && sameSite(request.url(), pageUrl);
const loadersSel = '[aria-busy="true"]:visible, [role="progressbar"]:visible, .spinner:visible, .loading:visible, .skeleton:visible';
const errorText = /error|went wrong|failed|unable to|could ?n.?t (load|fetch|retrieve)|try again|retry|unavailable/i;
const loginSignal = /log ?in|sign ?in|session (has )?expired|unauthori[sz]ed|not authori[sz]ed|access denied/i;

/** Lists the same-site API GETs the page makes on a normal load. */
async function apiGetsOnLoad(page, baseURL) {
  const gets = new Set();
  page.on('request', (r) => { if (isApiGet(r, baseURL)) gets.add(r.url()); });
  await page.goto(baseURL);
  await settle(page);
  return gets;
}

// ---- Default checks, sorted by area: load & assets, API & session, navigation & accessibility, layout, forms, lists.

test('[G01] page loads without browser or first-party request errors', async ({ page, baseURL }) => {
  const pageErrors = [];
  const badResponses = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    try {
      if (new URL(response.url()).origin === new URL(page.url()).origin && response.status() >= 400) {
        badResponses.push(`${response.status()} ${response.url()}`);
      }
    } catch { /* Ignore non-HTTP responses. */ }
  });
  const response = await page.goto(baseURL);
  expect(response?.status() ?? 0).toBeLessThan(400);
  expect(pageErrors).toEqual([]);
  expect(badResponses).toEqual([]);
});

test('[G02] JS, CSS, font and image assets load', async ({ page, baseURL }) => {
  const failed = [];
  const kinds = ['script', 'stylesheet', 'font', 'image'];
  page.on('requestfailed', (r) => { if (kinds.includes(r.resourceType()) && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) failed.push(`${r.resourceType()} ${r.url()}`); });
  page.on('response', (res) => { if (kinds.includes(res.request().resourceType()) && res.status() >= 400) failed.push(`${res.status()} ${res.request().resourceType()} ${res.url()}`); });
  await page.goto(baseURL);
  await settle(page);
  const broken = await page.locator('img').evaluateAll((imgs) => imgs
    .filter((img) => img.checkVisibility?.() && img.complete && img.currentSrc && img.naturalWidth === 0).map((img) => `broken image ${img.currentSrc}`));
  expect([...failed, ...broken], 'assets failed to load').toEqual([]);
});

test('[G03] third-party scripts load without errors', async ({ page, baseURL }) => {
  const site = (url) => new URL(url).hostname.split('.').slice(-2).join('.');
  const thirdParty = [];
  const failed = [];
  page.on('request', (r) => { try { if (r.resourceType() === 'script' && site(r.url()) !== site(baseURL)) thirdParty.push(r.url()); } catch { /* non-HTTP */ } });
  page.on('requestfailed', (r) => { if (thirdParty.includes(r.url())) failed.push(`${r.url()} — ${r.failure()?.errorText}`); });
  page.on('response', (res) => { if (thirdParty.includes(res.url()) && res.status() >= 400) failed.push(`${res.status()} ${res.url()}`); });
  const errors = [];
  page.on('pageerror', (e) => { if (thirdParty.some((u) => (e.stack || '').includes(new URL(u).hostname))) errors.push(e.message); });
  await page.goto(baseURL);
  await settle(page);
  test.skip(!thirdParty.length, 'Not applicable: no third-party scripts or plugins on this page');
  expect(failed, 'third-party scripts failed to load').toEqual([]);
  expect(errors, 'third-party scripts threw errors').toEqual([]);
});

test('[G04] API requests succeed, are fast and are not duplicated', async ({ page, baseURL }) => {
  const consoleCors = [];
  page.on('console', (m) => { if (m.type() === 'error' && /CORS|Access-Control-Allow-Origin/i.test(m.text())) consoleCors.push(m.text().slice(0, 160)); });
  const api = await collectApi(page, baseURL);
  test.skip(!api.calls.length && !api.failed.length, 'Not applicable: the page makes no API requests');
  expect(api.failed, 'API requests failed (error status, network or CORS failure)').toEqual([]);
  expect(consoleCors, 'CORS errors').toEqual([]);
  expect(api.slow, 'API requests took over 10s (timeout risk)').toEqual([]);
  const counts = api.calls.filter((c) => c.startsWith('GET ')).reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
  expect([...counts].filter(([, n]) => n > 1).map(([c, n]) => `${c} ×${n}`), 'the same request was sent more than once on load').toEqual([]);
});

test('[G05] API responses are valid JSON with correct data types', async ({ page, baseURL }) => {
  const api = await collectApi(page, baseURL);
  test.skip(!api.bodies.length, 'Not applicable: the page loads no JSON API data');
  expect(api.bodies.filter((b) => b.invalid).map((b) => b.url), 'responses labeled JSON must parse as JSON').toEqual([]);
  // Numeric fields sent as strings ("total": "12") and null/empty values in fields that identify a record.
  const wrongTypes = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.slice(0, 20).forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (/^(id|count|total|.*_?count|.*_?total|amount|price|qty|quantity|page|per_?page|page_?size|limit|offset)$/i.test(k) && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) wrongTypes.push(`${path}.${k} = "${v}" (number sent as string)`);
      if (/^(id|uuid)$/i.test(k) && (v === null || v === '')) wrongTypes.push(`${path}.${k} is ${JSON.stringify(v)}`);
      walk(v, `${path}.${k}`);
    }
  };
  for (const b of api.bodies.filter((x) => !x.invalid)) walk(b.body, new URL(b.url).pathname);
  expect(wrongTypes.slice(0, 10), 'API fields have unexpected types or null identifiers').toEqual([]);
});

test('[G06] API errors and slow responses show a clear state', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const gets = await apiGetsOnLoad(page, baseURL);
  test.skip(!gets.size, 'Not applicable: the page loads no data from an API');

  // 1) Slow API: while data is delayed, the user should see a loading indicator, not a blank or frozen page.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/*', async (route) => {
    const r = route.request();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) return route.fulfill({ status: 503, body: 'Blocked by the global test.' });
    if (!isApiGet(r, baseURL)) return route.continue();
    await new Promise((res) => setTimeout(res, 5_000));
    return route.continue().catch(() => {});
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => (await page.locator(loadersSel).count()) + (await page.getByText(/loading|please wait/i).locator('visible=true').count()),
      { message: 'a loading indicator should show while API data is slow', timeout: 4_000 })
    .toBeGreaterThan(0);
  await settle(page);

  // 2) API error: a 500 on the data requests should show an error message, not crash, hang or leave a blank page.
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  let failed = 0;
  await page.route('**/*', (route) => {
    const r = route.request();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) return route.fulfill({ status: 503, body: 'Blocked by the global test.' });
    if (!isApiGet(r, baseURL)) return route.continue();
    failed++;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Simulated server error (global test)' }) });
  });
  await page.reload();
  await settle(page);
  expect(failed, 'the data requests were replaced with a 500 error').toBeGreaterThan(0);
  expect(pageErrors, 'a failed API request should not cause uncaught JavaScript errors').toEqual([]);
  await expect.poll(() => page.locator(loadersSel).count(), { message: 'loading indicators should stop after an API error', timeout: 10_000 }).toBe(0);
  await expect
    .poll(() => page.getByText(errorText).locator('visible=true').count()
      .then(async (n) => n + await page.locator('[role="alert"]:visible, .toast:visible, .error:visible').count()),
      { message: 'an API error should show a message to the user (e.g. "Something went wrong, try again")', timeout: 10_000 })
    .toBeGreaterThan(0);
});

test('[G07] protected pages require a session and handle an expired one', async ({ page, browser, baseURL }) => {
  // Applies only to logged-in runs (STORAGE_STATE set). Public pages run without one and skip.
  test.skip(!process.env.STORAGE_STATE, 'Not applicable: this page runs without a login session');
  const gets = await apiGetsOnLoad(page, baseURL);

  // 1) No session: the page must not show protected content — it should redirect to login or deny access.
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const p = await anon.newPage();
    const leaked = [];
    p.on('response', async (r) => {
      if (!isApiGet(r.request(), baseURL) || r.status() >= 300) return;
      const body = await r.json().catch(() => undefined);
      if (body !== undefined && recordListLengths(body).some((n) => n > 0)) leaked.push(r.url());
    });
    const res = await p.goto(baseURL);
    await settle(p);
    const redirected = new URL(p.url()).pathname !== new URL(baseURL).pathname;
    const deniedStatus = [401, 403].includes(res?.status() ?? 0);
    const loginShown = (await p.locator('input[type="password"]:visible').count()) > 0
      || (await p.getByText(loginSignal).locator('visible=true').count()) > 0;
    expect(leaked, 'without a session, APIs should not return records').toEqual([]);
    expect(redirected || deniedStatus || loginShown, 'without a session, the page should redirect to login or deny access').toBe(true);
  } finally {
    await anon.close();
  }

  // 2) Expired session: when the API answers 401, the page should send the user to login or say the session expired.
  test.skip(!gets.size, 'Expired-session part not applicable: the page loads no data from an API');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/*', (route) => {
    const r = route.request();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method())) return route.fulfill({ status: 503, body: 'Blocked by the global test.' });
    if (!isApiGet(r, baseURL)) return route.continue();
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthenticated.' }) });
  });
  await page.reload();
  await settle(page);
  expect(pageErrors, 'an expired session should not cause uncaught JavaScript errors').toEqual([]);
  await expect
    .poll(async () => new URL(page.url()).pathname !== new URL(baseURL).pathname
      || (await page.locator('input[type="password"]:visible').count()) > 0
      || (await page.getByText(loginSignal).locator('visible=true').count()) > 0,
      { message: 'an expired session (401) should redirect to login or show a session-expired message', timeout: 10_000 })
    .toBe(true);
});

test('[G08] shared navigation links have working destinations', async ({ page, request, baseURL }) => {
  await page.goto(baseURL);
  const links = page.locator('nav a:visible, header a:visible');
  const hrefs = await links.evaluateAll((items) => items.map((item) => item.getAttribute('href')).filter(Boolean));
  const origin = new URL(page.url()).origin;
  for (const href of hrefs) {
    const destination = new URL(href, page.url());
    if (destination.origin !== origin || destination.hash && destination.pathname === new URL(page.url()).pathname) continue;
    const response = await request.get(destination.toString());
    expect(response.status(), `navigation destination ${destination}`).toBeLessThan(400);
  }
});

test('[G09] visible links and controls have names and keyboard access', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const links = page.locator('a:visible');
  for (let i = 0; i < await links.count(); i++) {
    expect((await links.nth(i).getAttribute('href'))?.trim(), `link ${i + 1} needs a destination`).toBeTruthy();
  }
  const controls = page.locator('button:visible, [role="button"]:visible, input:not([type="hidden"]):visible, select:visible, textarea:visible');
  for (let i = 0; i < await controls.count(); i++) {
    await expect(controls.nth(i), `control ${i + 1} needs an accessible name`).toHaveAccessibleName(/\S/);
  }
  if (await links.count() + await controls.count()) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  }
});

test('[G10] semantic elements and heading hierarchy', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  await settle(page);
  // A clickable div/span with no role, tabindex or native control inside cannot be reached or used by keyboard.
  const fakeButtons = await page.evaluate(() => [...document.querySelectorAll('div, span, li, img, i, svg')].filter((el) => {
    if (!el.checkVisibility?.() || el.closest('a, button, label, summary, [role], [tabindex]')) return false;
    if (el.querySelector('a, button, input, select, textarea, [role="button"], [tabindex]')) return false;
    return el.hasAttribute('onclick') || getComputedStyle(el).cursor === 'pointer';
  }).slice(0, 5).map((el) => `<${el.tagName.toLowerCase()} class="${el.className?.baseVal ?? el.className}"> ${el.textContent.trim().slice(0, 40)}`));
  expect(fakeButtons, 'clickable elements should be <button>/<a> (or have role and tabindex)').toEqual([]);
  const h1 = await page.locator('h1:visible').count();
  expect(h1, 'the page should have exactly one visible <h1>').toBe(1);
  const first = await page.locator('h1:visible, h2:visible, h3:visible, h4:visible, h5:visible, h6:visible').first().evaluate((el) => el.tagName).catch(() => null);
  expect(first, 'the first heading should be the <h1>').toBe('H1');
});

test('[G11] images and headings meet basic accessibility checks', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const missingAlt = await page.locator('img:not([alt]):not([aria-hidden="true"])').count();
  expect(missingAlt, 'images need an alt attribute or must be marked decorative').toBe(0);
  const levels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((items) => items.map((item) => Number(item.tagName.slice(1))));
  for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], 'heading levels should not skip').toBeLessThanOrEqual(1);
});

test('[G12] keyboard focus is visible and dialogs close with Escape', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  await settle(page);
  const focusables = page.locator('a[href]:visible, button:visible:enabled, input:not([type="hidden"]):visible:enabled, select:visible:enabled, textarea:visible:enabled, [tabindex]:not([tabindex="-1"]):visible');
  test.skip(!(await focusables.count()), 'Not applicable: no focusable controls on this page');
  const unstyled = [];
  for (let i = 0; i < Math.min(10, await focusables.count()); i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
      return { ring, name: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}` };
    });
    if (info && !info.ring) unstyled.push(info.name);
  }
  expect(unstyled, 'keyboard focus needs a visible indicator (outline or box-shadow)').toEqual([]);
  const dialog = page.locator('dialog[open], [role="dialog"]:visible, [aria-modal="true"]:visible').first();
  if (await dialog.count()) {
    await page.keyboard.press('Escape');
    await expect(dialog, 'an open dialog should close with Escape').toBeHidden();
  }
});

test('[G13] page has no horizontal overflow at common viewport sizes', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `page overflows at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test('[G14] text is not cut off and expected UI renders', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  await settle(page);
  // Clipped text with no ellipsis: overflow hidden/clip on a text element whose content is wider or taller than its box.
  const clipped = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
    if (!el.checkVisibility?.() || !el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis' || parseInt(s.webkitLineClamp, 10) > 0) return false;
    const hidesX = /hidden|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const hidesY = /hidden|clip/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
    return hidesX || hidesY;
  }).slice(0, 5).map((el) => el.textContent.trim().slice(0, 50)));
  expect(clipped, 'text should not be cut off without an ellipsis').toEqual([]);
  const text = await page.locator('body').innerText();
  expect(text.trim().length, 'the page should render visible content').toBeGreaterThan(0);
  expect(text.match(/\{\{.*?\}\}|\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/g) ?? [], 'unrendered values or template tags show on the page').toEqual([]);
  // Loading indicators must go away once the page has loaded.
  const loaders = page.locator('[aria-busy="true"]:visible, [role="progressbar"]:visible, .spinner:visible, .loading:visible, .skeleton:visible');
  await expect.poll(() => loaders.count(), { message: 'loading indicators should disappear after load', timeout: 10_000 }).toBe(0);
});

test('[G15] required form fields validate without submitting data', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const invalidEmptyFields = await page.locator('input[required], select[required], textarea[required]').evaluateAll((items) =>
    items.filter((item) => !item.disabled && !String(item.value || '').trim() && item.checkValidity()).length,
  );
  expect(invalidEmptyFields, 'empty required fields should be rejected by browser validation').toBe(0);
});

test('[G16] async form actions do not submit twice on a rapid double click', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const form = page.locator('form[method="post" i]').first();
  if (!(await form.count())) return;
  const submit = form.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await submit.count()) || !(await submit.isVisible()) || !(await submit.isEnabled())) return;

  let submissions = 0;
  await page.route('**/*', async (route) => {
    const method = route.request().method().toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      submissions++;
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ status: 503, body: 'Blocked by the global test to prevent real writes.' });
      return;
    }
    await route.continue();
  });
  await submit.dblclick({ noWaitAfter: true, timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(400);
  expect(submissions, 'rapid repeat clicks should not send duplicate writes').toBeLessThanOrEqual(1);
});

test('[G17] date and date-range fields reject invalid values', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  await settle(page);
  const dates = page.locator('input[type="date"]:visible:enabled, input[type="datetime-local"]:visible:enabled');
  test.skip(!(await dates.count()), 'Not applicable: no date fields on this page');
  await blockWrites(page);
  const first = dates.first();
  if (await first.getAttribute('type') === 'date') {
    await first.fill('2024-02-29'); // leap day must be accepted
    expect(await first.inputValue(), 'leap-year date 2024-02-29 should be accepted').toBe('2024-02-29');
    await first.fill('2024-01-31'); // month end
    expect(await first.inputValue(), 'month-end date should be accepted').toBe('2024-01-31');
  }
  const typeOf = await first.getAttribute('type');
  if (await dates.count() >= 2 && typeOf === (await dates.nth(1).getAttribute('type'))) {
    // Start later than end: the end field, the start field or the form must flag it.
    const [late, early] = typeOf === 'date' ? ['2025-12-31', '2025-01-01'] : ['2025-12-31T10:00', '2025-01-01T10:00'];
    await first.fill(late);
    await dates.nth(1).fill(early);
    await dates.nth(1).blur();
    await page.waitForTimeout(300);
    const flagged = await page.evaluate(([a, b]) => {
      const els = [...document.querySelectorAll('input[type="date"], input[type="datetime-local"]')].filter((el) => el.checkVisibility?.());
      return [els[a], els[b]].some((el) => el && (!el.checkValidity() || el.getAttribute('aria-invalid') === 'true'));
    }, [0, 1]);
    const message = await page.getByText(/(end|to).{0,30}(before|earlier|after)|(start|from).{0,30}(after|later|before)|invalid (date|range)/i).locator('visible=true').count();
    expect(flagged || message > 0, 'a start date later than the end date should be rejected').toBe(true);
  }
  expect(await page.getByText(/Invalid Date|NaN/).locator('visible=true').count(), 'dates should never render as "Invalid Date"/NaN').toBe(0);
});

test('[G18] email and phone fields reject invalid formats', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  await settle(page);
  const email = page.locator('input[type="email"]:visible:enabled, input[name*="email" i]:visible:enabled').first();
  const phone = page.locator('input[type="tel"]:visible:enabled, input[name*="phone" i]:visible:enabled, input[name*="mobile" i]:visible:enabled').first();
  test.skip(!(await email.count()) && !(await phone.count()), 'Not applicable: no email or phone fields on this page');
  await blockWrites(page);
  const rejects = async (field, value) => {
    await field.fill(value);
    await field.blur();
    await page.waitForTimeout(300);
    const invalid = await field.evaluate((el) => !el.checkValidity() || el.getAttribute('aria-invalid') === 'true');
    return invalid || (await field.inputValue()) !== value; // input masks that strip letters also count
  };
  if (await email.count()) expect(await rejects(email, 'not-an-email'), 'email field should reject "not-an-email"').toBe(true);
  if (await phone.count()) expect(await rejects(phone, 'abc-phone'), 'phone field should reject letters').toBe(true);
});

test('[G19] tables show a no-data state when their list is empty', async ({ page, baseURL }) => {
  const tables = 'table:visible, [role="table"]:visible, [role="grid"]:visible';
  // Same site, not just same origin: APIs often live on a sibling subdomain (app.example.com -> api.example.com).
  const site = (url) => new URL(url).hostname.split('.').slice(-2).join('.');
  const pathOf = (url) => new URL(url).origin + new URL(url).pathname;
  const isDataGet = (request, pageUrl) => ['fetch', 'xhr'].includes(request.resourceType()) && request.method() === 'GET' && site(request.url()) === site(pageUrl);

  const lists = new Map(); // request path -> record-list lengths in its JSON body
  const reading = [];
  page.on('response', (response) => {
    if (!isDataGet(response.request(), baseURL) || !(response.headers()['content-type'] || '').includes('json')) return;
    reading.push(response.json().then((body) => lists.set(pathOf(response.url()), recordListLengths(body))).catch(() => {}));
  });
  await page.goto(baseURL);
  await page.waitForLoadState('networkidle').catch(() => {});
  await Promise.allSettled(reading);
  test.skip(!(await page.locator(tables).count()), 'No table on this page');
  const emptyMessage = page.getByText(/no\s+(data|records?|results?|items?|entries|rows?|matching|available)|no\s+\w+\s+(found|available|yet)|nothing\s+to\s+(show|display)/i).locator('visible=true');
  const messagesBefore = await emptyMessage.count();

  // The table's list: a response holding exactly as many records as the table shows rows (else the largest list).
  const rows = await page.locator(tables).first().locator('tr:has(td), [role="row"]:has([role="cell"], [role="gridcell"])').count();
  const entries = [...lists].filter(([, lengths]) => lengths.length);
  const exact = entries.filter(([, lengths]) => lengths.includes(rows));
  const target = (exact.length ? exact : entries.sort((a, b) => Math.max(...b[1]) - Math.max(...a[1])).slice(0, 1)).map(([p]) => p);
  test.skip(!target.length, 'The table rows are not loaded by an API request (e.g. rendered on the server)');

  let mocked = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!isDataGet(request, baseURL) || !target.includes(pathOf(request.url()))) return route.continue();
    const response = await route.fetch();
    const body = await response.json().catch(() => undefined);
    if (body === undefined) return route.fulfill({ response });
    mocked++;
    await route.fulfill({ response, json: emptyLists(body) });
  });
  await page.reload();
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(mocked, 'The table data request was replaced with an empty list').toBeGreaterThan(0);

  await expect
    .poll(() => emptyMessage.count(), { message: 'An empty table shows a message such as "No data" instead of blank space', timeout: 10000 })
    .toBeGreaterThan(messagesBefore);
});

test('[G20] search, filter, sort and pagination update the list', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  await settle(page);
  const rowsSel = 'table tbody tr:visible, [role="row"]:has([role="cell"], [role="gridcell"]):visible, ul li:visible';
  const rowsText = () => page.locator('table tbody tr:visible, [role="row"]:has([role="cell"], [role="gridcell"]):visible').allInnerTexts();
  const search = page.locator('input[type="search"]:visible, input[placeholder*="search" i]:visible, input[aria-label*="search" i]:visible').first();
  const filter = page.locator('select:visible:enabled, [aria-label*="filter" i]:visible').first();
  const sort = page.locator('th[aria-sort]:visible, th:has(button):visible, [role="columnheader"][aria-sort]:visible').first();
  const next = page.locator('[aria-label*="next" i]:visible:enabled, button:has-text("Next"):visible:enabled, a:has-text("Next"):visible, .pagination a:visible').first();
  const present = { search: await search.count(), filter: await filter.count(), sort: await sort.count(), next: await next.count() };
  test.skip(!Object.values(present).some(Boolean), 'Not applicable: no search, filter, sort or pagination on this page');
  await blockWrites(page);
  const before = await rowsText();
  test.skip(!before.length, 'Not applicable: the list has no rows to search, sort or page through');

  if (present.sort) {
    await sort.click();
    await settle(page);
    const after = await rowsText();
    expect(after.length, 'sorting should keep the same rows').toBe(before.length);
    expect([...after].sort(), 'sorting should not change the data, only its order').toEqual([...before].sort());
    if (before.length > 1) expect(after.join('|') !== before.join('|') || (await sort.getAttribute('aria-sort')) != null, 'clicking a sortable header should change the order').toBe(true);
  }
  if (present.search) {
    await search.fill('zzqx-no-match-9471');
    await search.press('Enter').catch(() => {});
    await settle(page);
    await page.waitForTimeout(500);
    expect((await rowsText()).length, 'a search with no match should leave fewer rows').toBeLessThan(before.length + (before.length ? 0 : 1));
    await search.fill('');
    await search.press('Enter').catch(() => {});
    await settle(page);
  }
  if (present.next && !present.search) {
    const firstRow = (await rowsText())[0];
    await next.click();
    await settle(page);
    expect((await rowsText())[0], 'the next page should show different rows').not.toBe(firstRow);
    expect(await page.locator(rowsSel).count(), 'the next page should not be empty').toBeGreaterThan(0);
  }
});
