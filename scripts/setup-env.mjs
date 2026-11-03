// Runs from `npm run setup`: checks the Node version and creates .env from .env.example when it is missing.
// Works the same on macOS, Linux and Windows. An existing .env is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Node ${process.versions.node} is too old: this app needs Node 22.12 or newer (https://nodejs.org).`);
  process.exit(1);
}

const env = path.join(root, '.env');
if (fs.existsSync(env)) {
  console.log('.env already exists; left unchanged.');
} else {
  fs.copyFileSync(path.join(root, '.env.example'), env);
  console.log('Created .env from .env.example. Fill in your own tokens (see README → Setup), then run "npm run dev".');
}
