// The signed-in Codex account email, read from the Codex app server (account/read); no tokens.
import { spawn } from 'node:child_process';
import { ROOT } from './config.js';
import { cleanEnv } from './ai.js';

export function readCodexAccount() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEX_CLI_PATH || 'codex', ['app-server'], { cwd: ROOT, env: cleanEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const timer = setTimeout(() => finishWith(new Error('Codex did not report its account in time.')), 15_000);
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
        } else if (msg.id === 2) {
          finishWith({ email: msg.result?.account?.email || null, plan: msg.result?.account?.planType || null });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'jira-figma-ui-checker', version: '0.1.0' } } });
  });
}
