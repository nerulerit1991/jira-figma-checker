// Small JavaScript highlighter for the generated test scripts.
// Returns plain token objects (never HTML), so untrusted script text is always rendered as text.

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'export', 'extends',
  'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'switch',
  'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'this']);

// Tried in order at each position; `regex` only where a regex literal can start (not after a value).
const RULES = [
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', /'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?/y],
  ['string', /`(?:\\[\s\S]|[^`\\])*`?/y],
  ['regex', /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*/y],
  ['number', /\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y],
  ['ident', /[A-Za-z_$][\w$]*/y],
  ['space', /\s+/y],
  ['punct', /[^\sA-Za-z_$\d'"`/]+|\//y],
];

// After these, a "/" starts a regex literal rather than a division.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$|^$/;

function tokenize(code) {
  const tokens = [];
  let pos = 0;
  let prev = ''; // last non-space token text
  let prevType = '';
  while (pos < code.length) {
    let matched = false;
    for (const [type, re] of RULES) {
      if (type === 'regex' && !(REGEX_AFTER.test(prev) || (prevType === 'keyword' && prev !== 'this'))) continue;
      re.lastIndex = pos;
      const m = re.exec(code);
      if (!m || !m[0]) continue;
      let kind = type;
      if (type === 'ident') {
        const rest = code.slice(pos + m[0].length);
        if (KEYWORDS.has(m[0])) kind = 'keyword';
        else if (LITERALS.has(m[0])) kind = 'literal';
        else if (/^\s*\(/.test(rest)) kind = 'fn';
        else if (code[pos - 1] === '.') kind = 'prop';
        else kind = 'plain';
      }
      tokens.push({ type: kind, text: m[0] });
      if (type !== 'space' && type !== 'comment') {
        prev = m[0];
        prevType = kind;
      }
      pos += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ type: 'plain', text: code[pos] });
      prev = code[pos];
      prevType = 'plain';
      pos += 1;
    }
  }
  return tokens;
}

/** Splits the highlighted code into lines of tokens (a comment or template string may span lines). */
export function highlightLines(code) {
  const lines = [[]];
  for (const tok of tokenize(code)) {
    const parts = tok.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines.at(-1).push({ type: tok.type, text: part });
    });
  }
  return lines;
}

// test(…), test.only(…), test.fixme(…) and the like; test.describe/step/use/skip(…) are not tests themselves.
const TEST_CALL = /\b(?:test|it)\s*(?:\.\s*(?:only|fixme|fail|slow)\s*)?\(/;

/** Whether the script declares any test, ignoring comments and strings (where the word "test(" may appear). */
export function hasTestCalls(code) {
  const live = tokenize(code).filter((t) => t.type !== 'comment' && t.type !== 'string' && t.type !== 'regex');
  return TEST_CALL.test(live.map((t) => t.text).join(''));
}
