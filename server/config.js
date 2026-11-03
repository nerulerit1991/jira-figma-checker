import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

export const config = {
  port: Number(process.env.API_PORT) || 3001,
  model: process.env.CLAUDE_MODEL || undefined,
  // Jira / Figma MCP extraction always runs on a small model at low effort (copying data, not judging it).
  extractModel: process.env.CLAUDE_EXTRACT_MODEL || 'claude-haiku-5-5',
  // Codex extraction model; unset keeps Codex's default model (still at low reasoning effort).
  codexExtractModel: process.env.CODEX_EXTRACT_MODEL || null,
  // Regexes used to find the Jira / Figma MCP servers by name in the Claude config.
  jiraMcpMatch: new RegExp(process.env.JIRA_MCP_MATCH || 'atlassian|jira', 'i'),
  // Local Figma MCP only; the desktop bridge (figma-bridge) is tracked separately.
  figmaMcpMatch: new RegExp(process.env.FIGMA_MCP_MATCH || '^figma(?:-ui-checker)?$', 'i'),
  // Figma desktop bridge: reads files open in the Figma desktop app through a plugin (no Figma API limits).
  figmaBridgeMcpMatch: new RegExp(process.env.FIGMA_BRIDGE_MCP_MATCH || '^figma-bridge$', 'i'),
  maxTurns: Number(process.env.CLAUDE_MAX_TURNS) || 20,
};
