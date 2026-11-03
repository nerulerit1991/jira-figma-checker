// How much of the selected agent's plan allowance is left. Neither agent reports an exact token balance;
// both report the percentage used per limit window and when it resets, which is what is shown here.
import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROOT } from './config.js';
import { cleanEnv } from './ai.js';

const window = (label, usedPercent, resetsAt) =>
  usedPercent == null ? null : { label, usedPercent: Math.round(usedPercent), resetsAt: resetsAt || null };

/** Claude: claude.ai plan windows (5-hour and 7-day). Uses the SDK's experimental /usage call; no tokens. */
async function claudeUsage() {
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* idle() {
    await done;
  }
  const q = query({ prompt: idle(), options: { cwd: ROOT, env: cleanEnv, tools: [], strictMcpConfig: true, mcpServers: {} } });
  try {
    await q.initializationResult();
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!u.rate_limits_available || !u.rate_limits) {
      return { plan: u.subscription_type || null, windows: [], note: 'Plan limits are not available for this login (e.g. an API key).' };
    }
    const r = u.rate_limits;
    return {
      plan: u.subscription_type || null,
      windows: [
        window('5-hour', r.five_hour?.utilization, r.five_hour?.resets_at),
        window('7-day', r.seven_day?.utilization, r.seven_day?.resets_at),
      ].filter(Boolean),
    };
  } finally {
    finish();
    q.close?.();
  }
}

/** Codex: ChatGPT plan limits from the Codex app server (account/rateLimits/read); no tokens. */
function codexUsage() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEX_CLI_PATH || 'codex', ['app-server'], { cwd: ROOT, env: cleanEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let account = null;
    const timer = setTimeout(() => finishWith(new Error('Codex did not report its limits in time.')), 15_000);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    function finishWith(result) {
      clearTimeout(timer);
      child.kill();
      result instanceof Error ? reject(result) : resolve(result);
    }

    child.on('error', (err) => finishWith(err));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: {} });
          send({ id: 3, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          account = msg.result?.account || null;
        } else if (msg.id === 3) {
          if (msg.error) return finishWith(new Error(msg.error.message || 'Codex could not read its limits.'));
          const limits = msg.result?.rateLimits || {};
          const label = (w) => {
            const mins = w?.windowDurationMins;
            if (!mins) return 'Limit';
            if (mins % 1440 === 0) return `${mins / 1440}-day`;
            if (mins % 60 === 0) return `${mins / 60}-hour`;
            return `${mins}-min`;
          };
          const at = (w) => (w?.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null);
          finishWith({
            plan: limits.planType || account?.planType || null,
            windows: [
              window(label(limits.primary), limits.primary?.usedPercent, at(limits.primary)),
              window(label(limits.secondary), limits.secondary?.usedPercent, at(limits.secondary)),
            ].filter(Boolean),
          });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'jira-figma-ui-checker', version: '0.1.0' } } });
  });
}

/** Remaining allowance for the given agent: { agent, plan, windows: [{ label, usedPercent, resetsAt }], note? }. */
export async function getAgentUsage(provider) {
  const data = provider === 'codex' ? await codexUsage() : await claudeUsage();
  return { agent: provider === 'codex' ? 'Codex' : 'Claude', ...data, checkedAt: new Date().toISOString() };
}
