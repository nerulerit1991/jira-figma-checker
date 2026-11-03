import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { getAgentProvider } from './agentSettings.js';

// Env vars set when this server is started from inside another Claude Code session
// (e.g. the desktop app) make the SDK expect host-provided auth and skip your own login.
const HOST_SESSION_VAR = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_)/;
// The .env test account (PROJECT_*) never goes to the agents or MCP servers; tests.js hands it to Playwright only.
const TEST_ACCOUNT_VAR = /^PROJECT_/;
export const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_SESSION_VAR.test(k) && !TEST_ACCOUNT_VAR.test(k)));

const BASE_OPTIONS = {
  cwd: ROOT,
  env: cleanEnv,
  // Load MCP servers from ~/.claude.json and this project's .mcp.json.
  settingSources: ['user', 'project', 'local'],
  // No built-in tools (Bash, Write, ...). The agent only gets MCP tools.
  tools: [],
};

// Only read-style MCP tools are allowed; anything that could create/edit/delete is denied.
const READ_TOOL = /^(get|search|list|fetch|read|lookup|discover|executeRead|atlassianUserInfo)/i;

// Tool names carry a sanitised server name; compare names with punctuation and case removed.
const canon = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function serverOf(toolName) {
  const parts = toolName.split('__');
  return parts.length >= 3 ? parts[1] : null;
}

function readOnlyPolicy(allowedServers) {
  const allowed = new Set(allowedServers.map(canon));
  return async (toolName) => {
    const server = serverOf(toolName);
    const shortName = toolName.split('__').pop();
    if (server && allowed.has(canon(server)) && READ_TOOL.test(shortName)) {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', message: `Tool ${toolName} is not allowed (read-only MCP access only).` };
  };
}

// canUseTool is only asked about tools no settings rule allows already, so allow rules in the user's Claude settings
// would skip it. A PreToolUse hook runs before those rules and applies the same read-only policy to every call.
function readOnlyHook(allowedServers) {
  const policy = readOnlyPolicy(allowedServers);
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const decision = await policy(input.tool_name);
            if (decision.behavior === 'allow') return {};
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } };
          },
        ],
      },
    ],
  };
}

// Streaming input mode is required for canUseTool and lets us send images.
async function* singleMessage(content, ready, done) {
  await ready;
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
  await done;
}

// MCP servers connect asynchronously; tools of a server that is still "pending"
// when the prompt is sent are missing for the whole run, so wait for the ones we need.
async function waitForServers(q, names, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await q.mcpServerStatus();
    const notReady = names.filter((n) => statuses.find((s) => s.name === n)?.status !== 'connected');
    if (!notReady.length) return;
    if (Date.now() > deadline) throw new Error(`MCP server not connected in time: ${notReady.join(', ')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Runs one Claude agent turn and returns the parsed JSON object from its final answer.
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.prompt
 * @param {string[]} [opts.mcpServers] names of the servers whose read tools may be used
 * @param {string[]} [opts.otherServers] every other configured server; hidden from Claude for this run
 * @param {{mediaType: string, base64: string}[]} [opts.images]
 */
async function runClaudeAgentJson({ systemPrompt, prompt, mcpServers = [], otherServers = [], images = [], light = false }) {
  let finish, markReady;
  const done = new Promise((r) => (finish = r));
  const ready = new Promise((r) => (markReady = r));
  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    })),
    { type: 'text', text: prompt },
  ];

  const q = query({
    prompt: singleMessage(content, ready, done),
    options: {
      ...BASE_OPTIONS,
      systemPrompt,
      // Light runs (MCP extraction) only copy data out of tool results, so a small model at low effort is enough.
      ...(light ? { model: config.extractModel, effort: 'low' } : { model: config.model }),
      maxTurns: config.maxTurns,
      canUseTool: readOnlyPolicy(mcpServers),
      hooks: readOnlyHook(mcpServers),
      // A server-level deny rule removes that server's tools from the context entirely.
      disallowedTools: otherServers.map((name) => `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`),
      // Calls that need no MCP tools load no MCP servers at all; otherwise every connected server's
      // tool definitions are sent with the prompt (hundreds of thousands of tokens).
      ...(mcpServers.length ? {} : { strictMcpConfig: true, mcpServers: {} }),
    },
  });

  const toolCalls = [];
  let toolsLoaded = null;
  try {
    await waitForServers(q, mcpServers);
    markReady();
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') toolsLoaded = msg.tools?.length ?? null;
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') toolCalls.push(block.name);
        }
      }
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') {
          throw new Error(`Claude run failed (${msg.subtype}): ${(msg.errors || []).join('; ')}`);
        }
        return {
          data: extractJson(msg.result),
          meta: {
            costUsd: msg.total_cost_usd,
            usage: msg.usage,
            toolCalls,
            toolsLoaded,
            provider: 'claude',
            // The model that actually answered (modelUsage also lists small helper calls; take the busiest).
            model: Object.entries(msg.modelUsage || {}).sort((a, b) => b[1].outputTokens - a[1].outputTokens)[0]?.[0] || (light ? config.extractModel : config.model) || null,
            effort: light ? 'low' : 'default',
          },
        };
      }
    }
    throw new Error('Claude run ended without a result.');
  } finally {
    finish();
    q.close?.();
  }
}

function runCommand(command, args, { input = '', timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
    };
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      done();
      reject(error);
    });
    child.on('close', (code) => {
      done();
      if (timedOut) reject(Object.assign(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`), { stdout }));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { stdout }));
    });
    child.stdin.end(input);
  });
}

async function codexServers() {
  const { stdout } = await runCommand('codex', ['mcp', 'list', '--json']);
  const servers = JSON.parse(stdout);
  if (!Array.isArray(servers)) throw new Error('Codex returned an invalid MCP server list.');
  return servers.filter((server) => server.enabled).map((server) => server.name);
}

/**
 * Names of the MCP servers and plugins defined in Codex's own config.toml. Only these can be switched off with
 * `-c ...enabled=false`: doing that for a server that comes from a plugin (e.g. "cua_repl" from the ChatGPT app's
 * Computer Use plugin) creates an entry with no command or URL, and Codex fails with "invalid transport".
 */
async function codexConfigNames() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return {
    servers: [...text.matchAll(/^\[mcp_servers\.([\w-]+)\]\s*$/gm)].map((m) => m[1]),
    plugins: [...text.matchAll(/^\[plugins\."([^"]+)"\]\s*$/gm)].map((m) => m[1]),
  };
}

async function runCodexAgentJson({ systemPrompt, prompt, mcpServers = [], images = [], light = false }) {
  const configured = await codexServers();
  const selected = new Set(mcpServers);
  if (mcpServers.some((name) => !configured.includes(name))) {
    throw new Error('The requested MCP server is not enabled in Codex. Recheck the Connections panel.');
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-figma-codex-'));
  const outputFile = path.join(dir, 'last-message.txt');
  const args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-last-message', outputFile];
  if (light) {
    args.push('-c', 'model_reasoning_effort="low"');
    if (config.codexExtractModel) args.push('-m', config.codexExtractModel);
  }
  // Keep the run scoped to the requested MCP server, like the Claude runs: Codex otherwise loads every enabled
  // server and plugin. Plugins (Computer Use, browser, documents, ...) are never needed here, so they are switched off.
  const own = await codexConfigNames();
  for (const name of own.servers) {
    args.push('-c', `mcp_servers.${name}.enabled=${selected.has(name)}`);
  }
  for (const name of own.plugins) {
    args.push('-c', `plugins."${name}".enabled=false`);
  }
  const toolCalls = [];
  let usage = null;
  try {
    for (const [index, image] of images.entries()) {
      const imagePath = path.join(dir, `image-${index}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`);
      await fs.writeFile(imagePath, Buffer.from(image.base64, 'base64'));
      args.push('--image', imagePath);
    }
    args.push('-');
    const input = `You are the Codex agent used by the Jira and Figma UI Checker.\n${systemPrompt}\n\nFollow the task below and return only the requested JSON result. Do not modify external data; use MCP tools only to read or search.\n\n${prompt}`;
    const { stdout } = await runCommand('codex', args, { input, timeoutMs: 10 * 60_000 });
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line);
        const item = event.item || event;
        if (item.type === 'mcp_tool_call' && item.name) toolCalls.push(item.name);
        if (event.type === 'turn.completed' && event.usage) {
          usage = {
            input_tokens: event.usage.input_tokens || 0,
            cache_read_input_tokens: event.usage.cached_input_tokens || 0,
            output_tokens: event.usage.output_tokens || 0,
          };
        }
      } catch { /* Codex emits one JSON event per line. */ }
    }
    const text = await fs.readFile(outputFile, 'utf8');
    return { data: extractJson(text), meta: { provider: 'codex', toolCalls, usage, costUsd: null, ...(light && { model: config.codexExtractModel || 'default', effort: 'low' }) } };
  } catch (error) {
    // Codex reports account problems (e.g. "You've hit your usage limit…") as JSON events on stdout.
    const reported = String(error.stdout || '')
      .split('\n')
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((event) => event?.type === 'error' || event?.type === 'turn.failed');
    const message = reported?.message || reported?.error?.message || error.message;
    throw new Error(`Codex run failed: ${message}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function runAgentJson(options) {
  const provider = await getAgentProvider();
  return provider === 'codex' ? runCodexAgentJson(options) : runClaudeAgentJson(options);
}

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`Agent did not return valid JSON. Response started with: ${text.slice(0, 300)}`);
  }
}

// Model list from the last Claude start-up, used to name the models each step runs on.
let claudeModels = [];

/** Codex's own top-level model and reasoning effort from config.toml, if set. */
async function codexDefaults() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const top = (await fs.readFile(file, 'utf8').catch(() => '')).split(/^\[/m)[0];
  const value = (key) => top.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] || null;
  return { model: value('model'), effort: value('model_reasoning_effort') };
}

/**
 * Agent, model and effort each kind of step runs on, for the labels next to the run buttons.
 * "extract": Jira / Figma MCP reads. "analysis": the checklist, Check UI and test generation.
 */
export async function describeRuns(provider) {
  if (provider === 'codex') {
    const own = await codexDefaults();
    return {
      agent: 'Codex',
      extract: { model: config.codexExtractModel || own.model || 'Codex default', effort: 'low' },
      analysis: { model: own.model || 'Codex default', effort: own.effort || 'default' },
    };
  }
  const name = (id) => {
    const row = claudeModels.find((m) => m.value === id) || claudeModels.find((m) => m.resolvedModel === id && m.value !== 'default');
    if (row && row.value !== 'default') return row.displayName;
    const fallback = claudeModels.find((m) => m.value === 'default')?.resolvedModel;
    return id ? id : fallback ? name(fallback) : 'Claude default';
  };
  return {
    agent: 'Claude',
    extract: { model: name(config.extractModel), effort: 'low' },
    analysis: { model: name(config.model), effort: 'default' },
  };
}

/** Reads MCP connection status without sending any prompt (no tokens used). */
export async function getClaudeMcpStatus() {
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* idle() {
    await done;
  }
  const q = query({ prompt: idle(), options: BASE_OPTIONS });
  try {
    const init = await q.initializationResult();
    claudeModels = init.models || [];
    const account = await q.accountInfo().catch(() => ({}));
    let servers = [];
    // Servers start as "pending" while connecting; poll briefly until they settle.
    for (let i = 0; i < 30; i++) {
      servers = await q.mcpServerStatus();
      if (!servers.some((s) => s.status === 'pending')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // This app manages local MCP OAuth itself. Ignore Claude.ai account connectors,
    // which would silently reappear whenever the user's web account reconnects.
    const localServers = servers.filter((server) => !server.name.startsWith('claude.ai '));
    const pick = (re) => {
      const matches = localServers.filter((x) => re.test(x.name));
      const s = matches.find((x) => x.status === 'connected') || matches[0];
      return s ? { name: s.name, status: s.status, error: s.error } : { name: null, status: 'not-configured' };
    };
    return {
      authenticated: account.tokenSource !== 'none' || Boolean(process.env.ANTHROPIC_API_KEY),
      account: { email: account.email, tokenSource: account.tokenSource },
      jira: pick(config.jiraMcpMatch),
      figma: pick(config.figmaMcpMatch),
      figmaBridge: pick(config.figmaBridgeMcpMatch),
      all: servers.map((s) => ({ name: s.name, status: s.status })),
    };
  } finally {
    finish();
    q.close?.();
  }
}

async function getCodexMcpStatus() {
  let authenticated = false;
  try {
    await runCommand('codex', ['login', 'status']);
    authenticated = true;
  } catch { /* The CLI is installed but not logged in, or is unavailable. */ }
  let servers = [];
  try {
    const { stdout } = await runCommand('codex', ['mcp', 'list', '--json']);
    const listed = JSON.parse(stdout);
    servers = Array.isArray(listed) ? listed.map((server) => {
      const authStatus = String(server.auth_status || 'unknown').toLowerCase();
      const oauthRequired = authStatus === 'not_logged_in' ||
        (authStatus === 'unknown' && /jira|atlassian|^figma(?:-ui-checker)?$/i.test(server.name));
      return {
        name: server.name,
        status: !server.enabled ? 'disabled' : oauthRequired ? 'needs-auth' : 'configured',
        authStatus,
      };
    }) : [];
  } catch { /* Show unmatched connections as not configured. */ }
  const pick = (re) => {
    const matches = servers.filter((server) => re.test(server.name));
    const server = matches.find((x) => x.status === 'configured') || matches[0];
    return server ? { ...server, error: null } : { name: null, status: 'not-configured' };
  };
  return {
    authenticated,
    account: { email: null, tokenSource: authenticated ? 'codex' : 'none' },
    jira: pick(/jira|atlassian/i),
    figma: pick(/^figma(?:-ui-checker)?$/i),
    figmaBridge: pick(/figma-bridge/i),
    all: servers,
  };
}

export async function getMcpStatus() {
  const provider = await getAgentProvider();
  const status = provider === 'codex' ? await getCodexMcpStatus() : await getClaudeMcpStatus();
  return { ...status, provider, runs: await describeRuns(provider) };
}

/**
 * Reconnects (or enables) one MCP server without sending a prompt, then returns its new status.
 * Enabling persists to the Claude Code settings, the same as toggling it on in /mcp.
 */
export async function repairMcpServer(name, { enable = false } = {}) {
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* idle() {
    await done;
  }
  const q = query({ prompt: idle(), options: BASE_OPTIONS });
  try {
    await q.initializationResult();
    // Remote MCP servers register a few seconds after start-up; wait until the server is known.
    for (let i = 0; i < 40 && !(await q.mcpServerStatus()).some((x) => x.name === name); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (enable) await q.toggleMcpServer(name, true);
    else await q.reconnectMcpServer(name);
    for (let i = 0; i < 30; i++) {
      const s = (await q.mcpServerStatus()).find((x) => x.name === name);
      if (s && s.status !== 'pending') return s;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { name, status: 'pending' };
  } finally {
    finish();
    q.close?.();
  }
}
