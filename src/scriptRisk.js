// Review aid for generated test scripts (not a guard: the Verify step and the server checks are).
// Marks lines that may change saved data on the site, and whether each one targets the test's own
// "Playwright-Test-…" record (the rule the test prompt sets for every create/edit/delete).

const MUTATING_REQUEST = /\brequest\s*\.\s*(post|put|patch|delete)\s*\(|\bmethod\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i;
const RISKY_WORD = /\b(delete|remove|destroy|deactivate|disable|archive|cancel|revoke|reset|send|invite|publish|approve|reject|pay|checkout|purchase|transfer|save|submit|confirm|update|edit|replace|discard|unsubscribe|sign ?out|log ?out)\b/i;
const ACTS = /\.(click|dblclick|press|check|selectOption|setInputFiles|tap)\s*\(|getBy\w+\s*\(|locator\s*\(|name\s*:/;
const OWN_LITERAL = /playwright-test-/i;
const BY_POSITION = /\.(first|last)\s*\(\s*\)|\.nth\s*\(/;
const TEST_START = /^\s*test(?:\.(?:only|fixme|fail|slow))?\s*\(/;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Identifiers only: quoted text is dropped first, so a variable named "row" does not match getByRole('row').
const withoutQuotes = (text) => text.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
const mentions = (text, name) => new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}(?![\\w$])`).test(withoutQuotes(text));

/** Variables that hold the test's own record: its Playwright-Test- name, and anything built from it (row, id, response). */
function ownNames(code) {
  const decls = [...code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*([^;]*)/g)].map((m) => ({
    names: m[1].match(/[A-Za-z_$][\w$]*/g) || [],
    rhs: m[2],
  }));
  const names = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of decls) {
      if (d.names.every((n) => names.has(n))) continue;
      if (OWN_LITERAL.test(d.rhs) || [...names].some((n) => mentions(d.rhs, n))) {
        d.names.forEach((n) => names.add(n));
        grew = true;
      }
    }
  }
  return names;
}

/**
 * One entry per line: null, or { level: 'risk' | 'own', message }.
 * 'own' = changes data, but on the test's own Playwright-Test record. 'risk' = needs a closer look.
 */
export function scriptRisks(code) {
  const lines = code.split('\n');
  const names = ownNames(code);
  const usesOwn = (text) => OWN_LITERAL.test(text) || [...names].some((n) => mentions(text, n));

  // Line offsets, so each line can be read with its whole statement (calls often span lines).
  const starts = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const statementAt = (i) => {
    const before = code.slice(0, starts[i]);
    const from = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1;
    const end = code.indexOf(';', starts[i]);
    return code.slice(from, end === -1 ? code.length : end + 1);
  };

  // Each test's body (from its test( line to the next one), to know whether it creates its own record at all.
  let testFrom = 0;
  const testOf = lines.map((l, i) => (TEST_START.test(l) ? (testFrom = i) : testFrom));
  const testText = (i) => {
    const from = testOf[i];
    let to = from + 1;
    while (to < lines.length && testOf[to] === from) to += 1;
    return lines.slice(from, to).join('\n');
  };

  return lines.map((line, i) => {
    const quoted = line.match(/(['"`])(?:(?!\1).)*\1/g)?.join(' ') || '';
    const changes = MUTATING_REQUEST.test(line) || (ACTS.test(line) && RISKY_WORD.test(quoted));
    if (!changes) return null;
    const stmt = statementAt(i);
    if (BY_POSITION.test(stmt)) return { level: 'risk', message: 'Acts by position (first/nth/last), not on its own Playwright-Test record' };
    if (usesOwn(stmt)) return { level: 'own', message: "Acts on this test's own Playwright-Test record" };
    // A dialog's confirm button belongs to whatever the test just acted on.
    if (/dialog/i.test(stmt) && usesOwn(testText(i))) return { level: 'own', message: "Confirms an action on this test's own record" };
    // Saving a form the test just filled with its own name creates or saves that record.
    const before = lines.slice(testOf[i], i).join('\n');
    if (/\b(save|submit|create|add|confirm|ok|yes|done)\b/i.test(quoted) && usesOwn(before)) {
      return { level: 'own', message: "Saves this test's own Playwright-Test record" };
    }
    if (usesOwn(testText(i))) return { level: 'risk', message: "Check it acts on this test's own Playwright-Test record" };
    return { level: 'risk', message: 'Changes data, but this test creates no Playwright-Test record' };
  });
}
