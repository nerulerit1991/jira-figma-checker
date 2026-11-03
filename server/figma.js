/** Adds a scheme to links pasted without one ("figma.com/…", "localhost:3000"). */
export function withScheme(input) {
  const text = String(input || '').trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return (/^(localhost|127\.|\[::1\])/i.test(text) ? 'http://' : 'https://') + text;
}

// Figma link kinds that point at a file: design, file (old), proto (prototype/preview), board (FigJam), slides.
const FILE_PATH = /^\/(design|file|proto|board|slides)\/([A-Za-z0-9]+)(?:\/[^/]*)?(?:\/branch\/([A-Za-z0-9]+))?/;

/**
 * Normalises any Figma link (design, prototype/preview, embed, branch) to the
 * file key and node id the Figma MCP tools need.
 * @returns {{ fileKey: string, nodeId: string | null, kind: string, url: string } | null}
 */
export function parseFigmaUrl(input) {
  let url;
  try {
    url = new URL(withScheme(input));
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;

  // Embed links wrap the real link: figma.com/embed?embed_host=...&url=<encoded link>
  if (url.pathname.startsWith('/embed')) {
    const inner = url.searchParams.get('url');
    return inner ? parseFigmaUrl(inner) : null;
  }

  const match = url.pathname.match(FILE_PATH);
  if (!match) return null;
  const [, kind, key, branchKey] = match;
  const fileKey = branchKey || key;

  // Prototype links may only carry the starting frame. URLs use "1-2"; the API uses "1:2".
  const rawNode = url.searchParams.get('node-id') || url.searchParams.get('starting-point-node-id');
  const nodeId = rawNode ? decodeURIComponent(rawNode).replace('-', ':') : null;

  const editorPath = kind === 'board' || kind === 'slides' ? kind : 'design';
  const canonical = `https://www.figma.com/${editorPath}/${fileKey}/${nodeId ? `?node-id=${nodeId.replace(':', '-')}` : ''}`;
  return { fileKey, nodeId, kind, url: canonical };
}
