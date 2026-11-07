// Each check opens the ticket's page URL (baseURL = TEST_BASE_URL), not the site root.
import { test, expect } from '@playwright/test';

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

test('[G02] shared navigation links have working destinations', async ({ page, request, baseURL }) => {
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

test('[G03] visible links and controls have names and keyboard access', async ({ page, baseURL }) => {
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

test('[G04] images and headings meet basic accessibility checks', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const missingAlt = await page.locator('img:not([alt]):not([aria-hidden="true"])').count();
  expect(missingAlt, 'images need an alt attribute or must be marked decorative').toBe(0);
  const levels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((items) => items.map((item) => Number(item.tagName.slice(1))));
  for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], 'heading levels should not skip').toBeLessThanOrEqual(1);
});

test('[G05] required form fields validate without submitting data', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const invalidEmptyFields = await page.locator('input[required], select[required], textarea[required]').evaluateAll((items) =>
    items.filter((item) => !item.disabled && !String(item.value || '').trim() && item.checkValidity()).length,
  );
  expect(invalidEmptyFields, 'empty required fields should be rejected by browser validation').toBe(0);
});

test('[G06] page has no horizontal overflow at common viewport sizes', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `page overflows at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test('[G07] async form actions do not submit twice on a rapid double click', async ({ page, baseURL }) => {
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

test('[G08] tables show a no-data state when their list is empty', async ({ page, baseURL }) => {
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
