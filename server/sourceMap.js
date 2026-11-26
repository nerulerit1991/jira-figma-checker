// Minimal source-map reader (v3): maps a position in a built file (app.3f9c.js line 1, column 48211) back to the
// original source file and line (src/config.ts:12), when the site publishes its source maps. No dependencies.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One mappings segment ("AAgBC") -> its numbers, or null when it is not valid base64 VLQ. */
function decodeSegment(segment) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    let digit = B64.indexOf(ch);
    if (digit < 0) return null;
    const more = digit & 32;
    digit &= 31;
    value += digit * 2 ** shift;
    if (more) {
      shift += 5;
    } else {
      out.push(value % 2 ? -Math.floor(value / 2) : Math.floor(value / 2));
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** "webpack://app/./src/x.ts", "../../src/x.ts" -> "src/x.ts". */
function cleanSource(map, index) {
  const raw = `${map.sourceRoot ? `${map.sourceRoot.replace(/\/$/, '')}/` : ''}${map.sources?.[index] ?? ''}`;
  return raw.replace(/^[a-z]+:\/\/[^/]*\//i, '').replace(/^(\.\.?\/)+/, '');
}

/**
 * Original position of generated `line` (1-based) / `column` (0-based) in `map`, or null.
 * Returns { source, line, column } with line and column 1-based.
 */
export function originalPosition(map, line, column) {
  if (!map || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null;
  const lines = map.mappings.split(';');
  if (line > lines.length) return null;
  let source = 0;
  let origLine = 0;
  let origColumn = 0;
  let best = null;
  // Source index, original line and column are relative across the whole file, so earlier lines are decoded too.
  for (let l = 0; l < line; l++) {
    let genColumn = 0;
    for (const segment of lines[l].split(',')) {
      if (!segment) continue;
      const f = decodeSegment(segment);
      if (!f) return null;
      genColumn += f[0];
      if (f.length < 4) continue;
      source += f[1];
      origLine += f[2];
      origColumn += f[3];
      if (l === line - 1 && genColumn <= column) best = { source: cleanSource(map, source), line: origLine + 1, column: origColumn + 1 };
    }
  }
  return best;
}

/** The source map URL a built file points at (sourceMappingURL comment or SourceMap header), resolved, or null. */
export function sourceMapUrl(text, fileUrl, headers = {}) {
  const fromHeader = headers.sourcemap || headers['x-sourcemap'];
  const m = fromHeader ? [null, fromHeader] : /[#@]\s*sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/m.exec(text.slice(-2000));
  if (!m) return null;
  try {
    return new URL(m[1], fileUrl).href;
  } catch {
    return null;
  }
}

/** Parses an inline (data:) source map; other URLs are fetched by the caller. */
export function inlineSourceMap(url) {
  const m = /^data:application\/json[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return JSON.parse(m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]));
  } catch {
    return null;
  }
}
