import { fetchJiraIssue, jiraApiEnabled } from './jiraApi.js';
import { fetchFigmaFile, frameFromFile, listFrames, figmaApiEnabled, figmaApiBlockedUntil } from './figmaApi.js';
import express from 'express';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { runAgentJson, getMcpStatus } from './ai.js';
import { tokenTotals } from './tokenLog.js';
import { setAgentProvider, getAgentProvider } from './agentSettings.js';
import { getAgentUsage } from './agentUsage.js';
import { readCodexAccount } from './codexAccount.js';
import { getLoginSettings, saveLoginSettings, enableEnvLogin, removeLoginSettings, performLogin, prepareSession, forgetSession, answerChallenge } from './login.js';
import {
  readJson,
  writeJson,
  listTickets,
  setTicketOrder,
  getTicket,
  updateTicket,
  deleteTicket,
  deleteAllTickets,
  deleteAllFullFigma,
  parseJiraKey,
  readFullFigma,
  writeFullFigma,
  listFullFigmaProjects,
  fullFigmaLocation,
  resetTicketResults,
} from './store.js';
import { jiraPrompt, jiraChecklistPrompt, figmaPrompt, figmaBridgePrompt, checkPrompt, recheckPrompt, improvementsPrompt, flowScreenPrompt, flowAssignPrompt } from './prompts.js';
import { createHash } from 'node:crypto';
import { buildFlowMap, runFlow, flowShotPath, MAX_SCREENS } from './flow.js';
import { checkedScreens, screenState } from './flowScope.js';
import { itemsVerifiedBy, verifyByOf } from './checklist.js';
import { buildCheckErrors, viewportsFor, errorSections, inSections, mergeRecheck } from './checkErrors.js';
import { capturePage, scanForTests, VIEWPORTS } from './capture.js';
import { getViewports, setViewports, loadViewports, isViewportName } from './viewports.js';
import { parseFigmaUrl, withScheme } from './figma.js';
import { fixConnection, getJobs, signOutAll, browserStatus, cancelOtherAgentLogins } from './connections.js';
import { verifyScript, readTests, readGlobalTests, generateTests, runTests, runGlobalTests, rerunFailedTests, sameSite } from './tests.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
// Every change goes through the app's own JSON requests: others (forms, plain-text posts from other sites) are refused,
// and handlers can read req.body fields without checking it exists.
app.use((req, res, next) => {
  // The header itself is checked (req.is() ignores it on bodiless requests such as DELETE); other sites cannot send it
  // without the browser asking this server first, which it never allows.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return res.status(415).json({ error: 'Send requests as JSON (Content-Type: application/json).' });
  }
  req.body ??= {};
  next();
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

function combineAiMeta(...metas) {
  const usage = {};
  for (const meta of metas) {
    for (const [key, value] of Object.entries(meta?.usage || {})) {
      if (typeof value === 'number') usage[key] = (usage[key] || 0) + value;
    }
  }
  const knownCosts = metas.map((meta) => meta?.costUsd).filter((value) => typeof value === 'number');
  return {
    costUsd: knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
    usage,
    toolCalls: metas.flatMap((meta) => meta?.toolCalls || []),
    toolsLoaded: metas.reduce((sum, meta) => sum + (meta?.toolsLoaded || 0), 0),
  };
}

function requireUrl(value, name, hostPattern) {
  let url;
  try {
    url = new URL(withScheme(value));
  } catch {
    throw httpError(400, `${name} must be a valid URL.`);
  }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, `${name} must start with http:// or https://.`);
  if (hostPattern && !hostPattern.test(url.hostname)) throw httpError(400, `${name} does not look like the right site.`);
  return url.toString();
}

function requireKey(value) {
  const key = parseJiraKey(value);
  if (!key) throw httpError(400, 'Could not find a Jira issue key (e.g. ABC-123).');
  return key;
}

// Prevents the same AI job from running twice at once (double clicks, two tabs).
const inFlight = new Map();
function once(id, fn) {
  if (!inFlight.has(id)) inFlight.set(id, fn().finally(() => inFlight.delete(id)));
  return inFlight.get(id);
}

// Generate, run, re-run failed and global run all write data/<KEY>/tests/, so only one runs per ticket at a time:
// the same job started again joins the running one; a different one is refused instead of clobbering its files.
const TEST_JOBS = { generate: 'Generating tests', run: 'A test run', rerun: 'Re-running failed tests', global: 'A global test run' };
function testsJob(key, kind, fn) {
  const running = Object.keys(TEST_JOBS).find((other) => other !== kind && inFlight.has(`tests-${other}:${key}`));
  if (running) throw httpError(409, `${TEST_JOBS[running]} is still in progress for ${key}. Try again when it finishes.`);
  return once(`tests-${kind}:${key}`, fn);
}

let statusCache = null;
// The Codex CLI's status output has no email, so ask its app server; the header hides the account when null.
async function codexEmail() {
  if (await getAgentProvider() !== 'codex') return null;
  return await readCodexAccount().then((a) => a.email).catch(() => null);
}
async function getStatus(refresh = false) {
  if (!statusCache || refresh || Date.now() - statusCache.at > 30_000) {
    const [mcp, browser, email] = await Promise.all([getMcpStatus(), browserStatus(), codexEmail()]);
    statusCache = { at: Date.now(), value: { ...mcp, account: { ...mcp.account, email: mcp.account?.email || email }, browser: { status: browser }, figmaApi: figmaApiEnabled(), figmaApiToken: Boolean(process.env.FIGMA_TOKEN), figmaApiBlockedUntil: figmaApiBlockedUntil() } };
  }
  return { ...statusCache.value, checkedAt: new Date(statusCache.at).toISOString() };
}

/** Returns the connected MCP server for "jira" or "figma" plus every other server, or throws. */
async function connectedServer(kind) {
  const status = await getStatus();
  const server = status[kind] || { status: 'not-configured' };
  if (!['connected', 'configured'].includes(server.status)) {
    const label = { jira: 'Jira', figma: 'Figma', figmaBridge: 'Figma desktop bridge' }[kind] || kind;
    const hint = status.provider === 'codex'
      ? `Click Reconnect to authorize the ${label} MCP server in Codex.`
      : kind === 'figmaBridge'
        ? 'Open the Figma desktop app and run the bridge plugin, or use the Figma MCP or API tab.'
      : kind === 'jira'
          ? 'Click Reconnect to authorize the local Atlassian MCP, or use the Jira API tab.'
          : 'Click Reconnect to authorize the local Figma MCP, or use the Desktop bridge or Figma API tab.';
    throw httpError(409, `${label} MCP is not connected (${server.status}). ${hint}`);
  }
  return { server: server.name, otherServers: status.all.map((s) => s.name).filter((n) => n !== server.name) };
}

// Remaining plan allowance of the selected agent (percent used per window and reset time). No tokens.
let usageCache = null;
app.get('/api/agent-usage', async (req, res) => {
  const provider = await getAgentProvider();
  if (!usageCache || usageCache.provider !== provider || req.query.refresh || Date.now() - usageCache.at > 60_000) {
    usageCache = { provider, at: Date.now(), value: await getAgentUsage(provider) };
  }
  res.json(usageCache.value);
});

app.get('/api/status', async (req, res) => {
  res.json(await getStatus(Boolean(req.query.refresh)));
});

app.post('/api/settings/agent', async (req, res) => {
  const provider = await setAgentProvider(req.body?.provider);
  cancelOtherAgentLogins(provider);
  statusCache = null;
  res.json({ provider });
});

// Viewports the responsive check renders every page at (shared by all tickets; used from the next check on).
app.get('/api/settings/viewports', (req, res) => {
  res.json({ viewports: getViewports() });
});

app.put('/api/settings/viewports', async (req, res) => {
  if (inFlight.size) throw httpError(409, 'A retrieve or check is still running. Change viewports when it finishes.');
  res.json({ viewports: await setViewports(req.body?.viewports) });
});

// ---- One-click connection fixes ----

app.post('/api/connections/:target/fix', async (req, res) => {
  const result = await fixConnection(req.params.target, await getStatus(true));
  statusCache = null;
  res.json(result);
});

app.post('/api/connections/sign-out-all', (_req, res, next) => {
  try {
    res.json(signOutAll());
    statusCache = null;
  } catch (error) {
    next(error);
  }
});

app.get('/api/connections/jobs', async (_req, res) => {
  res.json(await getJobs());
});

// ---- Tickets (one folder per ticket under data/) ----

app.get('/api/tickets', async (_req, res) => {
  res.json(await listTickets());
});

// Saves the order the tickets were dragged into in the sidebar.
app.put('/api/tickets/order', async (req, res) => {
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) throw httpError(400, 'Send the ticket keys as a list.');
  res.json({ order: await setTicketOrder(keys) });
});

app.post('/api/tickets', async (req, res) => {
  const jiraUrl = requireUrl(req.body.jiraUrl, 'Jira link');
  const key = requireKey(jiraUrl);

  const existing = await getTicket(key);
  // Adding a ticket that already exists just opens it; its links are edited on the ticket itself.
  if (existing) return res.json({ existed: true, ticket: existing });
  res.status(201).json({ existed: false, ticket: await updateTicket(key, { key, jiraUrl }) });
});

async function requireTicket(rawKey) {
  const key = requireKey(rawKey);
  const ticket = await getTicket(key);
  if (!ticket) throw httpError(404, `Ticket ${key} not found.`);
  return ticket;
}

app.get('/api/tickets/:key', async (req, res) => {
  const ticket = await requireTicket(req.params.key);
  const [jira, figma, check, savedErrors, improvements, flow, flowCheck, tests, globalTests, login] = await Promise.all([
    ...['jira', 'figma', 'check', 'check-errors', 'improvements', 'flow', 'flow-check'].map((n) => readJson(ticket.key, n)),
    readTests(ticket.key),
    readGlobalTests(ticket.key),
    getLoginSettings(ticket.key),
  ]);
  // Whether the Figma API tab already has this ticket's whole file on disk, for its status line.
  const fileKey = parseFigmaUrl(ticket.figmaUrl)?.fileKey || figma?.fileKey;
  const figmaSaved = fileKey ? (await listFullFigmaProjects()).find((p) => p.fileKey === fileKey) || null : null;
  // Checks saved before check-errors.json existed get their errors built on the fly.
  // Rebuilt from the check so items the Jira step now gives to Playwright or marks not testable drop out.
  const checkErrors = check ? buildCheckErrors(check, jira?.checklist) : savedErrors;
  // Tickets whose frame was picked before the flow existed get their map once (no tokens; reads the saved file).
  const flowMap = flow || (figma?.via === 'api' ? (await currentFlowMap(ticket).catch(() => null))?.map || null : null);
  res.json({ ticket, jira, figma, check, checkErrors, improvements, flow: flowMap, flowCheck, tests, globalTests, figmaSaved, login, tokens: await tokenTotals(ticket.key) });
});

// Tokens used by every AI call on this ticket, including re-fetches whose results were replaced.
app.get('/api/tickets/:key/tokens', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  res.json(await tokenTotals(key));
});

// Saves the Figma / page links typed for a ticket.
app.patch('/api/tickets/:key', async (req, res) => {
  const ticket = await requireTicket(req.params.key);
  const changes = {};
  for (const field of ['figmaUrl', 'pageUrl']) {
    if (typeof req.body[field] === 'string') changes[field] = req.body[field].trim().slice(0, 2000);
  }
  res.json(await updateTicket(ticket.key, changes));
});

const isBusy = (key) => [...inFlight.keys()].some((id) => id.endsWith(`:${key}`));

app.delete('/api/tickets/:key', async (req, res) => {
  const ticket = await requireTicket(req.params.key);
  if (isBusy(ticket.key)) throw httpError(409, `${ticket.key} is still being processed. Try again when it finishes.`);
  await deleteTicket(ticket.key);
  res.json({ deleted: [ticket.key] });
});

app.delete('/api/tickets', async (_req, res) => {
  if (inFlight.size) throw httpError(409, 'A retrieve or check is still running. Try again when it finishes.');
  const [deleted, fullFigmaProjects] = await Promise.all([deleteAllTickets(), deleteAllFullFigma()]);
  // Every saved whole file is gone too, so a later retrieve must re-download from the Figma API.
  res.json({ deleted, fullFigmaProjects });
});

app.get('/api/tickets/:key/screenshot/:viewport', async (req, res) => {
  const key = requireKey(req.params.key);
  if (!isViewportName(req.params.viewport)) throw httpError(404, 'Unknown viewport.');
  res.sendFile(path.join(DATA_DIR, key, `screenshot-${req.params.viewport}.jpg`), (err) => err && res.status(404).end());
});

// ---- AI jobs ----

/** The Figma frame's width; older figma.json files only mention it in the summary ("1366px wide"). */
function figmaFrameWidth(figma) {
  if (figma?.frameWidth) return figma.frameWidth;
  const m = `${figma?.summary ?? ''} ${figma?.layout ?? ''}`.match(/\b(\d{3,4})\s*px\s+wide/i);
  return m ? Number(m[1]) : null;
}

/** Live viewport to compare with a Figma frame of the given width. */
function viewportFor(frameWidth) {
  if (!frameWidth) return 'desktop';
  return VIEWPORTS.reduce((best, v) => (Math.abs(v.width - frameWidth) < Math.abs(best.width - frameWidth) ? v : best)).name;
}

app.post('/api/tickets/:key/jira', async (req, res) => {
  const { key, jiraUrl } = await requireTicket(req.params.key);
  const cached = await readJson(key, 'jira');
  if (cached && !req.body.force) return res.json({ cached: true, data: cached });

  // `reset`: the person confirmed a fresh start, so the old checklist's tests and results are removed once the new
  // ticket data is saved (a failed retrieve leaves everything as it was).
  const data = await once(`jira:${key}`, async () => {
    const jira = await retrieveJira();
    if (req.body.reset) await resetTicketResults(key);
    return jira;
  });
  res.json({ cached: false, data, reset: Boolean(req.body.reset) });

  async function retrieveJira() {
    // Jira API tab: fetch the issue directly (free), then one small AI call with no tools builds the checklist.
    if (req.body.via === 'api') {
      if (!jiraApiEnabled()) {
        throw httpError(400, 'Jira API is not set up. Add JIRA_EMAIL and JIRA_API_TOKEN to .env and restart the app, or use the Jira MCP tab.');
      }
      const { acceptanceText, ...issue } = await fetchJiraIssue(jiraUrl, key);
      const { data, meta } = await runAgentJson({ ...jiraChecklistPrompt({ ...issue, acceptanceText }), track: { key, source: 'jira' } });
      return writeJson(key, 'jira', {
        ...issue,
        acceptanceCriteria: data.acceptanceCriteria || [],
        checklist: data.checklist || [],
        url: jiraUrl,
        mcpServer: 'Jira API',
        via: 'api',
        fetchedAt: new Date().toISOString(),
        ai: meta,
      });
    }
    const { server, otherServers } = await connectedServer('jira');
    const { data: issue, meta: retrievalMeta } = await runAgentJson({ ...jiraPrompt(jiraUrl, key, server), mcpServers: [server], otherServers, light: true, track: { key, source: 'jira' } });
    const { data: checklist, meta: checklistMeta } = await runAgentJson({
      ...jiraChecklistPrompt({
        key,
        summary: issue.summary || '',
        description: issue.description || '',
        acceptanceText: issue.acceptanceText || issue.acceptanceCriteria?.join('\n') || '',
      }),
      track: { key, source: 'jira' },
    });
    return writeJson(key, 'jira', {
      ...issue,
      key,
      url: jiraUrl,
      acceptanceCriteria: checklist.acceptanceCriteria || [],
      checklist: checklist.checklist || [],
      mcpServer: server,
      via: 'mcp',
      fetchedAt: new Date().toISOString(),
      ai: combineAiMeta(retrievalMeta, checklistMeta),
    });
  }
});

// Where saved Figma data came from; older files have no "via".
const figmaViaOf = (saved) => saved?.via || (saved?.ai?.source === 'figma-api' ? 'api' : 'mcp');

// Reads Figma from exactly one source, picked by the tab in the UI. There is no fallback between them,
// so each source's own error is shown: "mcp" (local Figma MCP), "bridge" (Figma desktop app)
// or "api" (Figma REST API with FIGMA_TOKEN).
app.post('/api/tickets/:key/figma', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  const via = req.body.via === 'bridge' || req.body.via === 'api' ? req.body.via : 'mcp';

  // Desktop bridge: reads the frame selected in the Figma desktop app, so no link is needed.
  if (via === 'bridge') {
    const data = await once(`figma:${key}`, async () => {
      const { server, otherServers } = await connectedServer('figmaBridge');
      const { data, meta } = await runAgentJson({ ...figmaBridgePrompt(server), mcpServers: [server], otherServers, light: true, track: { key, source: 'figma' } });
      if (!data?.specs?.length && !data?.typography?.length) {
        throw httpError(502, `Figma desktop (bridge) returned no design data. ${String(data?.summary || '').slice(0, 200)} ` +
          'Select the frame in the Figma desktop app with the bridge plugin running, then try again. Nothing was saved, so your existing Figma data is unchanged.');
      }
      // Keep a link to the selected frame so the MCP / API tabs and later re-fetches can target it.
      const nodeId = /^\d+:\d+$/.test(data.nodeId || '') ? data.nodeId : null;
      const fileKey = /^[0-9a-zA-Z]{10,128}$/.test(data.fileKey || '') ? data.fileKey : null;
      const url = fileKey ? `https://www.figma.com/design/${fileKey}/${nodeId ? `?node-id=${nodeId.replace(':', '-')}` : ''}` : null;
      return writeJson(key, 'figma', {
        ...data,
        url,
        sourceUrl: url,
        fileKey,
        nodeId,
        mcpServer: server,
        via: 'bridge',
        fetchedAt: new Date().toISOString(),
        ai: meta,
      });
    });
    return res.json({ cached: false, data });
  }

  const jira = await readJson(key, 'jira');
  const rawUrl = req.body.url || jira?.figmaLinks?.[0];
  if (!rawUrl) throw httpError(400, 'No Figma link given and none found in the Jira ticket. Paste a Figma link first.');
  const figmaLink = parseFigmaUrl(rawUrl);
  if (!figmaLink) throw httpError(400, 'Not a Figma file, prototype or embed link. Copy the link from Figma (Share → Copy link).');
  const { url } = figmaLink;
  await updateTicket(key, { figmaUrl: rawUrl });

  // Design and prototype links to the same frame, read the same way, share one cache entry.
  const cached = await readJson(key, 'figma');
  if (cached && cached.url === url && figmaViaOf(cached) === via && !req.body.force) return res.json({ cached: true, data: cached });

  // Figma API: the whole file is downloaded once into data/full-figma/<project>/<fileKey>.json and shared by
  // every ticket; this ticket's figma.json holds the linked frame from it. Exact values, no AI tokens.
  // The retrieve dialog decides the folder: confirming an existing project replaces its saved file(s);
  // redownload=false reuses the file already on disk for this link instead of calling the API again.
  if (via === 'api') {
    const data = await once(`figma:${key}`, async () => {
      const { fileKey, nodeId } = figmaLink;
      let full = req.body.redownload === false ? await readFullFigma(fileKey) : null;
      const reused = Boolean(full);
      let savedPath = await fullFigmaLocation(fileKey);
      if (!full) {
        const { file, version } = await fetchFigmaFile(fileKey);
        full = { fileKey, fileName: file.name, url: `https://www.figma.com/design/${fileKey}/`, fetchedAt: new Date().toISOString(), version, file };
        savedPath = await writeFullFigma(fileKey, full, { project: req.body.project, replace: req.body.overwrite === true });
      }
      const saved = await writeJson(key, 'figma', {
        ...frameFromFile(full, nodeId),
        url,
        sourceUrl: rawUrl,
        fileKey,
        mcpServer: 'Figma API',
        via: 'api',
        fullFile: { path: savedPath, fetchedAt: full.fetchedAt, reused },
        fetchedAt: new Date().toISOString(),
        ai: { costUsd: 0, usage: {}, source: 'figma-api' },
      });
      return saved;
    });
    // The frame's prototype links, mapped now so the flow chart shows straight away (no tokens).
    const flow = (await currentFlowMap({ key }).catch(() => null))?.map || null;
    return res.json({ cached: false, data, flow });
  }

  // MCP: the selected agent's local Figma MCP, via AI.
  const data = await once(`figma:${key}`, async () => {
    const { server, otherServers } = await connectedServer('figma');
    const { data, meta } = await runAgentJson({ ...figmaPrompt(figmaLink, server), mcpServers: [server], otherServers, light: true, track: { key, source: 'figma' } });
    // An empty result (e.g. the connector is rate-limited) must not replace design data that is already saved.
    if (!data?.specs?.length && !data?.typography?.length) {
      const said = `${data?.summary || ''} ${(data?.notes || []).join(' ')}`;
      const message = /limit|rate|quota|seat/i.test(said)
        ? 'Figma MCP limit reached for your Figma account, so no design data came back. ' +
          'Figma has not said when this limit resets; a Dev or Full Figma seat has much higher limits. Try the Desktop bridge or Figma API tab.'
        : `The Figma MCP returned no design data. ${String(data?.summary || '').slice(0, 200)} Check the link points at a frame you can open in Figma.`;
      throw httpError(502, `${message} Nothing was saved, so your existing Figma data is unchanged.`);
    }
    return writeJson(key, 'figma', {
      ...data,
      url,
      sourceUrl: rawUrl,
      fileKey: figmaLink.fileKey,
      nodeId: figmaLink.nodeId,
      mcpServer: server,
      via: 'mcp',
      fetchedAt: new Date().toISOString(),
      ai: meta,
    });
  });
  res.json({ cached: false, data });
});

/**
 * A whole Figma file saved by the Figma API tab: the one for this ticket's link, or `wantedKey` when the
 * user picked a saved project instead. 409 explains how to get one.
 */
async function requireFullFigma(ticket, wantedKey) {
  const figma = await readJson(ticket.key, 'figma');
  if (wantedKey && !/^[0-9A-Za-z]{10,128}$/.test(wantedKey)) throw httpError(400, 'That saved Figma file is not a valid file key.');
  const fileKey = wantedKey || parseFigmaUrl(ticket.figmaUrl)?.fileKey || figma?.fileKey;
  if (!fileKey) throw httpError(400, 'No Figma link for this ticket. Paste the Figma URL in the Figma API tab, then click Retrieve Figma.');
  const full = await readFullFigma(fileKey);
  if (!full) throw httpError(409, `The whole Figma file is not saved yet (${await fullFigmaLocation(fileKey)}). Click Retrieve Figma on the Figma API tab to download it, or pick a saved project.`);
  return { full, fileKey, figma };
}

// Every whole Figma file saved so far, grouped by project folder, for the "load existing" picker.
app.get('/api/full-figma', async (req, res) => {
  res.json({ projects: await listFullFigmaProjects() });
});

// Frames in a saved Figma file, so Check UI can ask which one to compare. No Figma API call.
app.get('/api/tickets/:key/figma/frames', async (req, res) => {
  const { full, fileKey, figma } = await requireFullFigma(await requireTicket(req.params.key), req.query.fileKey);
  const frames = listFrames(full.file);
  if (!frames.length) throw httpError(404, `The saved Figma file "${full.file.name}" has no frames to check.`);
  res.json({ fileKey, fileName: full.file.name, fetchedAt: full.fetchedAt, current: figma?.via === 'api' && figma.fileKey === fileKey ? figma.nodeId : null, frames });
});

// Makes the chosen frame this ticket's figma.json, read from the saved file. No Figma API call, no tokens.
// A fileKey other than the ticket's link switches the ticket onto that saved project.
app.post('/api/tickets/:key/figma/frame', async (req, res) => {
  const ticket = await requireTicket(req.params.key);
  const nodeId = String(req.body.nodeId || '');
  if (!/^[\w:;-]{1,200}$/.test(nodeId)) throw httpError(400, 'Choose a Figma frame to check.');
  const { full, fileKey } = await requireFullFigma(ticket, req.body.fileKey);
  const frameUrl = `https://www.figma.com/design/${fileKey}/?node-id=${nodeId.replace(':', '-')}`;
  const savedPath = await fullFigmaLocation(fileKey);
  // Point the ticket at the file it now uses, so later fetches and checks resolve to the same project.
  if (parseFigmaUrl(ticket.figmaUrl)?.fileKey !== fileKey) await updateTicket(ticket.key, { figmaUrl: frameUrl });
  const data = await once(`figma:${ticket.key}`, () =>
    writeJson(ticket.key, 'figma', {
      ...frameFromFile(full, nodeId),
      url: frameUrl,
      sourceUrl: ticket.figmaUrl,
      fileKey,
      mcpServer: 'Figma API',
      via: 'api',
      fullFile: { path: savedPath, fetchedAt: full.fetchedAt, reused: true },
      fetchedAt: new Date().toISOString(),
      ai: { costUsd: 0, usage: {}, source: 'figma-api' },
    }),
  );
  const flow = (await currentFlowMap(ticket).catch(() => null))?.map || null;
  res.json({ data, flow });
});

app.post('/api/tickets/:key/check', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url, 'Page URL');
  await updateTicket(key, { pageUrl: req.body.url });
  const jira = await readJson(key, 'jira');
  if (!jira?.checklist?.length) throw httpError(400, 'Retrieve the Jira ticket first; it has no checklist yet.');
  const saved = await readJson(key, 'figma');
  // Figma data without any specs (an empty fetch) cannot be compared; check against Jira only.
  const figma = saved?.specs?.length || saved?.typography?.length ? saved : null;

  const data = await once(`check:${key}`, async () => {
    const started = Date.now();
    // With the interaction flow on, items about other screens are judged there; this check takes the starting screen's.
    const flow = await activeFlow({ key });
    const assigned = flow ? await checklistScreens({ key }, flow, jira) : null;
    const checklist = itemsVerifiedBy(jira.checklist, 'live').filter((i) => !assigned || (assigned[i.id] || 'S0') === 'S0');
    const frameWidth = figmaFrameWidth(figma);
    const compareViewport = viewportFor(frameWidth);
    // A desktop design is captured at exactly its frame width, so x positions need no scaling.
    const desktopWidth = compareViewport === 'desktop' && frameWidth >= 1024 && frameWidth <= 2560 ? frameWidth : undefined;
    const page = await capturePage(url, path.join(DATA_DIR, key), { desktopWidth, storageState: await prepareSession(key, url) });
    const { ai, ...figmaData } = figma || {};
    const { data, meta } = await runAgentJson({
      ...checkPrompt({ url, checklist, figma: figma && { ...figmaData, frameWidth }, page, compareViewport }),
      images: page.viewports.flatMap((v) => v.tiles.map((t) => ({ mediaType: 'image/jpeg', base64: t.base64 }))),
      otherServers: (await getStatus()).all.map((s) => s.name),
      track: { key, source: 'check' },
    });
    const check = await writeJson(key, 'check', {
      ...data,
      url,
      screenshots: page.viewports.map((v) => ({ viewport: v.name, width: v.width, pageHeight: v.pageHeight })),
      layoutScan: Object.fromEntries(page.viewports.map((v) => [v.name, v.layout])),
      warning: page.warning,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ai: meta,
    });
    return { check, errors: await writeJson(key, 'check-errors', buildCheckErrors(check, jira.checklist)) };
  });
  // The flow map too: this check may have just split the checklist across its screens.
  res.json({ data: data.check, errors: data.errors, flow: await readJson(key, 'flow') });
});

// Re-checks only the errors of the last check (check-errors.json): renders just the viewports they need and sends
// just those items with the matching sections of Figma and the page. Passing items are kept as they were.
app.post('/api/tickets/:key/check/recheck', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || pageUrl, 'Page URL');
  const check = await readJson(key, 'check');
  if (!check) throw httpError(400, 'Run Check UI first; there is no previous check to re-check.');
  const jira = await readJson(key, 'jira');
  // Built from the check, so items the Jira step gives to Playwright or marks not testable are not re-checked here.
  const errors = buildCheckErrors(check, jira?.checklist);
  if (!errors.count && !errors.designRows.length) throw httpError(400, 'The last check has no errors to re-check.');
  const saved = await readJson(key, 'figma');
  const figma = saved?.specs?.length || saved?.typography?.length ? saved : null;

  const data = await once(`check:${key}`, async () => {
    const started = Date.now();
    const frameWidth = figmaFrameWidth(figma);
    const compareViewport = errors.compareViewport || viewportFor(frameWidth);
    const desktopWidth = compareViewport === 'desktop' && frameWidth >= 1024 && frameWidth <= 2560 ? frameWidth : undefined;
    const page = await capturePage(url, path.join(DATA_DIR, key), { desktopWidth, only: viewportsFor(errors, compareViewport), storageState: await prepareSession(key, url) });

    // Only the Figma and live-style entries for the sections the errors name.
    const sections = errorSections(errors);
    const failedCategories = new Set(errors.design.map((c) => c.category));
    const figmaSlice = figma && {
      frameWidth,
      specs: inSections(figma.specs, sections),
      ...(failedCategories.has('Typography') && { typography: figma.typography }),
      ...(failedCategories.has('Colors') && { colors: figma.colors }),
      ...(failedCategories.has('Copy') && { texts: figma.texts }),
    };
    for (const v of page.viewports) v.styles = inSections(v.styles, sections);

    const { data, meta } = await runAgentJson({
      ...recheckPrompt({ url, errors, figma: figmaSlice, page, compareViewport }),
      images: page.viewports.flatMap((v) => v.tiles.map((t) => ({ mediaType: 'image/jpeg', base64: t.base64 }))),
      otherServers: (await getStatus()).all.map((s) => s.name),
      track: { key, source: 'check' },
    });
    const merged = await writeJson(key, 'check', {
      ...mergeRecheck(check, data, page),
      url,
      recheckedAt: new Date().toISOString(),
      recheckDurationMs: Date.now() - started,
      recheckedItems: errors.count,
      ai: meta,
    });
    return { check: merged, errors: await writeJson(key, 'check-errors', buildCheckErrors(merged, jira?.checklist)) };
  });
  res.json({ data: data.check, errors: data.errors });
});

// ---- Interaction flow: pages and modals reached by clicking from the ticket's frame (see flow.js) ----

/**
 * The flow map for the ticket's current Figma frame. Rebuilt (keeping the person's on/off choices) when the frame
 * changed or Figma was re-fetched since it was mapped, or when `rebuild` is set. Reads only the saved file.
 */
async function currentFlowMap(ticket, { rebuild = false } = {}) {
  const figma = await readJson(ticket.key, 'figma');
  if (figma?.via !== 'api' || !figma.nodeId) {
    throw httpError(400, 'The interaction flow follows the prototype links in the whole Figma file, so it needs the Figma API tab: retrieve the frame there first.');
  }
  const full = await readFullFigma(figma.fileKey);
  if (!full) throw httpError(409, `The whole Figma file is not saved yet (${await fullFigmaLocation(figma.fileKey)}). Click Retrieve Figma on the Figma API tab.`);
  const saved = await readJson(ticket.key, 'flow');
  const stale = !saved || saved.startNodeId !== figma.nodeId || saved.fileKey !== figma.fileKey || saved.figmaFetchedAt !== full.fetchedAt;
  // The checklist split is kept: its key says whether it still fits the rebuilt screens.
  const map = rebuild || stale ? await writeJson(ticket.key, 'flow', { ...buildFlowMap(full, figma.nodeId, saved), checklistScreens: saved?.checklistScreens }) : saved;
  return { map, full };
}

/** The flow when the ticket's Figma frame (API tab) has prototype links to other screens; null otherwise. */
async function activeFlow(ticket) {
  const flow = await currentFlowMap(ticket).catch(() => null);
  return flow && flow.map.screens.length > 1 ? flow : null;
}

/**
 * Which flow screen each checklist item is about ({ C1: "S0", C14: "S1" }), so the main check judges only the
 * starting screen's items and each flow screen its own. Live items always get a screen; Playwright items (they need a
 * click) get a flow screen when reaching it proves them, else "tests" (left to the functional tests only).
 * One text-only AI call, saved in flow.json and reused until the checklist or the screens change.
 */
async function checklistScreens(ticket, { map, full }, jira) {
  const items = [...itemsVerifiedBy(jira?.checklist, 'live'), ...itemsVerifiedBy(jira?.checklist, 'playwright')]
    .map((i) => ({ id: i.id, item: i.item, category: i.category, verifyBy: verifyByOf(i) }));
  if (!items.length) return {};
  const key = createHash('sha256').update(JSON.stringify([items, map.screens.map((s) => [s.id, s.nodeId])])).digest('hex').slice(0, 16);
  if (map.checklistScreens?.key === key) return map.checklistScreens.assignments;
  const screens = map.screens.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind === 'start' ? 'page (start)' : s.kind === 'overlay' ? 'modal' : 'page',
    path: s.steps.map((step) => `click "${step.text}"`).join(' → ') || null,
    texts: frameFromFile(full, s.nodeId).texts.slice(0, 40),
  }));
  const { data } = await runAgentJson({ ...flowAssignPrompt({ items, screens }), track: { key: ticket.key, source: 'check' } });
  const ids = new Set(map.screens.map((s) => s.id));
  const assignments = Object.fromEntries(items.map((i) => {
    const screen = (data.assignments || []).find((a) => a.id === i.id)?.screen;
    if (i.verifyBy === 'playwright') return [i.id, ids.has(screen) && screen !== 'S0' ? screen : 'tests'];
    return [i.id, ids.has(screen) ? screen : 'S0'];
  }));
  await writeJson(ticket.key, 'flow', { ...map, checklistScreens: { key, assignments, at: new Date().toISOString() } });
  map.checklistScreens = { key, assignments };
  return assignments;
}

// Allows (or stops) the clicks to a screen behind a click that may change data: { allowRisky: { [screenId]: boolean } }.
// Every other screen needs no setting: it is checked when the Jira checklist has items about it (flowScope.js).
app.patch('/api/tickets/:key/flow', async (req, res) => {
  const ticket = await requireTicket(req.params.key);
  const { map } = await currentFlowMap(ticket);
  for (const [id, on] of Object.entries(req.body.allowRisky || {})) {
    const screen = map.screens.find((s) => s.id === id && s.risky);
    if (screen && typeof on === 'boolean') screen.allowRisky = on;
  }
  res.json(await writeJson(ticket.key, 'flow', map));
});

app.post('/api/tickets/:key/flow/check', async (req, res) => {
  const ticket = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || ticket.pageUrl, 'Page URL');
  const { map, full } = await currentFlowMap(ticket);
  if (map.screens.length < 2) throw httpError(400, `"${map.startName}" has no prototype links to another frame or overlay in Figma, so there is nothing to follow.`);
  const jira = await readJson(ticket.key, 'jira');
  const data = await once(`flow:${ticket.key}`, async () => {
    const started = Date.now();
    const metas = [];
    const otherServers = (await getStatus()).all.map((s) => s.name);
    const assigned = await checklistScreens(ticket, { map, full }, jira);
    if (!checkedScreens(map).length) {
      throw httpError(400, map.screens.some((s) => screenState(map, s) === 'risky')
        ? 'The screens this ticket is about are behind a click that may change data. Allow them in Interaction flow to check them.'
        : 'None of the Jira checklist items are about the screens this frame leads to, so there is nothing to follow.');
    }
    const screens = await runFlow({
      itemsFor: (screen) => (jira?.checklist || []).filter((i) => assigned[i.id] === screen.id).map(({ id, item, category }) => ({ id, item, category })),
      map,
      full,
      startUrl: url,
      ticketDir: path.join(DATA_DIR, ticket.key),
      storageState: await prepareSession(ticket.key, url),
      compare: async (screen, figma, capture, checklist) => {
        const result = await runAgentJson({
          ...flowScreenPrompt({ url, screen, figma, capture, checklist }),
          images: [capture.compare, ...capture.others].flatMap((c) => c.tiles.map((t) => ({ mediaType: 'image/jpeg', base64: t.base64 }))),
          otherServers,
          track: { key: ticket.key, source: 'check' },
        });
        metas.push(result.meta);
        return result;
      },
    });
    return writeJson(ticket.key, 'flow-check', {
      url,
      startName: map.startName,
      screens,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ai: combineAiMeta(...metas),
    });
  });
  // With the flow map, whose checklist split the screens' tabs follow.
  res.json({ ...data, flow: await readJson(ticket.key, 'flow') });
});

app.get('/api/tickets/:key/flow/screenshot/:id/:viewport', async (req, res) => {
  const key = requireKey(req.params.key);
  const { id, viewport } = req.params;
  if (!/^S[1-9]\d?$/.test(id) || Number(id.slice(1)) > MAX_SCREENS) throw httpError(404, 'Unknown screen.');
  if (!isViewportName(viewport)) throw httpError(404, 'Unknown viewport.');
  res.sendFile(flowShotPath(path.join(DATA_DIR, key), id, viewport), (err) => err && res.status(404).end());
});

// ---- Optional login for pages behind a sign-in (password never sent back) ----

app.get('/api/tickets/:key/login', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  res.json(await getLoginSettings(key));
});

// { useEnv: true } turns on the .env test account ("Requires login"); otherwise saves this ticket's own account.
app.put('/api/tickets/:key/login', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  res.json(req.body?.useEnv ? await enableEnvLogin(key) : await saveLoginSettings(key, req.body || {}));
});

app.delete('/api/tickets/:key/login', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  await removeLoginSettings(key);
  res.json(await getLoginSettings(key));
});

// Forgets the saved session; the next run signs in again. The login settings stay.
app.delete('/api/tickets/:key/login/session', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  res.json(await forgetSession(key));
});

// The OTP or CAPTCHA the person typed for the sign-in step waiting on this ticket; { value: null } cancels it.
app.post('/api/tickets/:key/login/challenge', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  answerChallenge(key, String(req.body?.id || ''), req.body?.value ?? null);
  res.json(await getLoginSettings(key));
});

// Signs in once to test the settings (a site with an OTP or CAPTCHA asks for it in the app). No AI, no tokens.
app.post('/api/tickets/:key/login/test', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  await once(`login:${key}`, () => performLogin(key, pageUrl));
  res.json(await getLoginSettings(key));
});

// ---- Functional & API tests (scripts saved in data/<KEY>/tests/) ----

// AI writes the scripts once (uses tokens).
app.post('/api/tickets/:key/tests/generate', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || pageUrl, 'Page URL');
  if (req.body.url) await updateTicket(key, { pageUrl: req.body.url });
  const jira = await readJson(key, 'jira');
  if (!jira) throw httpError(400, 'Retrieve the Jira ticket first.');
  res.json(await testsJob(key, 'generate', () => generateTests(key, url, jira)));
});

// Runs the saved scripts locally (no tokens).
app.post('/api/tickets/:key/tests/run', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || pageUrl, 'Page URL');
  res.json(await testsJob(key, 'run', () => runTests(key, url)));
});

// A person marks a generated script as reviewed; only verified scripts run. `hash` is the version they read.
app.post('/api/tickets/:key/tests/verify', async (req, res) => {
  const { key } = await requireTicket(req.params.key);
  const { file, hash, verified } = req.body || {};
  if (typeof file !== 'string' || !/^[a-z0-9-]+\.spec\.js$/.test(file)) throw httpError(400, 'Choose a script to verify.');
  if (verified && (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) throw httpError(400, 'Missing the reviewed script version.');
  // Not joined with other jobs (two clicks on different scripts are two changes); only refused while scripts are rewritten.
  if (inFlight.has(`tests-generate:${key}`)) throw httpError(409, `${TEST_JOBS.generate} is still in progress for ${key}. Try again when it finishes.`);
  res.json(await verifyScript(key, file, hash, Boolean(verified)));
});

// Re-runs only the failed ticket and global tests from the last run. No AI, no tokens.
app.post('/api/tickets/:key/tests/rerun-failed', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || pageUrl, 'Page URL');
  res.json(await testsJob(key, 'rerun', () => rerunFailedTests(key, url)));
});

app.post('/api/tickets/:key/global-tests/run', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || pageUrl, 'Page URL');
  if (req.body.url) await updateTicket(key, { pageUrl: req.body.url });
  res.json(await testsJob(key, 'global', () => runGlobalTests(key, url)));
});

// ---- What can be improved? (advice beyond the acceptance criteria; never changes a score) ----

// AI reads the ticket and a text scan of the live page (no screenshots) and lists gaps, loopholes and improvements.
app.post('/api/tickets/:key/improvements', async (req, res) => {
  const { key, pageUrl } = await requireTicket(req.params.key);
  const url = requireUrl(req.body.url || pageUrl, 'Page URL');
  if (req.body.url) await updateTicket(key, { pageUrl: req.body.url });
  const jira = await readJson(key, 'jira');
  if (!jira) throw httpError(400, 'Retrieve the Jira ticket first.');
  const data = await once(`improvements:${key}`, async () => {
    const started = Date.now();
    const scan = await scanForTests(url, { storageState: await prepareSession(key, url) });
    // Only the site's own requests: third-party hosts (analytics, CDNs) are not this ticket's concern.
    scan.network = scan.network.filter((n) => sameSite(n.url, url));
    const check = await readJson(key, 'check');
    const { data, meta } = await runAgentJson({ ...improvementsPrompt({ jira, url, scan, check }), track: { key, source: 'improvements' } });
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, 12).map((item, i) => ({
      ...item,
      id: `I${i + 1}`,
      severity: ['high', 'medium', 'low'].includes(item.severity) ? item.severity : 'low',
      relatedAc: Array.isArray(item.relatedAc) ? item.relatedAc : [],
    }));
    return writeJson(key, 'improvements', {
      summary: typeof data.summary === 'string' ? data.summary : '',
      items,
      url,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ai: meta,
    });
  });
  res.json({ data });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

await loadViewports();
app.listen(config.port, '127.0.0.1', () => {
  console.log(`API listening on http://127.0.0.1:${config.port}`);
});
