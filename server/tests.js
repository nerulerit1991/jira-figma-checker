import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareSession } from './login.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './config.js';
import { writeFileAtomic } from './store.js';
import { cleanEnv, runAgentJson } from './ai.js';
import { scanForTests } from './capture.js';
import { pagePath, testsPrompt } from './prompts.js';

// Generated tests live with the ticket, so deleting the ticket deletes them too:
//   data/<KEY>/tests/*.spec.js, playwright.config.mjs, tests.json (what was generated), results.json (last run),
//   verification.json (which scripts a person reviewed; see verifyScript)
const testsDir = (key) => path.join(DATA_DIR, key, 'tests');
const GLOBAL_CASES_FILE = path.join(DATA_DIR, 'global-test-cases', 'cases.json');
const GLOBAL_SPEC_FILE = path.join(DATA_DIR, 'global-test-cases', 'global.spec.js');
const SPEC_NAME = /^[a-z0-9-]+\.spec\.js$/;
const RUN_TIMEOUT_MS = 5 * 60_000;

// Written by the server, never by the AI. The page URL comes in through TEST_BASE_URL.
const CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\\.spec\\.js$/,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: 0,
  workers: 2,
  outputDir: process.env.TEST_OUTPUT_DIR || '.output',
  reporter: [['json', { outputFile: process.env.TEST_REPORT_FILE || 'report.json' }]],
  use: { baseURL: process.env.TEST_BASE_URL, storageState: process.env.STORAGE_STATE || undefined, headless: true, trace: 'off', screenshot: 'off' },
});
`;

// ---- Which hosts a test may call: only the site under test ----
// A test runs with the site's signed-in session, so it may only send requests to that site (its own origin, or another
// host of the same site such as its API subdomain). Third parties the page happens to load (analytics, CAPTCHA, CDNs)
// are never allowed, so a script cannot pass session data to them.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Shared hosting domains: each subdomain is a different owner's site, so only the exact host counts as the same site.
const SHARED_HOSTING = /(^|\.)(webflow\.io|vercel\.app|netlify\.app|github\.io|pages\.dev|workers\.dev|herokuapp\.com|azurewebsites\.net|cloudfront\.net|amazonaws\.com|appspot\.com|firebaseapp\.com|web\.app|onrender\.com|fly\.dev|ngrok\.io|ngrok-free\.app|loca\.lt|trycloudflare\.com|wixsite\.com|squarespace\.com|myshopify\.com|wpengine\.com|framer\.website|glitch\.me|repl\.co|surge\.sh|azurestaticapps\.net)$/i;
// Country domains with a second level (example.com.ph, example.co.uk): the site name is one label further left.
const SECOND_LEVEL = /^(com|net|org|gov|edu|ac|co|or|ne|go)$/;

/** The part of a host that identifies the site: "app.beta.example.com" → "example.com". */
function siteOf(hostname) {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return 'localhost';
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || SHARED_HOSTING.test(host)) return host;
  const labels = host.split('.');
  const keep = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.test(labels.at(-2)) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** Whether `origin` belongs to the same site as the page under test (any port on a local host). */
export function sameSite(origin, pageUrl) {
  try {
    const a = new URL(origin);
    const b = new URL(pageUrl);
    return /^https?:$/.test(a.protocol) && siteOf(a.hostname) === siteOf(b.hostname);
  } catch {
    return false;
  }
}

const siteOrigins = (url, origins) => new Set([new URL(url).origin, ...origins.filter((o) => sameSite(o, url))]);

// ---- Opening the page under test ----
// baseURL is the full page URL (e.g. https://site/about), but Playwright resolves page.goto('/') against the site root,
// so it would open the home page instead. Tests must open the page by its own path ('/about').
const ROOT_GOTO = /(\bpage\s*\.\s*goto\s*\(\s*)(['"`])(\/?)\2/g;

/** Points page.goto('/') and page.goto('') at the page under test, so the test cannot land on the site's home page. */
export function openPageUnderTest(content, url) {
  const target = pagePath(url);
  if (target === '/') return content;
  return content.replace(ROOT_GOTO, (_, call, quote) => `${call}${quote}${target.replaceAll(quote, `\\${quote}`)}${quote}`);
}

/** Why a saved script would open the wrong page for `url`, or null. */
function opensSiteRoot(content, url) {
  if (pagePath(url) === '/' || !new RegExp(ROOT_GOTO.source).test(content)) return null;
  return `opens the site's home page (page.goto('/')) instead of ${pagePath(url)}`;
}

/**
 * Generated code runs on this machine, and the Jira text it was written from is untrusted.
 * Only allow Playwright test code that talks to the site under test.
 * @returns {string|null} why the script was rejected, or null if it is acceptable
 */
export function validateScript(content, allowedOrigins) {
  if (typeof content !== 'string' || content.length > 200_000) return 'empty or too large';
  const imports = [...content.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  if (!imports.length || imports.some((m) => m !== '@playwright/test')) return 'imports something other than @playwright/test';
  const forbidden = content.match(
    /\.cookies\s*\(|document\s*\.\s*cookie|\brequire\s*\(|\bimport\s*\(|\bprocess\b|child_process|\bfs\b|node:|\beval\s*\(|\bFunction\s*\(|globalThis|__dirname|__filename|WebSocket|\.exposeFunction|\.addInitScript|setExtraHTTPHeaders|storageState|routeFromHAR|routeWebSocket|route\s*\.\s*fetch\s*\(/,
  );
  if (forbidden) return `uses "${forbidden[0].trim()}", which is not allowed`;
  // page.route() is allowed only to mock responses (route.fulfill) for empty-state tests. Passing a request on with
  // changes (a new method, URL or body) could turn a read into a write, so continue()/fallback() must take no arguments.
  const changedPassThrough = content.match(/\.\s*(continue|fallback)\s*\(\s*[^)\s]/);
  if (changedPassThrough) return `uses "${changedPassThrough[1]}()" with overrides; route handlers may only fulfill or pass requests on unchanged`;
  for (const [, raw] of content.matchAll(/(https?:\/\/[^\s'"`)]+)/g)) {
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      return `contains an invalid URL: ${raw}`;
    }
    if (!allowedOrigins.has(origin)) return `calls ${origin}, which is not part of the site under test`;
  }
  return null;
}

export async function readTests(key) {
  const dir = testsDir(key);
  const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
  let meta;
  try {
    meta = await read('tests.json');
  } catch {
    return null;
  }
  const results = await read('results.json').catch(() => null);
  const errors = await readErrors(dir);
  const scripts = {};
  for (const f of meta.files) scripts[f] = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
  const approvals = await readApprovals(dir);
  const verification = Object.fromEntries(
    Object.entries(scripts).map(([f, code]) => {
      const hash = hashOf(code);
      const approved = approvals[f]?.hash === hash;
      // A skip-only script needs no review; its skipped tests and reasons are known before any run.
      const skipped = skipOnlyTests(code);
      return [f, { hash, verified: approved, verifiedAt: approved ? approvals[f].verifiedAt : null, skipOnly: Boolean(skipped), ...(skipped && { skipped }) }];
    }),
  );
  return { ...meta, results, errors, scripts, verification };
}

// ---- Review before running ----
// A generated script runs as Node code on this machine and acts on the site as the test account, and it was written
// from untrusted Jira text. So a person must read each script and click Verify before it can run. The approval is tied
// to the script's exact content: regenerating or editing it makes it unverified again. Unverified scripts are never
// loaded by Playwright (not even their top-level code).
const APPROVALS_FILE = 'verification.json';
const hashOf = (content) => createHash('sha256').update(content).digest('hex');
const readApprovals = (dir) => fs.readFile(path.join(dir, APPROVALS_FILE), 'utf8').then(JSON.parse).catch(() => ({}));

/** Marks one saved script as reviewed (or not). `hash` is the content the person reviewed; it must still be on disk. */
export async function verifyScript(key, file, hash, verified) {
  const dir = testsDir(key);
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'tests.json'), 'utf8').catch(() => 'null'));
  if (!meta?.files?.includes(file)) throw Object.assign(new Error(`${file} is not one of this ticket's scripts.`), { status: 404 });
  const approvals = await readApprovals(dir);
  if (verified) {
    const current = hashOf(await fs.readFile(path.join(dir, file), 'utf8'));
    if (current !== hash) throw Object.assign(new Error(`${file} changed since you opened it. Review the new version, then verify again.`), { status: 409 });
    approvals[file] = { hash, verifiedAt: new Date().toISOString() };
  } else {
    delete approvals[file];
  }
  await writeFileAtomic(path.join(dir, APPROVALS_FILE), JSON.stringify(approvals, null, 2));
  return readTests(key);
}

/** The saved scripts whose current content was verified. */
async function verifiedFiles(dir, files) {
  const approvals = await readApprovals(dir);
  const ok = [];
  for (const f of files) {
    const code = await fs.readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (code != null && approvals[f]?.hash === hashOf(code)) ok.push(f);
  }
  return ok;
}

const NOT_VERIFIED = 'Not verified. Review the script and click Verify to run it.';

// ---- Skip-only scripts ----
// A script whose every test starts with `test.skip(true, '<reason>')` runs nothing: Playwright stops each test at that
// line, so any code after it is unreachable. Such a script needs no review. It is never loaded by Playwright either
// (not even its top-level code); its rows and reasons are read from the source.
// The check errs towards "needs review": a test written any other way (test.only, test.fail, a skip with a condition,
// a first statement other than the skip) means the whole script must be verified as usual.
const STR = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`(?:[^`\\\\$]|\\\\.)*`)';
const TEST_HEAD = new RegExp(
  String.raw`\btest\s*\(\s*(${STR})\s*,\s*async\s*\(\s*(?:\{[\w\s,]*\})?\s*\)\s*=>\s*\{\s*test\.skip\(\s*true\s*,\s*(${STR})\s*,?\s*\)`,
  'g',
);
const OTHER_TEST_FORMS = /\btest\.(?:only|fail|fixme|slow|step)\s*\(|(?<![.\w$])(?:it|describe)\s*\(|\btest\.describe\.(?:only|parallel|serial)\b/;
const unquote = (literal) => literal.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);

/** The tests of a skip-only script ({ title, reason }), or null when the script has a test that would run. */
export function skipOnlyTests(code) {
  if (typeof code !== 'string' || OTHER_TEST_FORMS.test(code)) return null;
  const calls = code.match(/\btest\s*\(/g) || [];
  const heads = [...code.matchAll(TEST_HEAD)];
  if (!calls.length || heads.length !== calls.length) return null;
  return heads.map((m) => ({ title: unquote(m[1]), reason: unquote(m[2]) }));
}

const skipOnlyRows = (file, code) =>
  (skipOnlyTests(code) || []).map((t) => ({ file, title: t.title, status: 'skipped', durationMs: null, error: null, skipReason: t.reason }));

export async function readGlobalTests(key) {
  const dir = testsDir(key);
  const catalog = JSON.parse(await fs.readFile(GLOBAL_CASES_FILE, 'utf8'));
  const results = await fs.readFile(path.join(dir, 'global-results.json'), 'utf8').then(JSON.parse).catch(() => null);
  const errors = results ? await readErrors(dir, 'global-') : null;
  return { cases: catalog.cases || [], results, errors };
}

/** AI step (uses tokens): scans the page, writes the scripts, checks them and saves them for this ticket. */
export async function generateTests(key, url, jira) {
  const storageState = await prepareSession(key, url);
  let scan = await scanForTests(url, { storageState });
  // The AI only sees, and may only call, the site's own requests; third-party calls are left out of the scan.
  const ownNetwork = scan.network.filter((n) => sameSite(n.url, url));
  const thirdParty = [...new Set(scan.network.filter((n) => !sameSite(n.url, url)).map((n) => new URL(n.url).host))];
  scan = { ...scan, network: ownNetwork, thirdPartyHostsNotTested: thirdParty };
  const allowedOrigins = siteOrigins(url, ownNetwork.map((n) => new URL(n.url).origin));
  const globalTestCases = JSON.parse(await fs.readFile(GLOBAL_CASES_FILE, 'utf8')).cases || [];

  const { data, meta } = await runAgentJson({ ...testsPrompt({ jira, url, scan, globalTestCases, signedIn: Boolean(storageState) }), track: { key, source: 'tests' } });
  const files = (data.files || [])
    .filter((f) => SPEC_NAME.test(f.name))
    .map((f) => (typeof f.content === 'string' ? { ...f, content: openPageUnderTest(f.content, url) } : f));
  if (!files.length) throw new Error('Claude did not return any test files. Try again.');
  for (const f of files) {
    const problem = validateScript(f.content, allowedOrigins);
    if (problem) throw Object.assign(new Error(`Rejected ${f.name}: it ${problem}. Nothing was saved; try Regenerate.`), { status: 422 });
  }

  // Replace the ticket's scripts and their last results; the global suite's results (global-*) stay.
  const dir = testsDir(key);
  await fs.mkdir(dir, { recursive: true });
  for (const name of await fs.readdir(dir)) {
    if (!name.startsWith('global-')) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
  await fs.writeFile(path.join(dir, 'playwright.config.mjs'), CONFIG);
  for (const f of files) await fs.writeFile(path.join(dir, f.name), f.content);
  const testsMeta = {
    url,
    files: files.map((f) => f.name),
    allowedOrigins: [...allowedOrigins],
    tests: data.tests || [],
    notes: data.notes || [],
    generatedAt: new Date().toISOString(),
    ai: meta,
  };
  await writeFileAtomic(path.join(dir, 'tests.json'), JSON.stringify(testsMeta, null, 2));
  return readTests(key);
}

/** Flattens Playwright's JSON report into one row per test. */
function flattenReport(report) {
  const rows = [];
  // `describes`: the test.describe() titles around a spec, so same-named tests in different blocks stay apart.
  const walk = (suite, file, describes) => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const r = t.results?.at(-1) || {};
        const status = t.status === 'skipped' || r.status === 'skipped' ? 'skipped' : t.status === 'expected' ? 'passed' : 'failed';
        const message = (r.error?.message || r.errors?.[0]?.message || '').replace(/\u001b\[[0-9;]*m/g, '');
        rows.push({
          file: spec.file || file,
          title: spec.title,
          describe: describes.join(' › ') || undefined,
          project: t.projectName || undefined,
          status,
          durationMs: r.duration ?? null,
          error: status === 'failed' ? message.split('\n').filter(Boolean).slice(0, 6).join('\n').slice(0, 600) : null,
          skipReason: status === 'skipped' ? t.annotations?.find((a) => a.type === 'skip')?.description || null : null,
        });
      }
    }
    for (const child of suite.suites || []) walk(child, child.file || file, [...describes, child.title]);
  };
  for (const s of report.suites || []) walk(s, s.file, []);
  return rows;
}

/** Failed rows only, saved as <prefix>errors.json next to the results. */
const errorsOf = (results) => ({
  url: results.url,
  ranAt: results.ranAt,
  failed: results.rows.filter((r) => r.status === 'failed').map(({ file, title, project, error }) => ({ file, title, project, error })),
});

async function writeErrors(dir, results, prefix = '') {
  await writeFileAtomic(path.join(dir, `${prefix}errors.json`), JSON.stringify(errorsOf(results), null, 2));
}

// Runs saved before errors.json existed get their errors from results.json.
const readErrors = (dir, prefix = '') =>
  fs.readFile(path.join(dir, `${prefix}errors.json`), 'utf8').then(JSON.parse)
    .catch(() => fs.readFile(path.join(dir, `${prefix}results.json`), 'utf8').then((text) => errorsOf(JSON.parse(text))))
    .catch(() => null);

// Rows saved before `describe` was recorded match on file, title and project alone.
const sameTest = (a, b) =>
  a.file === b.file && a.title === b.title && a.project === b.project && (!a.describe || !b.describe || a.describe === b.describe);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Runs Playwright with the server-owned config; report and traces land in `reportDir`.
 * With `previous` (the last results), runs only its failed tests and merges their new results into it.
 */
export async function runPlaywright(dir, url, { label, storageState, previous, files, unverified = [], unverifiedRows = [], skipOnly = {}, configDir = dir, reportDir = dir, filePrefix = '', outputDir = path.join(reportDir, '.output') }) {
  // Rows of scripts that are not verified: listed as skipped, never run.
  const blocked = (r) => unverified.includes(r.file);
  const failed = previous?.rows.filter((r) => r.status === 'failed' && !blocked(r) && !skipOnly[r.file]) || [];
  // Playwright matches --grep against the title path joined with spaces (… describe … title); anchoring on the
  // test's own describe blocks and title keeps similar or same-named tests elsewhere out.
  const titlePath = (r) => [...(r.describe ? r.describe.split(' › ') : []), r.title].map(escapeRegExp).join(' ');
  const grep = previous ? ['--grep', failed.map((r) => `(^|\\s)${titlePath(r)}$`).join('|')] : [];
  // `files`: only these spec files are loaded (positional filters are regexes matched against the file path).
  const fileFilters = files ? files.map((f) => `(^|[\\\\/])${escapeRegExp(f)}$`) : [];
  // Always (re)write the config: it is server-owned and must not be edited.
  const configPath = path.join(configDir, 'playwright.config.mjs');
  const reportPath = path.join(reportDir, 'report.json');
  await fs.writeFile(configPath, CONFIG);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(reportPath, { force: true });
  // Run Playwright's CLI with Node itself: Windows refuses to spawn the .cmd shim without a shell (EINVAL).
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const started = Date.now();
  const nothingToRun = (files && !files.length) || (previous && !failed.length);
  let timedOut = false;
  const output = nothingToRun ? '' : await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', configPath, ...fileFilters, ...grep], {
      cwd: configDir,
      env: { ...cleanEnv, TEST_BASE_URL: url, CI: '1', TEST_REPORT_FILE: reportPath, TEST_OUTPUT_DIR: outputDir, ...(storageState && { STORAGE_STATE: storageState }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log = (log + d).slice(-4000)));
    child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
    let forceKill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Playwright normally stops its browsers on SIGTERM; make sure it is gone if it hangs.
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, RUN_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
    };
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', () => {
      done();
      resolve(log);
    });
  });
  if (timedOut) throw Object.assign(new Error(`${label} stopped: still running after the ${RUN_TIMEOUT_MS / 60_000}-minute limit.`), { status: 504 });

  let report = { suites: [], errors: [] };
  try {
    if (!nothingToRun) report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch {
    throw Object.assign(new Error(`${label} could not run: ${output.trim().split('\n').slice(-3).join(' ') || 'no output'}`), { status: 500 });
  }
  const fresh = flattenReport(report);
  const runError = (report.errors || []).map((e) => e.message || '').join(' ').replace(/\u001b\[[0-9;]*m/g, '');
  if (previous && !fresh.length && runError && !/no tests found/i.test(runError)) {
    throw Object.assign(new Error(`${label} could not run: ${runError.split('\n')[0].slice(0, 300)}`), { status: 500 });
  }
  // A re-run keeps every earlier row and swaps in the new result of each test that failed. A failed test that is no
  // longer in the scripts (renamed or removed) is marked skipped rather than left failed forever.
  const gone = { status: 'skipped', error: null, skipReason: 'No longer in the test scripts. Run all tests to refresh.' };
  const notVerified = { status: 'skipped', error: null, durationMs: null, skipReason: NOT_VERIFIED };
  const rows = previous
    ? previous.rows.map((r) => (skipOnly[r.file] ? skipOnly[r.file].find((x) => x.title === r.title) || { ...r, ...gone } : blocked(r) ? { ...r, ...notVerified } : r.status === 'failed' ? fresh.find((f) => sameTest(f, r)) || { ...r, ...gone } : r))
    : [...fresh, ...unverifiedRows];
  const now = new Date().toISOString();
  const results = {
    url,
    ranAt: previous ? previous.ranAt : now,
    durationMs: previous ? previous.durationMs : Date.now() - started,
    ...(previous && { rerunAt: now }),
    passed: rows.filter((r) => r.status === 'passed').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    rows,
  };
  await writeFileAtomic(path.join(reportDir, `${filePrefix}results.json`), JSON.stringify(results, null, 2));
  await writeErrors(reportDir, results, filePrefix);
}

// Re-checks the saved scripts in case they were edited by hand since generation, and splits them into the verified
// ones (run) and the rest (listed as skipped, never loaded).
async function checkSavedScripts(dir, url) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'tests.json'), 'utf8').catch(() => 'null'));
  if (!meta) throw Object.assign(new Error('No tests yet. Generate them first.'), { status: 400 });
  // Origins saved by older versions may include third parties; only the site's own ones still count.
  const allowedOrigins = siteOrigins(url, meta.allowedOrigins || []);
  for (const name of meta.files) {
    const content = await fs.readFile(path.join(dir, name), 'utf8');
    // Scripts saved before the page-path fix open the home page, so their results would describe the wrong page.
    const problem = validateScript(content, allowedOrigins) || opensSiteRoot(content, url);
    if (problem) throw Object.assign(new Error(`${name} ${problem}. Regenerate the tests.`), { status: 422 });
  }
  // Skip-only scripts are never loaded: their rows (with the script's own skip reasons) come from the source.
  const skipOnly = {};
  for (const name of meta.files) {
    const rows = skipOnlyRows(name, await fs.readFile(path.join(dir, name), 'utf8'));
    if (rows.length) skipOnly[name] = rows;
  }
  const files = (await verifiedFiles(dir, meta.files)).filter((f) => !skipOnly[f]);
  const unverified = meta.files.filter((f) => !files.includes(f) && !skipOnly[f]);
  const unverifiedRows = (meta.tests || [])
    .filter((t) => unverified.includes(t.file))
    .map((t) => ({ file: t.file, title: t.title, status: 'skipped', durationMs: null, error: null, skipReason: NOT_VERIFIED }));
  return { files, unverified, unverifiedRows: [...Object.values(skipOnly).flat(), ...unverifiedRows], skipOnly };
}

const globalRunOptions = (dir) => ({ label: 'Default tests', configDir: path.dirname(GLOBAL_SPEC_FILE), reportDir: dir, filePrefix: 'global-' });

/** Runs the saved scripts with Playwright on this machine. Uses no tokens. */
export async function runTests(key, url) {
  const dir = testsDir(key);
  const scope = await checkSavedScripts(dir, url);
  // Sign in only when something will actually run.
  const storageState = scope.files.length ? await prepareSession(key, url) : undefined;
  await runPlaywright(dir, url, { label: 'Tests', storageState, ...scope });
  return readTests(key);
}

/** Runs the shared suite (data/global-test-cases/global.spec.js); its results join the ticket's tests/ folder. */
export async function runGlobalTests(key, url) {
  const dir = testsDir(key);
  await fs.mkdir(dir, { recursive: true });
  await runPlaywright(dir, url, { ...globalRunOptions(dir), storageState: await prepareSession(key, url) });
  return readGlobalTests(key);
}

/** Re-runs only the ticket and global tests that failed last time; passing results are kept. Uses no tokens. */
export async function rerunFailedTests(key, url) {
  const dir = testsDir(key);
  const read = (name) => fs.readFile(path.join(dir, name), 'utf8').then(JSON.parse).catch(() => null);
  const hasFailed = (results) => results?.rows?.some((r) => r.status === 'failed');
  const [ticket, global] = await Promise.all([read('results.json'), read('global-results.json')]);
  if (!hasFailed(ticket) && !hasFailed(global)) throw Object.assign(new Error('The last run has no failed tests to re-run.'), { status: 400 });
  const storageState = await prepareSession(key, url);
  if (hasFailed(ticket)) {
    const scope = await checkSavedScripts(dir, url);
    await runPlaywright(dir, url, { label: 'Tests', storageState, previous: ticket, ...scope });
  }
  if (hasFailed(global)) await runPlaywright(dir, url, { ...globalRunOptions(dir), storageState, previous: global });
  return { ticket: await readTests(key), global: await readGlobalTests(key) };
}
