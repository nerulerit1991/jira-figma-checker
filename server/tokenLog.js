// Every AI call made for a ticket, kept in data/<KEY>/token-log.json so the Sources panel can show what the ticket has
// cost in total. Re-fetching replaces jira.json / figma.json / check.json / tests, but never removes earlier entries here.
import { readJson, writeJson } from './store.js';

const LOG = 'token-log';
export const TOKEN_SOURCES = ['jira', 'figma', 'tests', 'check'];

/** Same count the UI shows for one call: everything processed, including cached input. */
export function tokensOf(meta) {
  const u = meta?.usage || {};
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
}

// Tickets used before this log existed start from the cost of the results they have saved.
async function seed(key) {
  const [jira, figma, check, tests] = await Promise.all(['jira', 'figma', 'check', 'tests/tests'].map((n) => readJson(key, n)));
  const saved = { jira, figma, check, tests };
  const calls = TOKEN_SOURCES.flatMap((source) => {
    const record = saved[source];
    const tokens = tokensOf(record?.ai);
    if (!tokens) return [];
    const at = record.fetchedAt || record.checkedAt || record.generatedAt || null;
    return [{ source, at, tokens, provider: record.ai.provider || null, model: record.ai.model || null, fromSavedResult: true }];
  });
  return { calls };
}

const readLog = async (key) => (await readJson(key, LOG)) || seed(key);

// One write at a time per ticket, so calls finishing together (e.g. Jira and Figma) do not drop each other's entry.
const queues = new Map();
function serial(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

/** Adds one AI call to the ticket's log. Never throws: a logging problem must not fail the run itself. */
export function logTokens(key, source, meta, { failed = false } = {}) {
  const tokens = tokensOf(meta);
  if (!key || !tokens) return Promise.resolve();
  return serial(key, async () => {
    const log = await readLog(key);
    log.calls.push({
      source,
      at: new Date().toISOString(),
      tokens,
      provider: meta.provider || null,
      model: meta.model || null,
      ...(failed && { failed: true }),
    });
    await writeJson(key, LOG, log);
  }).catch((err) => console.error(`Could not log tokens for ${key}:`, err.message));
}

/** Totals per source and overall, for the Sources panel. */
export async function tokenTotals(key) {
  const { calls } = await readLog(key);
  const bySource = Object.fromEntries(TOKEN_SOURCES.map((s) => [s, { tokens: 0, calls: 0 }]));
  for (const c of calls) {
    const row = bySource[c.source] || (bySource[c.source] = { tokens: 0, calls: 0 });
    row.tokens += c.tokens;
    row.calls += 1;
  }
  return { bySource, total: calls.reduce((sum, c) => sum + c.tokens, 0), calls: calls.length };
}
