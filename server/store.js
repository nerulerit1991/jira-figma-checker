import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { itemsVerifiedBy } from './checklist.js';

// Each ticket lives in data/<KEY>/ with ticket.json (links), jira.json, figma.json, check.json.
const SAFE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

function ticketDir(key) {
  if (!SAFE_KEY.test(key)) throw new Error(`Invalid ticket key: ${key}`);
  return path.join(DATA_DIR, key);
}

export async function readJson(key, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(ticketDir(key), `${name}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes a temporary file next to `file`, then renames it: readers never see half a file, and a crash keeps the old one. */
export async function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function writeJson(key, name, data) {
  const dir = ticketDir(key);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
  return data;
}

/**
 * Fresh start for a ticket's results after its Jira ticket is retrieved again: removes the test scripts and every test
 * result (ticket and global), the Check UI and interaction-flow results and screenshots, and the improvement suggestions. The ticket's
 * links, Figma data, sign-in settings and token log stay.
 */
export async function resetTicketResults(key) {
  const dir = ticketDir(key);
  const files = ['check.json', 'check-errors.json', 'flow-check.json', 'improvements.json', 'screenshot-desktop.jpg', 'screenshot-tablet.jpg', 'screenshot-mobile.jpg'];
  await Promise.all([
    fs.rm(path.join(dir, 'tests'), { recursive: true, force: true }),
    fs.rm(path.join(dir, 'flow'), { recursive: true, force: true }),
    ...files.map((name) => fs.rm(path.join(dir, name), { force: true })),
  ]);
}

// Whole Figma files downloaded with the Figma API, shared by every ticket, grouped by project:
// data/full-figma/<project>/<fileKey>.json, where <project> is the Figma file's name.
export const FULL_FIGMA_DIR = path.join(DATA_DIR, 'full-figma');
const FILE_KEY = /^[0-9A-Za-z]{10,128}$/;

function projectDir(project) {
  const safe = String(project || '').trim().replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '');
  if (!safe) throw new Error(`Invalid Figma project name: ${project}`);
  return path.join(FULL_FIGMA_DIR, safe);
}

function fullFigmaPath(project, fileKey) {
  if (!FILE_KEY.test(fileKey)) throw new Error(`Invalid Figma file key: ${fileKey}`);
  return path.join(projectDir(project), `${fileKey}.json`);
}

async function fullFigmaEntries() {
  const dirs = await fs.readdir(FULL_FIGMA_DIR, { withFileTypes: true }).catch(() => []);
  const perProject = await Promise.all(
    dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const names = await fs.readdir(path.join(FULL_FIGMA_DIR, d.name)).catch(() => []);
      return names.filter((n) => n.endsWith('.json') && FILE_KEY.test(n.slice(0, -5))).map((n) => ({ project: d.name, fileKey: n.slice(0, -5) }));
    }),
  );
  return perProject.flat();
}

/** A saved file's folder is named after its project, which is only known after reading it: find it by key. */
async function findFullFigmaPath(fileKey) {
  if (!FILE_KEY.test(fileKey)) return null;
  const match = (await fullFigmaEntries()).find((e) => e.fileKey === fileKey);
  return match ? path.join(FULL_FIGMA_DIR, match.project, `${fileKey}.json`) : null;
}

export async function readFullFigma(fileKey) {
  const found = await findFullFigmaPath(fileKey);
  if (!found) return null;
  return JSON.parse(await fs.readFile(found, 'utf8'));
}

/** Saved projects for the "load existing" picker. No file is parsed: whole files reach tens of MB. */
export async function listFullFigmaProjects() {
  const entries = await fullFigmaEntries();
  const withDates = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      savedAt: (await fs.stat(path.join(FULL_FIGMA_DIR, entry.project, `${entry.fileKey}.json`))).mtime.toISOString(),
    })),
  );
  return withDates.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Saved without indentation: whole files can be tens of MB. Returns the path under data/, for the ticket's record.
 * `project` is the folder the user chose at retrieve time; `replace` makes the file the project's only one,
 * dropping the copies it overwrites. Without a project name the folder is the Figma file's name. */
export async function writeFullFigma(fileKey, data, { project, replace } = {}) {
  const file = fullFigmaPath(project || data.fileName || data.file?.name, fileKey);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(data));
  if (replace) {
    const others = (await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.json') && n !== `${fileKey}.json`);
    await Promise.all(others.map((n) => fs.rm(path.join(path.dirname(file), n))));
  }
  return path.relative(DATA_DIR, file).split(path.sep).join('/');
}

/** Where a saved file would live, for the message that tells the user to fetch it first. */
export async function fullFigmaLocation(fileKey) {
  const found = await findFullFigmaPath(fileKey);
  const shown = found ? path.relative(DATA_DIR, found) : `full-figma/<project>/${fileKey}.json`;
  return `data/${shown.split(path.sep).join('/')}`;
}

async function ticketKeys() {
  try {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SAFE_KEY.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Ticket links and timestamps. Folders made before ticket.json existed fall back to jira.json. */
export async function getTicket(key) {
  const meta = await readJson(key, 'ticket');
  if (meta) return meta;
  const jira = await readJson(key, 'jira');
  if (!jira) return null;
  return { key, jiraUrl: jira.url, figmaUrl: '', pageUrl: '', createdAt: jira.fetchedAt, updatedAt: jira.fetchedAt };
}

export async function updateTicket(key, changes) {
  const current = (await getTicket(key)) || { key, createdAt: new Date().toISOString() };
  return writeJson(key, 'ticket', { figmaUrl: '', pageUrl: '', ...current, ...changes, updatedAt: new Date().toISOString() });
}

// The order the tickets were dragged into in the sidebar: data/ticket-order.json, a list of keys.
const ORDER_FILE = path.join(DATA_DIR, 'ticket-order.json');

async function readTicketOrder() {
  try {
    const keys = JSON.parse(await fs.readFile(ORDER_FILE, 'utf8'));
    return Array.isArray(keys) ? keys.filter((key) => SAFE_KEY.test(key)) : [];
  } catch {
    return [];
  }
}

/** Saves the sidebar order. Keys of deleted tickets are dropped; tickets left out keep their default place. */
export async function setTicketOrder(keys) {
  const existing = new Set(await ticketKeys());
  const order = [...new Set(keys)].filter((key) => SAFE_KEY.test(key) && existing.has(key));
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeFileAtomic(ORDER_FILE, JSON.stringify(order, null, 2));
  return order;
}

/**
 * Summary of every ticket for the picker, in the order they were dragged into. Tickets that were never
 * placed (e.g. newly added) come first, most recently updated first.
 */
export async function listTickets() {
  const keys = await ticketKeys();
  const tickets = await Promise.all(
    keys.map(async (key) => {
      const [ticket, jira, figma, check, flow, flowCheck] = await Promise.all([
        getTicket(key),
        readJson(key, 'jira'),
        readJson(key, 'figma'),
        readJson(key, 'check'),
        readJson(key, 'flow'),
        readJson(key, 'flow-check'),
      ]);
      // Same score as the ticket's Checklist: only items the live check verifies (older checks judged them all).
      // With the interaction flow on, items on its other screens (Playwright items too) come from flow-check.json.
      const assigned = flow?.screens?.length > 1 ? flow.checklistScreens?.assignments || {} : {};
      const onFlowScreen = (id) => /^S[1-9]/.test(assigned[id] || '');
      const live = new Set(itemsVerifiedBy(jira?.checklist, 'live').map((i) => i.id));
      const flowResults = (flowCheck?.screens || []).flatMap((s) => {
        const screen = flow?.screens?.find((x) => x.id === s.id);
        return screen?.nodeId === s.nodeId ? (s.results || []).filter((r) => assigned[r.id] === s.id) : [];
      });
      const flowItems = (jira?.checklist || []).filter((i) => onFlowScreen(i.id)).map((i) => i.id);
      const results = [
        ...(check?.results || []).filter((r) => (!jira?.checklist || live.has(r.id)) && !onFlowScreen(r.id)),
        ...flowItems.map((id) => flowResults.find((r) => r.id === id) || { id, passed: false }),
      ];
      return {
        key,
        summary: jira?.summary || null,
        status: jira?.status || null,
        hasJira: Boolean(jira),
        hasFigma: Boolean(figma),
        passed: check ? results.filter((r) => r.passed).length : null,
        total: check ? results.length : null,
        updatedAt: [ticket?.updatedAt, jira?.fetchedAt, figma?.fetchedAt, check?.checkedAt, flowCheck?.checkedAt].filter(Boolean).sort().pop() || null,
      };
    }),
  );
  const order = await readTicketOrder();
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : -1);
  return tickets.sort((a, b) => rank(a.key) - rank(b.key) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteTicket(key) {
  await fs.rm(ticketDir(key), { recursive: true, force: true });
}

/** Returns the project folders removed. */
export async function deleteAllFullFigma() {
  const dirs = await fs.readdir(FULL_FIGMA_DIR, { withFileTypes: true }).catch(() => []);
  const projects = dirs.filter((d) => d.isDirectory()).map((d) => d.name);
  await Promise.all(projects.map((p) => fs.rm(path.join(FULL_FIGMA_DIR, p), { recursive: true, force: true })));
  return projects;
}

export async function deleteAllTickets() {
  const keys = await ticketKeys();
  await Promise.all(keys.map(deleteTicket));
  return keys;
}

/** Extracts the issue key (e.g. ABC-123) from a Jira URL or a bare key. */
export function parseJiraKey(input) {
  const text = String(input || '').trim();
  const match =
    text.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/i) ||
    text.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i) ||
    text.match(/^([A-Z][A-Z0-9_]*-\d+)$/i);
  return match ? match[1].toUpperCase() : null;
}
