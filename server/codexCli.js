// How to start the Codex CLI on this computer: { cmd, args }, used by every place that runs Codex.
//
// macOS / Linux: CODEX_CLI_PATH from .env, or plain `codex` from PATH (unchanged from before).
// Windows, first match wins:
//   1. CODEX_CLI_PATH from .env.
//   2. codex.exe on PATH.
//   3. Codex installed with npm (`npm i -g @openai/codex`): its codex.cmd launcher cannot be started without a
//      shell, so the package's JS entry is run with this Node instead (no shell, so no command-injection risk).
//   4. The codex.exe bundled with the Codex desktop app, in %LOCALAPPDATA%\OpenAI\Codex\bin\<version hash>\, newest
//      first. That folder changes with each app update, so the result is looked up again once it disappears.
import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';
let cached = null;

/** { cmd, args } to start Codex; extra CLI arguments go after `args`. */
export function codexCli() {
  if (!isWindows) return { cmd: process.env.CODEX_CLI_PATH || 'codex', args: [] };
  if (cached && fs.existsSync(cached.file)) return { cmd: cached.cmd, args: [...cached.args] };
  cached = resolveOnWindows();
  if (!cached) return { cmd: 'codex', args: [] }; // Not found: starting it fails with ENOENT, as before.
  return { cmd: cached.cmd, args: [...cached.args] };
}

function resolveOnWindows() {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured) return fromFile(configured);
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const exe = path.join(dir, 'codex.exe');
    if (isFile(exe)) return { cmd: exe, args: [], file: exe };
  }
  for (const dir of pathDirs) {
    const npm = npmEntry(dir);
    if (npm) return npm;
  }
  return desktopAppExe();
}

/** CODEX_CLI_PATH may point at codex.exe or at npm's codex.cmd / codex.ps1 launcher. */
function fromFile(file) {
  if (/\.(cmd|bat|ps1)$/i.test(file)) return npmEntry(path.dirname(file)) || { cmd: file, args: [], file };
  return { cmd: file, args: [], file };
}

/** Codex installed with npm in `binDir` (where npm puts codex.cmd): runs its JS entry with this Node. */
function npmEntry(binDir) {
  if (!isFile(path.join(binDir, 'codex.cmd'))) return null;
  const pkgDir = path.join(binDir, 'node_modules', '@openai', 'codex');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.codex;
    const entry = bin && path.join(pkgDir, bin);
    return entry && isFile(entry) ? { cmd: process.execPath, args: [entry], file: entry } : null;
  } catch {
    return null;
  }
}

/** The newest codex.exe the Codex desktop app keeps in %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\. */
function desktopAppExe() {
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (!base) return null;
  let dirs;
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
  const found = dirs
    .map((entry) => path.join(base, entry.name, 'codex.exe'))
    .filter(isFile)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] ? { cmd: found[0], args: [], file: found[0] } : null;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
