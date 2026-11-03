import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './store.js';

const FILE = path.join(DATA_DIR, 'app-settings.json');

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(settings, null, 2));
}

export async function getAgentProvider() {
  const settings = await readSettings();
  return settings.agentProvider === 'codex' ? 'codex' : 'claude';
}

export async function setAgentProvider(provider) {
  if (!['claude', 'codex'].includes(provider)) throw Object.assign(new Error('Choose Claude or Codex.'), { status: 400 });
  await writeSettings({ ...(await readSettings()), agentProvider: provider });
  return provider;
}

