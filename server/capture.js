import fs from 'node:fs/promises';
import path from 'node:path';

// Claude scales each image down to ~1568px on the long edge, so long pages are sent as several
// tiles instead of one tall, unreadable image. maxTiles caps the token cost per viewport.
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, tileHeight: 1200, maxTiles: 6 },
  { name: 'tablet', width: 768, height: 1024, tileHeight: 1400, maxTiles: 3 },
  { name: 'mobile', width: 375, height: 812, tileHeight: 1600, maxTiles: 3 },
];

// ---- The functions below run inside the browser page ----

// A compact summary of what is on the page.
function summarizeDom() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  // Where a link or button navigates to (its own href or an enclosing link's), so navigation criteria can be checked.
  // Same-site targets are shortened to their path; "#" and javascript: are kept as written, since they do not navigate.
  const target = (el) => {
    const a = el.closest('a[href]');
    if (!a) return undefined;
    const raw = a.getAttribute('href').trim();
    if (raw === '' || raw.startsWith('#') || /^javascript:/i.test(raw)) return raw.slice(0, 60) || '(empty)';
    const url = new URL(a.href);
    const shown = url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
    return (a.target === '_blank' ? `${shown} (new tab)` : shown).slice(0, 150);
  };
  const pick = (selector, limit) =>
    [...document.querySelectorAll(selector)].filter(visible).slice(0, limit).map((el) => ({ tag: el.tagName.toLowerCase(), text: text(el), href: target(el) }));

  return {
    title: document.title,
    headings: pick('h1,h2,h3,h4', 30),
    buttons: pick('button,[role=button],input[type=submit],a.btn,a.button', 40),
    links: pick('a[href]', 40),
    inputs: [...document.querySelectorAll('input,select,textarea')].filter(visible).slice(0, 40).map((el) => ({
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.placeholder || null,
      label: el.labels?.[0]?.innerText?.trim() || el.getAttribute('aria-label') || null,
    })),
    images: [...document.images].filter(visible).slice(0, 40).map((img) => ({
      alt: img.alt,
      src: (img.currentSrc || img.getAttribute('src') || img.dataset.src || '').slice(0, 150),
      loaded: img.complete && img.naturalWidth > 0,
    })),
    visibleText: document.body.innerText.replace(/\s+\n/g, '\n').slice(0, 6000),
  };
}

// Computed box model and typography of the key elements, for comparing with Figma specs.
function collectStyles(maxY) {
  const SELECTOR =
    'h1,h2,h3,h4,h5,h6,p,a,button,[role=button],input,select,textarea,label,img,nav,header,footer,section,article,form,li,[class*=card],[class*=btn],[class*=hero],[class*=container]';
  const px = (v) => (v === '0px' ? '0' : v);
  const box = (s, side) => {
    const [t, r, b, l] = ['Top', 'Right', 'Bottom', 'Left'].map((d) => px(s[`${side}${d}`]));
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    return `${t} ${r} ${b} ${l}`;
  };
  const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  const selectorOf = (el) => {
    let sel = el.tagName.toLowerCase();
    if (el.id) sel += `#${el.id}`;
    const cls = [...el.classList].filter((c) => c.length < 30).slice(0, 2);
    if (cls.length) sel += `.${cls.join('.')}`;
    return sel;
  };

  // Screen-reader-only elements (sr-only / visually-hidden) are not part of the visual layout.
  const srOnly = (el, r, s) =>
    r.width <= 2 || r.height <= 2 || /^rect\(/.test(s.clip) || /inset\(50%/.test(s.clipPath) ||
    /\b(sr-only|visually-hidden|screen-reader)/i.test(el.className?.baseVal ?? el.className);

  // Name of the page section an element sits in, so issues can say where they are.
  const sectionNames = new Map();
  const sectionOf = (el) => {
    const sec = el.closest('section,header,footer,nav,[class*=section]');
    if (!sec) return undefined;
    if (!sectionNames.has(sec)) {
      const heading = sec.querySelector('h1,h2,h3')?.innerText?.trim().replace(/\s+/g, ' ').slice(0, 40);
      sectionNames.set(sec, sec.id || heading || sec.tagName.toLowerCase() + (sec.classList[0] ? `.${sec.classList[0]}` : ''));
    }
    return sectionNames.get(sec);
  };

  // Every element with its own text (Webflow and similar builders put text in plain divs), plus the
  // structural elements above. Wrappers with no text and no visual style are skipped to save room.
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= 400) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|svg|path|g)$/i.test(el.tagName)) continue;
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
    if (!ownText && !el.matches(SELECTOR)) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 4 || r.height < 4 || s.visibility === 'hidden' || s.display === 'none' || srOnly(el, r, s)) continue;
    if (r.top + window.scrollY > maxY) continue;
    const entry = {
      section: sectionOf(el),
      el: selectorOf(el),
      text: (ownText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.placeholder || '').replace(/\s+/g, ' ').slice(0, 60) || undefined,
      box: `${Math.round(r.x)},${Math.round(r.y + window.scrollY)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      padding: box(s, 'padding'),
      margin: box(s, 'margin'),
    };
    if (/flex|grid/.test(s.display) && s.gap !== 'normal') entry.gap = s.gap;
    if (ownText || /^(BUTTON|A|INPUT|LABEL|SELECT|TEXTAREA)$/.test(el.tagName)) {
      entry.font = `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily.split(',')[0].replace(/"/g, '')}`;
      if (s.letterSpacing !== 'normal') entry.letterSpacing = s.letterSpacing;
      if (s.textTransform !== 'none') entry.textTransform = s.textTransform;
      entry.color = s.color;
    }
    if (!transparent(s.backgroundColor)) entry.background = s.backgroundColor;
    if (s.borderRadius !== '0px') entry.radius = s.borderRadius;
    if (s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none') entry.border = `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`;
    const bare = !entry.text && !entry.background && !entry.radius && !entry.border && !entry.gap && entry.padding === '0';
    if (bare && !/^(IMG|BUTTON|A|INPUT|SELECT|TEXTAREA|SECTION|HEADER|FOOTER|NAV|FORM)$/.test(el.tagName)) continue;
    out.push(entry);
  }
  return out;
}

// Signals of a broken responsive layout at the current viewport width.
function detectLayoutIssues() {
  const vw = document.documentElement.clientWidth;
  const isMobile = vw < 600;
  // Screen-reader-only elements (sr-only / visually-hidden) are not part of the visual layout.
  const srOnly = (el, r, s) =>
    r.width <= 2 || r.height <= 2 || /^rect\(/.test(s.clip) || /inset\(50%/.test(s.clipPath) ||
    /\b(sr-only|visually-hidden|screen-reader)/i.test(el.className?.baseVal ?? el.className);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && !srOnly(el, r, s);
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cls = [...el.classList].slice(0, 2).join('.');
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return { el: el.tagName.toLowerCase() + (cls ? `.${cls}` : ''), text: text || undefined, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  };
  // Content that legitimately scrolls sideways (carousels, code blocks, tables) is not a layout bug.
  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };

  const all = [...document.body.querySelectorAll('*')].filter(visible);
  const overflowing = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return (r.right > vw + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed' && !insideScroller(el);
  });
  // Keep only the outermost offenders.
  const offenders = overflowing.filter((el) => !overflowing.includes(el.parentElement)).slice(0, 12).map(describe);

  const clippedText = all
    .filter((el) => {
      const s = getComputedStyle(el);
      return /(hidden|clip)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== 'ellipsis' && el.innerText?.trim();
    })
    .slice(0, 8)
    .map(describe);

  const smallText = isMobile
    ? all
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12)
        .slice(0, 8)
        .map((el) => ({ ...describe(el), fontSize: getComputedStyle(el).fontSize }))
    : [];

  const smallTargets = isMobile
    ? [...document.querySelectorAll('a[href],button,[role=button],input,select')]
        .filter(visible)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          // Inline links inside a sentence are exempt from target-size rules (WCAG 2.5.8).
          if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false;
          return r.width < 24 || r.height < 24;
        })
        .slice(0, 8)
        .map((el) => ({ ...describe(el), height: Math.round(el.getBoundingClientRect().height) }))
    : [];

  return {
    viewportWidth: vw,
    horizontalScroll: document.documentElement.scrollWidth > vw + 1,
    pageWidth: document.documentElement.scrollWidth,
    offscreenElements: offenders,
    clippedText,
    smallText,
    smallTapTargets: smallTargets,
  };
}

// Scrolls through the page so lazy images load and scroll-triggered (reveal) animations run,
// then waits for images and returns to the top.
async function preparePage() {
  const step = Math.max(200, Math.round(window.innerHeight * 0.7));
  for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 80; y += step, i++) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((r) => setTimeout(r, 300));
  await Promise.all(
    [...document.images].map((img) => {
      if (img.loading === 'lazy') img.loading = 'eager';
      return img.complete ? null : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 4000); });
    }),
  );
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 600));
}

// ---- Node side ----

/**
 * Renders the URL at desktop, tablet and mobile widths. Returns per-viewport screenshots,
 * computed styles and layout issues, plus a DOM summary from the desktop render.
 * Screenshots are saved as screenshot-<viewport>.jpg in `dir`.
 * `desktopWidth` renders desktop at the Figma frame's width so positions compare 1:1.
 * `only` limits the render to these viewport names (a re-check of errors needs fewer).
 */
export async function capturePage(url, dir, { desktopWidth, only, storageState } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    chromium = null;
  }

  if (chromium) {
    let browser;
    try {
      browser = await chromium.launch();
    } catch (err) {
      return fallbackCapture(url, `Browser could not start (${err.message.split('\n')[0]}). Run "npm run setup:browser".`);
    }
    try {
      const viewports = [];
      let dom = null;
      for (const preset of VIEWPORTS) {
        if (only && !only.includes(preset.name)) continue;
        const vp = preset.name === 'desktop' && desktopWidth ? { ...preset, width: desktopWidth } : preset;
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.name === 'mobile',
          hasTouch: vp.name !== 'desktop',
          storageState, // signed-in session when the ticket has a login (see login.js)
        });
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        } catch (err) {
          if (!page.url() || page.url() === 'about:blank') {
            throw Object.assign(new Error(`Could not open ${url} (${err.message.split('\n')[0]}). Is the site running and reachable?`), { status: 502 });
          }
          await page.waitForLoadState('load').catch(() => {});
        }
        await page.evaluate(preparePage);

        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        // Full page for people to view; tiles for Claude.
        await page.screenshot({ path: path.join(dir, `screenshot-${vp.name}.jpg`), type: 'jpeg', quality: 60, fullPage: true });
        const tiles = [];
        for (let y = 0; y < pageHeight && tiles.length < vp.maxTiles; y += vp.tileHeight) {
          const height = Math.min(vp.tileHeight, pageHeight - y);
          if (height < 50) break;
          const buffer = await page.screenshot({ type: 'jpeg', quality: 65, clip: { x: 0, y, width: vp.width, height }, fullPage: true });
          tiles.push({ from: y, to: y + height, base64: buffer.toString('base64') });
        }
        const capturedHeight = tiles.at(-1)?.to ?? 0;

        viewports.push({
          name: vp.name,
          width: vp.width,
          pageHeight,
          capturedHeight,
          tiles,
          styles: await page.evaluate(collectStyles, pageHeight),
          layout: await page.evaluate(detectLayoutIssues),
        });
        if (vp.name === 'desktop') dom = await page.evaluate(summarizeDom);
        await context.close();
      }
      return { dom, viewports, warning: null };
    } finally {
      await browser.close();
    }
  }
  return fallbackCapture(url, 'Playwright is not installed. Run "npm install" and "npm run setup:browser".');
}

// Without a browser: raw HTML text only, no screenshots, styles or responsive checks.
async function fallbackCapture(url, reason) {
  let html;
  try {
    html = await (await fetch(url)).text();
  } catch (fetchErr) {
    const code = fetchErr.cause?.code || fetchErr.message;
    throw Object.assign(new Error(`Could not open ${url} (${code}). Is the site running and reachable?`), { status: 502 });
  }
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 6000);
  return {
    dom: { title: html.match(/<title>(.*?)<\/title>/i)?.[1] ?? null, visibleText },
    viewports: [],
    warning: `${reason} Checked raw HTML only: no screenshots, design comparison or responsive check.`,
  };
}

// ---- Scan for test generation ----

// Runs in the page: the real headings (h1–h6 / role=heading), so tests only use getByRole('heading') for actual headings.
function listHeadings() {
  return [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')]
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: el.innerText.trim().replace(/\s+/g, ' ').slice(0, 80) }))
    .filter((h) => h.text)
    .slice(0, 60);
}

// Runs in the page: each top-level section with its class, short labels and repeated child classes (cards),
// so generated tests use the page's real structure instead of guessing tags like <footer> or <h3>.
function outlineSections() {
  const blocks = [...document.body.children].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 40 && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName);
  });
  return blocks.slice(0, 20).map((el) => {
    const inner = el.children.length === 1 && el.firstElementChild.children.length ? el.firstElementChild : el;
    const classCount = new Map();
    for (const c of inner.querySelectorAll('[class]')) {
      const cls = String(c.className).split(' ')[0];
      if (cls) classCount.set(cls, (classCount.get(cls) || 0) + 1);
    }
    const labels = [...inner.querySelectorAll('*')]
      .filter((n) => [...n.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim()))
      .map((n) => ({ tag: n.tagName.toLowerCase(), cls: String(n.className).split(' ')[0] || undefined, text: n.innerText.trim().replace(/\s+/g, ' ').slice(0, 50) }))
      .filter((n) => n.text && n.text.length <= 50)
      .slice(0, 12);
    return {
      selector: el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : '') +
        (inner !== el && inner.className ? ` > .${String(inner.className).split(' ')[0]}` : ''),
      labels,
      repeated: [...classCount].filter(([, n]) => n >= 3 && n <= 30).slice(0, 10).map(([cls, n]) => `.${cls} x${n}`),
    };
  });
}

// Runs in the page: interactive elements with the attributes a test needs to locate them.
function listInteractive() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (el) =>
    (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
  const SELECTOR =
    'a[href],button,[role=button],input,select,textarea,form,summary,[aria-expanded],[aria-controls],[role=tab],[role=dialog],[data-testid]';
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (out.length >= 150 || seen.has(el)) continue;
    seen.add(el);
    const href = el.getAttribute('href');
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      name: name(el) || undefined,
      id: el.id || undefined,
      testId: el.dataset.testid || undefined,
      type: el.getAttribute('type') || undefined,
      inputName: el.getAttribute('name') || undefined,
      href: href && !href.startsWith('javascript:') ? href.slice(0, 150) : undefined,
      ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
      ariaControls: el.getAttribute('aria-controls') || undefined,
      classes: [...el.classList].slice(0, 3).join(' ') || undefined,
      visible: visible(el),
    });
  }
  return out;
}

/**
 * Loads the page at desktop and mobile width and records what a functional/API test needs:
 * interactive elements, forms, the fetch/XHR calls the page makes, console errors and failed requests.
 */
export async function scanForTests(url, { storageState } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const scan = { url, network: [], consoleErrors: [], failedRequests: [], desktop: null, mobile: null };
    const seen = new Set();
    for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.name === 'mobile', storageState });
      const page = await context.newPage();
      page.on('response', (res) => {
        const req = res.request();
        const type = req.resourceType();
        if (type === 'fetch' || type === 'xhr' || (type === 'document' && req.frame() === page.mainFrame())) {
          const key = `${req.method()} ${res.url().split('?')[0]}`;
          if (!seen.has(key) && scan.network.length < 60) {
            seen.add(key);
            scan.network.push({ method: req.method(), url: res.url().slice(0, 300), status: res.status(), type, contentType: res.headers()['content-type']?.split(';')[0] });
          }
        }
        if (res.status() >= 400 && scan.failedRequests.length < 20) scan.failedRequests.push({ url: res.url().slice(0, 300), status: res.status(), viewport: vp.name });
      });
      page.on('requestfailed', (req) => {
        if (scan.failedRequests.length < 20) scan.failedRequests.push({ url: req.url().slice(0, 300), error: req.failure()?.errorText, viewport: vp.name });
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error' && scan.consoleErrors.length < 20) scan.consoleErrors.push(msg.text().slice(0, 300));
      });
      page.on('pageerror', (err) => {
        if (scan.consoleErrors.length < 20) scan.consoleErrors.push(err.message.slice(0, 300));
      });

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      } catch (err) {
        if (!page.url() || page.url() === 'about:blank') {
          throw Object.assign(new Error(`Could not open ${url} (${err.message.split('\n')[0]}).`), { status: 502 });
        }
      }
      await page.evaluate(preparePage);
      scan[vp.name] = { width: vp.width, title: await page.title(), elements: await page.evaluate(listInteractive), headings: await page.evaluate(listHeadings), outline: await page.evaluate(outlineSections) };
      await context.close();
    }
    return scan;
  } finally {
    await browser.close();
  }
}
