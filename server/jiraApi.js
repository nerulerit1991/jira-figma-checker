// Reads a Jira issue straight from the Jira Cloud REST API with an Atlassian API token
// (JIRA_EMAIL + JIRA_API_TOKEN in .env). Fetching costs no tokens; only building the checklist uses a small AI call.

export const jiraApiEnabled = () => Boolean(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);

const FIGMA_LINK = /https?:\/\/(?:www\.)?figma\.com\/[^\s"'<>)\]]+/gi;
const ANY_LINK = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Plain text from Atlassian Document Format (Jira's rich text), keeping paragraphs, list items and link targets. */
function adfToText(node, links = []) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') {
    const href = node.marks?.find((m) => m.type === 'link')?.attrs?.href;
    if (href) links.push(href);
    return node.text || '';
  }
  if (node.type === 'inlineCard' || node.type === 'blockCard' || node.type === 'embedCard') {
    if (node.attrs?.url) links.push(node.attrs.url);
    return node.attrs?.url || '';
  }
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map((c) => adfToText(c, links)).join('');
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  if (['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'panel', 'tableRow'].includes(node.type)) return `${inner}\n`;
  return inner;
}

/**
 * Fetches the issue and returns everything except the checklist, in the jira.json shape.
 * @param {string} jiraUrl the ticket's Jira link; its origin is the Jira site
 * @param {string} key e.g. AXSA-11
 */
export async function fetchJiraIssue(jiraUrl, key) {
  const site = new URL(jiraUrl).origin;
  if (!/\.atlassian\.net$/i.test(new URL(site).hostname)) {
    throw Object.assign(new Error(`The Jira API tab works with Jira Cloud sites (*.atlassian.net); this link is on ${site}.`), { status: 400 });
  }
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  let res;
  try {
    res = await fetch(`${site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names,changelog`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach Jira (${err.cause?.code || err.message}).`), { status: 502 });
  }
  if (!res.ok) {
    const messages = {
      401: 'Jira refused the API token. Check JIRA_EMAIL and JIRA_API_TOKEN in .env (the email must be the account that created the token), then restart the app.',
      403: 'Your Jira account cannot view this issue with the API token.',
      404: `Issue ${key} was not found, or your account cannot see it.`,
      429: 'Jira API rate limit reached. Wait a minute and try again.',
    };
    throw Object.assign(new Error(messages[res.status] || `Jira API error (${res.status}).`), { status: res.status === 404 ? 404 : 502 });
  }
  const issue = await res.json();
  const f = issue.fields || {};
  const names = issue.names || {};

  const links = [];
  const description = adfToText(f.description, links).replace(/\n{3,}/g, '\n\n').trim();
  // Acceptance criteria often live in a custom field named "Acceptance Criteria".
  const acField = Object.keys(names).find((id) => /acceptance/i.test(names[id]) && f[id]);
  const acceptanceText = acField ? adfToText(f[acField], links).trim() : '';

  const allText = `${description}\n${acceptanceText}\n${links.join('\n')}`;
  const unique = (arr) => [...new Set(arr.map((u) => u.replace(/[.,;]+$/, '')))];
  const figmaLinks = unique(allText.match(FIGMA_LINK) || []);
  const otherLinks = unique(allText.match(ANY_LINK) || []).filter((u) => !figmaLinks.includes(u)).slice(0, 20);

  const latest = [...(issue.changelog?.histories || [])].sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];

  return {
    key: issue.key,
    summary: f.summary || '',
    status: f.status?.name || null,
    issueType: f.issuetype?.name || null,
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    labels: f.labels || [],
    lastUpdated: f.updated || null,
    lastUpdatedBy: latest?.author?.displayName || null,
    description,
    acceptanceText,
    figmaLinks,
    otherLinks,
  };
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Status of several issues on one Jira Cloud site (`site`: e.g. https://x.atlassian.net), for MyTeam's dependencies,
 * with the issues each one "is blocked by" (Jira's Blocks link type). Read-only, Jira API only (no AI / MCP call).
 * @returns {Promise<{ issues: object[], errors: Record<string, string> }>}
 */
export async function fetchIssueStatuses(site, keys) {
  const list = [...new Set((Array.isArray(keys) ? keys : []).map((k) => String(k).trim().toUpperCase()))].filter((k) => ISSUE_KEY.test(k)).slice(0, 20);
  if (!list.length) throw Object.assign(new Error('No valid issue keys (e.g. SCRUM-5).'), { status: 400 });
  const issues = [];
  const errors = {};
  await Promise.all(
    list.map(async (key) => {
      try {
        const issue = await jiraRequest(site, `/issue/${encodeURIComponent(key)}?fields=summary,status,issuelinks`);
        const f = issue?.fields || {};
        const row = {
          key: issue?.key || key,
          summary: f.summary || '',
          status: f.status?.name || null,
          // Jira's status category: "new" (To Do), "indeterminate" (In Progress), "done".
          statusCategory: f.status?.statusCategory?.key || null,
          url: `${new URL(site).origin}/browse/${issue?.key || key}`,
          // "SCRUM-4 is blocked by SCRUM-5": on SCRUM-4 that link holds SCRUM-5 as its inward issue. "relates to" is not a blocker.
          blockedBy: (Array.isArray(f.issuelinks) ? f.issuelinks : [])
            .filter((l) => l.inwardIssue?.key && /blocked by/i.test(l.type?.inward || ''))
            .map((l) => l.inwardIssue.key),
        };
        issues.push(row);
      } catch (error) {
        errors[key] = error.message;
      }
    }),
  );
  issues.sort((a, b) => list.indexOf(a.key) - list.indexOf(b.key));
  return { issues, errors };
}

/** Calls the Jira Cloud REST API v3 on the ticket's site with the .env token; throws with a readable message. */
async function jiraRequest(jiraUrl, pathname, { method = 'GET', body } = {}) {
  const site = new URL(jiraUrl).origin;
  if (!/\.atlassian\.net$/i.test(new URL(site).hostname)) {
    throw Object.assign(new Error(`The Jira API works with Jira Cloud sites (*.atlassian.net); this link is on ${site}.`), { status: 400 });
  }
  if (!jiraApiEnabled()) throw Object.assign(new Error('Jira API is not set up: add JIRA_EMAIL and JIRA_API_TOKEN to .env.'), { status: 400 });
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  let res;
  try {
    res = await fetch(`${site}/rest/api/3${pathname}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach Jira (${err.cause?.code || err.message}).`), { status: 502 });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const detail = [...(data?.errorMessages || []), ...Object.values(data?.errors || {})].join(' ');
    const messages = {
      401: 'Jira refused the API token. Check JIRA_EMAIL and JIRA_API_TOKEN in .env.',
      403: 'Your Jira account is not allowed to do this on the issue.',
      404: 'The issue was not found, or your account cannot see it.',
    };
    throw Object.assign(new Error(`${messages[res.status] || `Jira API error (${res.status}).`}${detail ? ` ${detail}` : ''}`), { status: res.status === 404 ? 404 : 502 });
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/**
 * Moves the issue to the status named `statusName` (matched by name, case-insensitive, since transition ids differ per
 * workflow). Already there → nothing to do. No transition to that status → skipped, with the statuses it can go to.
 * `dryRun` reports what would happen without changing the issue.
 * @returns {Promise<{ state: 'moved' | 'unchanged' | 'skipped' | 'would-move', from: string|null, to: string, message: string, available?: string[] }>}
 */
export async function transitionJiraIssue(jiraUrl, key, statusName, { dryRun = false } = {}) {
  const target = String(statusName || '').trim();
  if (!target) throw Object.assign(new Error('A status name is required.'), { status: 400 });
  const same = (a) => String(a || '').trim().toLowerCase() === target.toLowerCase();
  const id = encodeURIComponent(key);

  const issue = await jiraRequest(jiraUrl, `/issue/${id}?fields=status`);
  const from = issue?.fields?.status?.name || null;
  if (same(from)) return { state: 'unchanged', from, to: from, message: `${key} is already ${from}.` };

  const { transitions = [] } = (await jiraRequest(jiraUrl, `/issue/${id}/transitions`)) || {};
  const move = transitions.find((t) => same(t.to?.name)) || transitions.find((t) => same(t.name));
  if (!move) {
    const available = [...new Set(transitions.map((t) => t.to?.name).filter(Boolean))];
    return { state: 'skipped', from, to: target, available, message: `${key} cannot move from ${from} to "${target}" (it can go to: ${available.join(', ') || 'nothing'}).` };
  }
  const to = move.to?.name || target;
  if (dryRun) return { state: 'would-move', from, to, message: `${key} would move from ${from} to ${to}.` };
  await jiraRequest(jiraUrl, `/issue/${id}/transitions`, { method: 'POST', body: { transition: { id: move.id } } });
  return { state: 'moved', from, to, message: `${key} moved from ${from} to ${to}.` };
}
