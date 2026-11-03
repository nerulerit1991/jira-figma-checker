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
