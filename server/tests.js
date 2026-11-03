import fs from 'node:fs/promises';
import { prepareSession } from './login.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './config.js';
import { writeFileAtomic } from './store.js';
import { cleanEnv, runAgentJson } from './ai.js';
import { scanForTests } from './capture.js';
import { testsPrompt } from './prompts.js';

// Generated tests live with the ticket, so deleting the ticket deletes them too:
//   data/<KEY>/tests/*.spec.js, playwright.config.mjs, tests.json (what was generated), results.json (last run)
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
    /\brequire\s*\(|\bimport\s*\(|\bprocess\b|child_process|\bfs\b|node:|\beval\s*\(|\bFunction\s*\(|globalThis|__dirname|__filename|WebSocket|\.exposeFunction|\.addInitScript|setExtraHTTPHeaders|storageState|\.route\s*\(/,
  );
  if (forbidden) return `uses "${forbidden[0].trim()}", which is not allowed`;
  for (const [, raw] of content.matchAll(/(https?:\/\/[^\s'"`)]+)/g)) {
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      return `contains an invalid URL: ${raw}`;
    }
    if (!allowedOrigins.has(origin)) return `calls ${origin}, which is not the site under test`;
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
  return { ...meta, results, errors, scripts };
}

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
  const scan = await scanForTests(url, { storageState });
  const allowedOrigins = new Set([new URL(url).origin, ...scan.network.map((n) => new URL(n.url).origin)]);
  const globalTestCases = JSON.parse(await fs.readFile(GLOBAL_CASES_FILE, 'utf8')).cases || [];

  const { data, meta } = await runAgentJson({ ...testsPrompt({ jira, url, scan, globalTestCases, signedIn: Boolean(storageState) }) });
  const files = (data.files || []).filter((f) => SPEC_NAME.test(f.name));
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
export async function runPlaywright(dir, url, { label, storageState, previous, configDir = dir, reportDir = dir, filePrefix = '', outputDir = path.join(reportDir, '.output') }) {
  const failed = previous?.rows.filter((r) => r.status === 'failed') || [];
  // Playwright matches --grep against the title path joined with spaces (… describe … title); anchoring on the
  // test's own describe blocks and title keeps similar or same-named tests elsewhere out.
  const titlePath = (r) => [...(r.describe ? r.describe.split(' › ') : []), r.title].map(escapeRegExp).join(' ');
  const grep = previous ? ['--grep', failed.map((r) => `(^|\\s)${titlePath(r)}$`).join('|')] : [];
  // Always (re)write the config: it is server-owned and must not be edited.
  const configPath = path.join(configDir, 'playwright.config.mjs');
  const reportPath = path.join(reportDir, 'report.json');
  await fs.writeFile(configPath, CONFIG);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(reportPath, { force: true });
  // Run Playwright's CLI with Node itself: Windows refuses to spawn the .cmd shim without a shell (EINVAL).
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const started = Date.now();
  let timedOut = false;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', configPath, ...grep], {
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

  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
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
  const rows = previous
    ? previous.rows.map((r) => (r.status === 'failed' ? fresh.find((f) => sameTest(f, r)) || { ...r, ...gone } : r))
    : fresh;
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

// Re-checks the saved scripts in case they were edited by hand since generation.
async function checkSavedScripts(dir, url) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'tests.json'), 'utf8').catch(() => 'null'));
  if (!meta) throw Object.assign(new Error('No tests yet. Generate them first.'), { status: 400 });
  const allowedOrigins = new Set([...(meta.allowedOrigins || []), new URL(url).origin]);
  for (const name of meta.files) {
    const problem = validateScript(await fs.readFile(path.join(dir, name), 'utf8'), allowedOrigins);
    if (problem) throw Object.assign(new Error(`${name} ${problem}. Regenerate the tests.`), { status: 422 });
  }
}

const globalRunOptions = (dir) => ({ label: 'Global tests', configDir: path.dirname(GLOBAL_SPEC_FILE), reportDir: dir, filePrefix: 'global-' });

/** Runs the saved scripts with Playwright on this machine. Uses no tokens. */
export async function runTests(key, url) {
  const dir = testsDir(key);
  await checkSavedScripts(dir, url);
  await runPlaywright(dir, url, { label: 'Tests', storageState: await prepareSession(key, url) });
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
    await checkSavedScripts(dir, url);
    await runPlaywright(dir, url, { label: 'Tests', storageState, previous: ticket });
  }
  if (hasFailed(global)) await runPlaywright(dir, url, { ...globalRunOptions(dir), storageState, previous: global });
  return { ticket: await readTests(key), global: await readGlobalTests(key) };
}
