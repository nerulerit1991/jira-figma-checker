// Turns a Playwright failure message into two plain sentences for people who do not read test code:
// what the test expected, and what it actually found on the page. Uses no AI; the raw message stays available.

const field = (lines, name) => {
  const line = lines.find((l) => l.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim() : null;
};
const quoted = (v) => (v && !/^["'\d]/.test(v) ? `"${v}"` : v);

/**
 * @param {string|null} error  the failure message saved for a test row
 * @param {{ element?: string|null }|null} target  what the test acts on, when known
 * @returns {{ expected: string|null, found: string|null }|null}  null when there is nothing to explain
 */
export function explainFailure(error, target) {
  if (!error) return null;
  const lines = error.split('\n').map((l) => l.trim()).filter(Boolean);
  const what = target?.element || 'The element';

  if (/Test timeout of \d+ms exceeded/.test(error)) {
    return { expected: null, found: 'The test ran out of time: a step kept waiting for something that never appeared or never finished loading.' };
  }

  const matcherAt = lines.findIndex((l) => /^expect\(.*\)\.(?:not\.)?\w+\(.*\) failed$/.test(l) || /^expect\(received\)/.test(l));
  // A message the test gave its expect() comes first ("Error: <message>"), right above the matcher line.
  const custom = matcherAt > 0 && lines[0].startsWith('Error: ') ? lines[0].slice(7) : null;
  const matcherLine = matcherAt >= 0 ? lines[matcherAt] : lines.find((l) => /\.\w+\(/.test(l)) || '';
  const [, negated, matcher] = matcherLine.match(/\.(not\.)?(\w+)\([^)]*\)\s*(?:failed)?$/) || [];
  const expected = field(lines, 'Expected');
  const received = field(lines, 'Received');
  const notFound = /element\(s\) not found/.test(error) || (matcher === 'toHaveCount' && received === '0');

  const expectedText = custom || ({
    toBeVisible: negated ? `${what} is hidden.` : `${what} is visible.`,
    toBeAttached: negated ? `${what} is not on the page.` : `${what} is on the page.`,
    toBeHidden: `${what} is hidden.`,
    toHaveCount: expected ? `${what}: ${expected} on the page.` : null,
    toHaveText: expected ? `${what} reads ${quoted(expected)}.` : null,
    toContainText: expected ? `${what} contains ${quoted(expected)}.` : null,
    toHaveCSS: expected ? `${what} has the style ${quoted(expected)}.` : null,
    toHaveAttribute: expected ? `${what} has ${quoted(expected)}.` : null,
    toHaveURL: expected ? `The page goes to ${expected}.` : null,
    toBeEnabled: `${what} can be used (is enabled).`,
    toBeChecked: `${what} is checked.`,
    toBeGreaterThan: expected ? `More than ${expected.replace(/^>\s*/, '')}.` : null,
  }[matcher] ?? null);

  let found = null;
  if (notFound) found = `Not found on the page${expected && /^\d+$/.test(expected) ? ` (expected ${expected}, found 0)` : ''}.`;
  else if (matcher === 'toBeVisible' && !negated) found = 'It is on the page but not visible (hidden, covered or off-screen).';
  else if (received != null && received !== '') found = `Found ${quoted(received)} instead.`;

  return expectedText || found ? { expected: expectedText, found } : null;
}
