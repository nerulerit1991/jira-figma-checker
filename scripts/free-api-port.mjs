// Runs before `npm run dev`: stops an old copy of this app's API server that still holds the port
// (e.g. one started by another tool), so the new server can start. Other programs on the port are left alone.
import { execFileSync } from 'node:child_process';

const port = Number(process.env.API_PORT) || 3001;
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const listeners = () => run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']).split('\n').filter(Boolean);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (const pid of listeners()) {
  const command = run('ps', ['-o', 'command=', '-p', pid]);
  if (/server\/index\.js/.test(command)) {
    process.kill(Number(pid));
    // Wait (up to 5s) for it to let go of the port, so the new server does not fail with "address in use".
    for (let waited = 0; waited < 5000 && listeners().includes(pid); waited += 100) sleep(100);
    console.log(`Stopped an old API server (pid ${pid}) on port ${port}.`);
  } else if (command) {
    console.warn(`Port ${port} is used by another program (${command.slice(0, 80)}). Set API_PORT in .env to use a different port.`);
  }
}
