import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.js';
import { cleanEnv, repairMcpServer, getClaudeMcpStatus } from './ai.js';
import { getAgentProvider } from './agentSettings.js';
import { codexCli } from './codexCli.js';

const require = createRequire(import.meta.url);

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v2/mcp';
const FIGMA_MCP_URL = 'https://mcp.figma.com/mcp';

/** Background fix jobs, keyed by connection: { state: 'running' | 'done' | 'error', message, url }. */
const jobs = new Map();
let signOutJob = null;

// Jira/Figma sign-ins belong to one agent: their jobs are stored as "<agent>:<target>" (e.g. "codex:figma"),
// so Claude's and Codex's sign-ins never share or overwrite each other.
const MCP_TARGETS = new Set(['jira', 'figma']);
const jobKey = (provider, target) => (MCP_TARGETS.has(target) ? `${provider}:${target}` : target);

/** Jobs as the UI sees them: Jira/Figma only for the selected agent, under their plain names. */
export async function getJobs() {
  const provider = await getAgentProvider();
  const visible = {};
  for (const [key, job] of jobs) {
    const [owner, target] = key.includes(':') ? key.split(':') : [null, key];
    if (owner && owner !== provider) continue;
    visible[target] = job;
  }
  return { ...visible, signOutAll: signOutJob };
}

/**
 * Stops Jira/Figma sign-ins that belong to other agents than `provider`, including leftover CLI processes,
 * so switching agents never leaves another agent's sign-in page waiting or opening.
 */
export function cancelOtherAgentLogins(provider) {
  for (const [key, job] of jobs) {
    const owner = key.includes(':') ? key.split(':')[0] : null;
    if (!owner || owner === provider || job.state !== 'running') continue;
    job.child?.kill();
    Object.assign(job, { state: 'error', message: 'Cancelled: switched to another agent.' });
  }
  const other = provider === 'codex' ? 'claude.* mcp login' : 'codex mcp login';
  spawnSync('pkill', ['-f', other], { timeout: 5_000 });
}

function runCli(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error([stderr, stdout].filter(Boolean).join('\n').trim() || `${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function claudeMcpNames() {
  const files = [
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(ROOT, '.mcp.json'),
    path.join(ROOT, '.claude', 'settings.json'),
    path.join(ROOT, '.claude', 'settings.local.json'),
  ];
  const names = new Set();
  const addRemoteServers = (servers) => {
    for (const [name, server] of Object.entries(servers || {})) {
      const transport = String(server?.type || server?.transport || '').toLowerCase();
      if (server?.url || transport === 'http' || transport === 'sse' || transport === 'streamable_http') names.add(name);
    }
  };
  for (const file of files) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      addRemoteServers(config.mcpServers);
      addRemoteServers(config.projects?.[ROOT]?.mcpServers);
    } catch { /* Missing or invalid config files contain no discoverable server names. */ }
  }
  return [...names];
}

async function codexMcpNames() {
  const { cmd, args } = codexCli();
  const output = await runCli(cmd, [...args, 'mcp', 'list', '--json']);
  const servers = JSON.parse(output.stdout);
  return servers
    .filter((server) => ['http', 'sse', 'streamable_http'].includes(String(server.transport?.type || '').toLowerCase()))
    .filter((server) => String(server.auth_status || 'unknown').toLowerCase() !== 'unsupported')
    .map((server) => server.name);
}

const alreadySignedOut = (message) => /no (stored )?(oauth )?(credentials|token)|not (logged in|authenticated)|does not (use|support) oauth/i.test(message);

async function logoutMcpProvider(job, provider, names, cmd, prefixArgs) {
  for (const name of names) {
    job.current = `${provider} MCP: ${name}`;
    job.message = `Signing out of ${provider} MCP ${name}…`;
    job.total += 1;
    try {
      await runCli(cmd, [...prefixArgs, 'mcp', 'logout', name]);
      job.steps.push({ target: `${provider}:${name}`, state: 'done' });
    } catch (error) {
      const message = error.message || String(error);
      if (alreadySignedOut(message)) job.steps.push({ target: `${provider}:${name}`, state: 'already-signed-out' });
      else job.steps.push({ target: `${provider}:${name}`, state: 'error', message });
    }
    job.completed += 1;
  }
}

async function performSignOutAll(job) {
  const claude = claudeCli();
  const codex = codexCli();
  // Discover both sets first so no agent logout can start before every MCP
  // logout has been attempted.
  const claudeNames = claudeMcpNames();
  const codexNames = await codexMcpNames();
  job.total = 0;
  job.message = 'Signing out of all Claude MCPs…';
  await logoutMcpProvider(job, 'Claude', claudeNames, claude.cmd, claude.args);
  job.message = 'Signing out of all Codex MCPs…';
  await logoutMcpProvider(job, 'Codex', codexNames, codex.cmd, codex.args);

  const mcpFailures = job.steps.filter((step) => step.state === 'error');
  if (mcpFailures.length) {
    job.state = 'error';
    job.phase = 'mcp';
    job.message = `MCP sign-out stopped with ${mcpFailures.length} error(s); agent sign-out was not started.`;
    return;
  }

  job.phase = 'agents';
  job.total += 2;
  job.message = 'Signing out of Claude…';
  for (const [provider, cmd, args] of [
    ['Claude', claude.cmd, [...claude.args, 'auth', 'logout']],
    ['Codex', codex.cmd, [...codex.args, 'logout']],
  ]) {
    job.current = `${provider} agent`;
    try {
      await runCli(cmd, args);
      job.steps.push({ target: provider, state: 'done' });
    } catch (error) {
      const message = error.message || String(error);
      if (alreadySignedOut(message)) job.steps.push({ target: provider, state: 'already-signed-out' });
      else job.steps.push({ target: provider, state: 'error', message });
    }
    job.completed += 1;
    job.message = `Signed out of ${provider}.`;
  }
  job.phase = 'complete';
  const failures = job.steps.filter((step) => step.state === 'error');
  job.state = failures.length ? 'error' : 'done';
  job.current = null;
  job.message = failures.length ? `Sign-out finished with ${failures.length} error(s).` : 'All MCPs and agents are signed out.';
}

export function signOutAll() {
  if (signOutJob?.state === 'running') return signOutJob;
  const activeJobs = [...jobs.values()].filter((job) => job.state === 'running');
  if (activeJobs.length) throw Object.assign(new Error('Wait for the current connection sign-in to finish before signing out.'), { status: 409 });
  signOutJob = { state: 'running', phase: 'mcp', current: null, message: 'Preparing MCP sign-out…', completed: 0, total: 0, steps: [] };
  performSignOutAll(signOutJob).catch((error) => {
    Object.assign(signOutJob, { state: 'error', phase: signOutJob.phase || 'mcp', current: null, message: error.message || String(error) });
  });
  return signOutJob;
}

/** The Claude Code CLI shipped with the Agent SDK for this platform; falls back to npx. */
function claudeCli() {
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(bin)) return { cmd: bin, args: [] };
  } catch {
    /* platform package not installed */
  }
  return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '@anthropic-ai/claude-code'] };
}


/** Whether Playwright's Chromium (used for page capture) is installed. */
export async function browserStatus() {
  try {
    const { chromium } = await import('playwright');
    return fs.existsSync(chromium.executablePath()) ? 'installed' : 'missing';
  } catch {
    return 'missing';
  }
}

// Terminal colour/link escape codes, stripped from command output before reading links or messages.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0e-\x1f]/g;
// Only return a URL once a delimiter confirms the chunk contains its end. OAuth
// links from Claude can be longer than one PTY read, so returning the first
// fragment sends the browser to a malformed authorization URL.
export const firstUrl = (text) => text.match(/https:\/\/[^\s"'<>]+(?=[\s"'<>])/)?.[0];

/**
 * Wraps a command so OAuth CLIs that require a terminal can run from a background job.
 */
function inTerminal(cmd, args) {
  if (process.platform === 'darwin') {
    // macOS `script` fails when its stdin is a Node pipe (tcgetattr reports
    // "Operation not supported on socket"). Use Python's pty.fork so the CLI
    // gets a real controlling terminal while its output remains capturable.
    const launcher = [
      'import errno, os, pty, sys',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      '    os.execvp(sys.argv[1], sys.argv[1:])',
      'while True:',
      '    try: data = os.read(fd, 4096)',
      '    except OSError as e:',
      '        if e.errno == errno.EIO: break',
      '        raise',
      '    if not data: break',
      '    os.write(1, data)',
      '_, status = os.waitpid(pid, 0)',
      'sys.exit(os.waitstatus_to_exitcode(status))',
    ].join('\n');
    return { cmd: 'python3', args: ['-c', launcher, cmd, ...args] };
  }
  if (process.platform === 'linux') {
    const quoted = [cmd, ...args].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
    return { cmd: 'script', args: ['-qec', quoted, '/dev/null'] };
  }
  return { cmd, args };
}

/** Runs a command as a background job, tracking its state under `key`. `tty` runs it in a pseudo-terminal. */
function runJob(key, cmd, args, { timeoutMs, runningMessage, doneMessage, onOutput, tty = false }) {
  if (jobs.get(key)?.state === 'running') return jobs.get(key);
  const job = { state: 'running', message: runningMessage, url: null, startedAt: new Date().toISOString() };
  jobs.set(key, job);

  const run = tty ? inTerminal(cmd, args) : { cmd, args };
  // Keep the PTY wrapper's stdin open for the lifetime of terminal-backed jobs.
  const child = spawn(run.cmd, run.args, {
    cwd: ROOT,
    env: cleanEnv,
    stdio: [tty ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (tty) child.stdin.resume();
  // Kept off the JSON the UI receives; used to cancel this sign-in when the agent is switched.
  Object.defineProperty(job, 'child', { value: child, enumerable: false });
  let tail = '';
  let urlScan = '';
  const onData = (chunk) => {
    const text = chunk.toString().replace(ANSI, '');
    tail = (tail + text).slice(-2000);
    urlScan = (urlScan + text).slice(-16_384);
    onOutput?.(urlScan, job);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const timer = setTimeout(() => {
    child.kill();
    Object.assign(job, { state: 'error', message: 'Timed out. Try again.' });
  }, timeoutMs);

  child.on('error', (err) => {
    clearTimeout(timer);
    Object.assign(job, { state: 'error', message: err.message });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (job.state !== 'running') return;
    if (code === 0) Object.assign(job, { state: 'done', message: doneMessage });
    else Object.assign(job, { state: 'error', message: tail.trim().split('\n').pop() || `Exited with code ${code}` });
  });
  return job;
}

/**
 * One-click fix for a connection. Returns what the UI should do next:
 *   { action: 'job', job }        a background job started; poll /api/connections/jobs
 *   { action: 'open', url, hint } open this page; the user finishes there, the UI polls status
 *   { action: 'done', status }    fixed immediately
 *   { action: 'manual', hint }    cannot be automated
 */
export async function fixConnection(target, status) {
  if (target === 'codex') {
    // Normal browser sign-in: Codex opens OpenAI's page and waits on localhost:1455 for the approval.
    // A leftover `codex login` would hold that port, so stop it first.
    spawnSync('pkill', ['-f', 'codex login'], { timeout: 5_000 });
    const { cmd, args } = codexCli();
    const job = runJob('codex', cmd, [...args, 'login'], {
      timeoutMs: LOGIN_TIMEOUT_MS,
      runningMessage: 'Approve the Codex sign-in in your browser…',
      doneMessage: 'Logged in',
      onOutput: (text, j) => {
        const url = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize[^\s"'<>]+/)?.[0];
        if (url && !j.url) j.url = url;
      },
    });
    return { action: 'job', job };
  }

  if (target === 'claude') {
    const { cmd, args } = claudeCli();
    const job = runJob('claude', cmd, [...args, 'auth', 'login', '--claudeai'], {
      timeoutMs: LOGIN_TIMEOUT_MS,
      runningMessage: 'Waiting for you to approve the sign-in in your browser…',
      doneMessage: 'Logged in',
      // The CLI opens the browser itself; keep the link in case it does not.
      onOutput: (text, j) => {
        const url = firstUrl(text);
        if (url && !j.url) j.url = url;
      },
    });
    return { action: 'job', job };
  }

  if (target === 'browser') {
    // Run Playwright's CLI with Node itself: Windows refuses to spawn the .cmd shim without a shell (EINVAL).
    const cli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
    const job = runJob('browser', process.execPath, [cli, 'install', 'chromium'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      runningMessage: 'Installing the page-capture browser (about 100 MB)…',
      doneMessage: 'Installed',
    });
    return { action: 'job', job };
  }

  if (target === 'jira' || target === 'figma') {
    const server = status[target];
    const label = target === 'jira' ? 'Atlassian' : 'Figma';
    const provider = await getAgentProvider();
    cancelOtherAgentLogins(provider);
    if (provider === 'codex') {
      if (target === 'jira' || target === 'figma') {
        const { cmd, args } = codexCli();
        const serverName = server?.name && server.status !== 'disabled'
          ? server.name
          : server?.status === 'disabled'
            ? (target === 'jira' ? 'atlassian-ui-checker' : 'figma-ui-checker')
            : (target === 'jira' ? 'atlassian' : 'figma');
        if (!server?.name || server.status === 'disabled') {
          const added = spawnSync(cmd, [...args, 'mcp', 'add', serverName, '--url', target === 'jira' ? ATLASSIAN_MCP_URL : FIGMA_MCP_URL], {
            cwd: ROOT,
            env: cleanEnv,
            encoding: 'utf8',
            timeout: 20_000,
          });
          if (added.error) throw added.error;
          if (added.status !== 0) {
            throw new Error((added.stderr || added.stdout || `Could not add ${label} MCP to Codex.`).trim());
          }
        }
        const job = runJob(jobKey('codex', target), cmd, [...args, 'mcp', 'login', serverName], {
        tty: true,
          timeoutMs: LOGIN_TIMEOUT_MS,
          runningMessage: `Waiting for you to approve ${label} sign-in…`,
          doneMessage: `${label} connected`,
          onOutput: (text, j) => {
            const url = firstUrl(text);
            if (url && !/mcp\.atlassian\.com/i.test(url) && !j.url) j.url = url;
          },
        });
        return { action: 'codex-mcp', job };
      }
      return { action: 'manual', hint: `Add an ${label} MCP server to Codex first, then recheck Connections.` };
    }
    if (target === 'jira' || target === 'figma') {
      const { cmd, args } = claudeCli();
      const localServer = server?.name && !server.name.startsWith('claude.ai ') && server.status !== 'disabled';
      const serverName = localServer ? server.name : target === 'jira' ? 'atlassian-ui-checker' : 'figma-ui-checker';
      const mcpUrl = target === 'jira' ? ATLASSIAN_MCP_URL : FIGMA_MCP_URL;
      if (!localServer) {
        const added = spawnSync(cmd, [...args, 'mcp', 'add', '--scope', 'user', '--transport', 'http', serverName, mcpUrl], {
          cwd: ROOT, env: cleanEnv, encoding: 'utf8', timeout: 20_000,
        });
        if (added.error) throw added.error;
        if (added.status !== 0) {
          throw new Error((added.stderr || added.stdout || `Could not add ${label} MCP to Claude.`).trim());
        }
      }
      const job = runJob(jobKey('claude', target), cmd, [...args, 'mcp', 'login', serverName], {
        tty: true,
        timeoutMs: LOGIN_TIMEOUT_MS,
        runningMessage: 'Waiting for you to approve the sign-in…',
        doneMessage: `${label} connected`,
        onOutput: (text, j) => {
          const url = firstUrl(text);
          if (url && !j.url) j.url = url;
        },
      });
      return { action: 'job', job, requiresCallback: true };
    }
    if (server.status === 'needs-auth') {
      return {
        action: 'manual',
        hint: `"${server.name}" uses its own sign-in. Run "claude" in a terminal, type /mcp, choose ${server.name} and authenticate.`,
      };
    }
    // failed, pending or disabled: reconnect (or enable) in place.
    const result = await repairMcpServer(server.name, { enable: server.status === 'disabled' });
    return { action: 'done', status: { name: result.name, status: result.status, error: result.error } };
  }

  if (target === 'figmaBridge') {
    const server = status.figmaBridge || { status: 'not-configured' };
    if (server.status === 'not-configured') {
      return {
        action: 'manual',
        hint: 'figma-bridge is not set up in your Claude config. Add the figma-bridge MCP server, then click ↻.',
      };
    }
    // failed, pending or disabled: restart the local bridge server (or turn it back on).
    const result = await repairMcpServer(server.name, { enable: server.status === 'disabled' });
    return { action: 'done', status: { name: result.name, status: result.status, error: result.error } };
  }

  throw Object.assign(new Error(`Unknown connection: ${target}`), { status: 404 });
}
