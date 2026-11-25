// Finds keys and secrets exposed in a site's shipped code (HTML, JS, JSON the browser downloads).
// Values are masked before they leave this file: the app never stores or shows a full secret.
//
// Severity:
//   high    a secret that must never reach the browser (private keys, secret API keys, DB URLs with passwords)
//   medium  probably a secret, but needs a human look (tokens, "apiKey: '...'" style assignments)
//   info    keys meant to be public (Stripe publishable, Google API keys): fine only if restricted in their console

const RULES = [
  { id: 'private-key', label: 'Private key', severity: 'high', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', label: 'AWS access key ID', severity: 'high', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'aws-secret', label: 'AWS secret access key', severity: 'high', re: /aws[\w-]{0,20}secret[\w-]{0,20}["']?\s*[:=]\s*["']([A-Za-z0-9/+]{40})["']/gi, group: 1 },
  { id: 'stripe-secret', label: 'Stripe secret / restricted key', severity: 'high', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g },
  { id: 'github-token', label: 'GitHub token', severity: 'high', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { id: 'gitlab-token', label: 'GitLab token', severity: 'high', re: /\bglpat-[A-Za-z0-9_-]{20}\b/g },
  { id: 'slack-token', label: 'Slack token', severity: 'high', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { id: 'slack-webhook', label: 'Slack webhook URL', severity: 'high', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { id: 'openai-key', label: 'OpenAI API key', severity: 'high', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-proj-[A-Za-z0-9_-]{40,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', severity: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'sendgrid-key', label: 'SendGrid API key', severity: 'high', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'db-url', label: 'Database URL with password', severity: 'high', re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?):\/\/[^\s:'"@/]+:[^\s'"@/]+@[^\s'"]+/g },
  { id: 'jwt', label: 'JWT token', severity: 'medium', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'stripe-publishable', label: 'Stripe publishable key', severity: 'info', re: /\bpk_(?:live|test)_[0-9A-Za-z]{20,}\b/g },
  { id: 'google-api-key', label: 'Google API key', severity: 'info', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: 'assignment',
    label: 'Hard-coded secret',
    severity: 'medium',
    // apiKey: "…", client_secret = '…', "password":"…" (the value is what gets reported).
    re: /["']?\b(?:api[_-]?key|apikey|api[_-]?secret|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)\b["']?\s*[:=]\s*["']([^"'\s]{8,200})["']/gi,
    group: 1,
  },
];

// Values of "apiKey: '…'" style matches that are placeholders or code, not secrets.
const PLACEHOLDER = /^(?:x+|\*+|\.+|-+|<[^>]*>|\$\{.*\}|%[^%]+%|\{\{.*\}\}|(?:your|my|example|sample|test|dummy|placeholder|changeme|undefined|null|true|false|password|secret|api[_-]?key|token)[\w-]*)$/i;
const MAX_BODY = 6 * 1024 * 1024;
// In context snippets, any long token-like run is masked too, in case it is a secret no rule knows.
// Only runs of 20+ characters mixing letters and digits (what keys look like), so words such as X-Amz-Algorithm stay readable.
const LONG_TOKEN = /[A-Za-z0-9_+/-]{20,}/g;
const maskTokens = (text) => text.replace(LONG_TOKEN, (t) => (/[0-9]/.test(t) && /[A-Za-z]/.test(t) ? mask(t) : t));

/** First 4 and last 4 characters, the rest hidden: enough to recognise the key, not to use it. */
export function mask(value) {
  const v = String(value);
  if (v.length <= 12) return `${v.slice(0, 2)}${'•'.repeat(6)}`;
  return `${v.slice(0, 4)}${'•'.repeat(8)}${v.slice(-4)}`;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Every secret in `text`: [{ rule, start, end, value }], specific rules first; the generic rule skips their values. */
// An AWS access key ID inside a presigned URL (X-Amz-Credential=ASIA…/date/region/s3/aws4_request, raw or URL-encoded).
// Expected: it is only the key ID (never the secret) plus a signature that expires, so it is reported as info.
const PRESIGNED = { id: 'aws-presigned-url', label: 'AWS presigned URL (temporary key ID)', severity: 'info' };
const PRESIGNED_BEFORE = /X-Amz-Credential(?:=|%3D)$/i;

function findSpans(text) {
  const spans = [];
  const values = new Set();
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    for (let m; (m = re.exec(text)); ) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value) continue;
      if (rule.id === 'assignment' && (values.has(value) || PLACEHOLDER.test(value) || /^[\w.]+\(|^\w+\.\w+$/.test(value))) continue;
      const start = m.index + (rule.group ? m[0].indexOf(value) : 0);
      const presigned = rule.id === 'aws-access-key' && PRESIGNED_BEFORE.test(text.slice(Math.max(0, start - 20), start));
      spans.push({ rule: presigned ? PRESIGNED : rule, start, end: start + value.length, value });
      values.add(value);
    }
  }
  return spans;
}

/** text[from, to) with every secret overlapping it masked whole (the window grows to cover a secret cut at its edge). */
function maskedSlice(text, from, to, spans) {
  const inside = spans.filter((s) => s.end > from && s.start < to).sort((a, b) => a.start - b.start);
  let out = '';
  let at = Math.min(from, ...inside.map((s) => s.start));
  const end = Math.max(to, ...inside.map((s) => s.end));
  for (const s of inside) {
    if (s.start < at) continue; // overlaps a secret already masked
    out += maskTokens(text.slice(at, s.start)) + mask(s.value);
    at = s.end;
  }
  return out + maskTokens(text.slice(at, end));
}

/** `text` with every secret, and any long token-like string, masked: safe to store and show (e.g. an API error body). */
export function redact(text) {
  const t = String(text ?? '');
  return maskedSlice(t, 0, t.length, findSpans(t));
}

/**
 * Secrets in `text` (one downloaded file). Returns [{ rule, label, severity, masked, line, context, fingerprint }],
 * where `context` is ~40 characters on each side with every secret in it masked. Nothing unmasked is returned.
 */
export function scanForSecrets(text) {
  if (!text || text.length > MAX_BODY) return [];
  const spans = findSpans(text);
  const seen = new Set();
  const found = [];
  for (const span of spans) {
    const id = `${span.rule.id}|${span.value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const masked = mask(span.value);
    // Presigned URLs: how long the link stays valid (X-Amz-Expires, seconds), to flag long-lived ones.
    const expires = span.rule === PRESIGNED ? /X-Amz-Expires(?:=|%3D)(\d+)/i.exec(text.slice(span.end, span.end + 600))?.[1] : null;
    found.push({
      rule: span.rule.id,
      ...(expires ? { expiresIn: Number(expires) } : {}),
      label: span.rule.label,
      severity: span.rule.severity,
      masked,
      line: lineAt(text, span.start),
      // 0-based, like DevTools' "Go to line:column" minus one; used to map minified files through source maps.
      column: span.start - (text.lastIndexOf('\n', span.start - 1) + 1),
      context: maskedSlice(text, Math.max(0, span.start - 40), span.end + 40, spans).replace(/\s+/g, ' ').trim(),
      // Merges the same secret found in several files, without keeping the value.
      fingerprint: `${span.rule.id}|${span.value.length}|${masked}`,
    });
  }
  return found;
}
