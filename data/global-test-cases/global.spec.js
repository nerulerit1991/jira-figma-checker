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
