# Jira + Figma UI Checker

A Vue app that uses either Claude or Codex to read Jira tickets and Figma designs through MCP, save both as JSON, then check a live page against a checklist built from the ticket. Choose the active agent from the **Connections** dropdown.

## How it works

| Step | What happens | Tokens |
|---|---|---|
| Retrieve Jira | The selected agent reads the issue through Jira/Atlassian MCP, returns ticket data plus a UI checklist, saved to `data/<KEY>/jira.json` | Only the first time (or on Re-fetch) |
| Retrieve Figma | The selected agent reads the design through Figma MCP, saved to `data/<KEY>/figma.json`. The Figma link comes from the input or the ticket | Only the first time (or on Re-fetch) |
| Check UI | Playwright renders the URL at desktop (1440), tablet (768) and mobile (375), scrolling through first so lazy images and scroll animations load: screenshot tiles (desktop up to 6, tablet/mobile up to 3), computed styles and an automatic layout scan (horizontal scroll, off-screen elements, clipped text, tiny text, small tap targets). The selected agent checks (1) the Jira checklist, (2) a design checklist (typography, colours, spacing, sizing & shape, copy) with brief per-section issues for anything that doesn't follow Figma, and (3) whether each viewport's layout is broken. Results go to `data/<KEY>/check.json` | Each check (3 screenshots per check) |
| MCP status | Read from the selected agent's configured connection list without sending a prompt | None |

Jira and Figma **MCP extraction** (Jira MCP, Figma MCP, Desktop bridge) always runs on a small model at low effort: `claude-haiku-5-5` with `effort: 'low'` (override with `CLAUDE_EXTRACT_MODEL`), or Codex with `model_reasoning_effort="low"` (model via `CODEX_EXTRACT_MODEL`). The checklist, Check UI and test generation keep `CLAUDE_MODEL`.

**Errors only.** Every check also writes `data/<KEY>/check-errors.json` (failed checklist items, failed design categories and rows, broken viewports). **Re-check N errors** renders only the viewports those errors need and sends only them, with the matching Figma and page sections, then merges the verdicts into `check.json`; items that passed before are not checked again. Every test run also writes `tests/errors.json` and `global-tests/errors.json` with only the failed tests; **Re-run N failed** in card 03 runs only the tests that failed last time (ticket and global, no tokens) and merges their new results into the saved run.

Claude runs are limited to the one MCP server needed and read-style tools. Codex runs use `codex exec`, enable only the requested MCP server, and run with a read-only workspace sandbox.

## Functional & API tests

**Generate tests** (uses tokens once): the selected agent reads the saved Jira ticket plus a scan of the live page and writes ticket-specific Playwright scripts. Shared baseline cases in `data/global-test-cases/cases.json` are supplied as exclusions so they are not repeated in every ticket's scripts. **Run all tests** uses no tokens and runs both the saved ticket scripts and the shared global suite; global results are saved separately per ticket under `data/<KEY>/global-tests/`.

Scripts live with the ticket, so deleting the ticket deletes them:

```
data/<KEY>/tests/behavior.spec.js     functionality from the acceptance criteria (desktop + mobile)
data/<KEY>/tests/api.spec.js          ticket-specific API calls
data/<KEY>/tests/tests.json           what was generated, by which run, at what cost
data/<KEY>/tests/results.json         last run
data/global-test-cases/cases.json     shared cases excluded from ticket-specific generation
data/global-test-cases/global.spec.js reusable Playwright checks run against the ticket's page URL
```

**Pages behind a login.** Put a test account in `.env` (`PROJECT_USERNAME_EMAIL`, `PROJECT_PASSWORD`; never a real person's account) and restart the server. With **Requires login** (under Page URL in card 01) on, Check UI, Generate tests and Run all tests first sign in with it and use that session. With it off, each run first opens the page signed out: if it redirects to a login form (or answers 401/403), the toggle turns on by itself, the app signs in at that login page, and the run continues on the signed-in page. A page that is itself a login form, with no redirect, is treated as the page under test. The password is only typed on the page's own site (or `PROJECT_LOGIN_URL`'s): a redirect to another site's sign-in is never filled in, and sign-in stops with a clear message at a CAPTCHA or a one-time-code (MFA) screen. Switching **Requires login** off stays off: runs no longer turn it back on for that ticket. Sign-in starts at `PROJECT_LOGIN_URL` when set, otherwise at the detected login page or the page URL. The session is saved to `data/<KEY>/.auth/` (git-ignored, owner-only) and reused by later runs while it still gets past the login; once the site sends it back to the login page, the next run signs in again. **Sites with an image CAPTCHA or a one-time code (OTP):** sign-in runs in a hidden browser and asks for what only a person can type in a pop-up in the app: **CAPTCHA** (with the picture from the login page) or **OTP** (from the email or SMS the site sent). Type it and click Submit; a rejected value is asked again (up to 3 tries) with the site's error message, and nothing is ever sent to the site twice. The app waits up to 5 minutes per pop-up; Cancel stops the sign-in. Widget CAPTCHAs such as reCAPTCHA cannot be answered this way. **Sign in now** signs in ahead of a run; **Forget session** deletes the saved session. The `PROJECT_*` variables stay in the server: they are not passed to the AI agents, MCP servers or test scripts.

Generated code is checked before it is saved and before every run: only `@playwright/test` may be imported; no `require`, dynamic import, `process`, `fs`, `eval`, `Function` or `child_process`; and URLs are limited to the site under test and the API calls seen in the scan. You can read the scripts under **View scripts**.

## Reading Figma: MCP, Desktop bridge or Figma API

The Figma field has three tabs. Each tab uses only its own source; if it fails you get that source's error, and
nothing falls back to another source.

| Tab | Reads from | Uses AI tokens |
|---|---|---|
| **MCP** | The selected agent's Figma MCP server, for the pasted link | Yes |
| **Desktop bridge** | The frame selected in the Figma desktop app (bridge plugin running) | Yes |
| **Figma API** | The Figma REST API, for the pasted link | No |

**Figma API** needs a personal access token in `.env` as `FIGMA_TOKEN` (Figma → Settings → Security → Personal
access tokens; scopes **File content: Read** and **File versions: Read**); restart the app after adding it. Paste
the whole Figma URL: the entire file is downloaded once into `data/full-figma/<fileKey>.json`, shared by every
ticket, and the ticket's `figma.json` gets the linked frame (or the first frame when the link has no `node-id`):
exact positions, sizes, fonts and colours, each icon's visible bounds, and who last edited the file. Other tickets
on the same file reuse the saved file without calling Figma; **Re-fetch Figma** downloads it again.

## Fixing connections in one click

In the sidebar, any connection that is not green is clickable:

| Connection | What one click does |
|---|---|
| Agent dropdown | Switches between Claude and Codex. The selection is saved in `data/app-settings.json` and applies to subsequent AI actions. |
| Claude / Codex (not logged in) | Starts that agent's sign-in flow. |
| Jira / Figma (Claude selected) | Adds or uses local Claude Code MCP servers and starts their OAuth flow. |
| Jira / Figma (Codex selected) | Uses local Codex MCP configuration and starts the server's OAuth flow. |
| Browser (missing) | Installs Playwright's Chromium for page capture. |
## Multiple tickets

Use **New ticket** to add a Jira link, then switch between tickets with the searchable dropdown. **Delete** removes the selected ticket's folder; **Reset all** removes every ticket. Both ask for confirmation first.

## Setup

Needs **Node.js 22.12 or newer** (macOS, Linux or Windows).

```bash
npm install
npm run setup           # creates .env from .env.example (if missing) and downloads Chromium
npm run dev             # API on :3001, UI on http://localhost:5173
npm run dev:rtk          # macOS/Linux only: same app, with Claude Agent SDK traffic routed through RTK Proxy
```

Then fill in `.env` with **your own** tokens (`FIGMA_TOKEN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and a test account in
`PROJECT_*` if pages need a login) and restart `npm run dev`. Never copy someone else's `.env`.

### Sharing this project
Share it through Git (only files not in `.gitignore`). If you send a zip instead, leave out `node_modules/`, `.env`,
`data/` (except `data/global-test-cases/`), `.tools/` and `dist/`: `node_modules` and `.tools` hold binaries for the
sender's OS, and `.env` / `data/*/.auth/` hold personal tokens and login sessions.

### Windows notes
- Use PowerShell or Windows Terminal; `npm run setup` and `npm run dev` work as on macOS.
- The RTK proxy scripts (`dev:rtk`, `rtk:proxy:*`) use macOS/Linux binaries and do not run on Windows.
- Codex mode finds the Codex CLI by itself (`server/codexCli.js`): `CODEX_CLI_PATH` in `.env`, then `codex.exe` on
  `PATH`, then an npm install (`npm i -g @openai/codex`), then the `codex.exe` bundled with the Codex desktop app.
  If it still reports `spawn codex ENOENT`, set `CODEX_CLI_PATH` to the full path of `codex.exe`.

### Claude login
The server uses the Claude Agent SDK, which needs either:
- a Claude Code login on this machine (`npx @anthropic-ai/claude-code`, then `/login`), or
- `ANTHROPIC_API_KEY` in `.env` (copy `.env.example`).

### Codex login and MCP
Codex mode uses the local Codex CLI login and MCP configuration (`codex login status`, `codex mcp list`). Install and sign in to Codex CLI, then add/authorize the MCP servers you want the app to use. The app only sees servers configured for Codex; Claude connector credentials are not transferred. The Codex CLI's Figma MCP can be used when enabled. Jira MCP requires a Jira/Atlassian server configured in Codex; the Jira API tab is independent and its checklist AI work uses the selected agent.

### Optional RTK Proxy
The RTK Proxy can normalize and selectively compress Anthropic API tool results before Claude sees them. It can therefore reduce input tokens for some Jira/Figma MCP calls; savings depend on the returned data and compression rules. It does not reduce every request. The Jira REST and Figma API tabs already fetch directly without AI tokens.

The project-local RTK binaries live in the ignored `.tools/` folder. `npm run dev:rtk` starts the daemon and routes this app's Claude Agent SDK traffic through it; `npm run rtk:proxy:status` checks whether it is running. Codex mode runs through the Codex CLI and is not routed through the Anthropic-only RTK proxy. The proxy's default normalization removes noisy formatting and duplicate output; meaningful savings depend on how much noise a tool result contains, so it will not lower the cost of every Jira or Figma MCP call.

### MCP servers
This project ships a `.mcp.json` with the Atlassian (`atlassian-ui-checker`) and Figma (`figma-ui-checker`) remote
MCP servers, so the app and Claude Code opened in this folder pick them up without manual setup. Each person still signs
in once: click Jira / Figma in the app's Connections panel, or run `/mcp` in Claude Code. The optional Figma desktop
bridge is a local server; add it per machine:

```bash
claude mcp add --scope user figma-bridge -- npx -y @gethopp/figma-mcp-bridge
```

On native Windows use `cmd /c npx -y @gethopp/figma-mcp-bridge` as the command.

Claude loads MCP servers from Claude Code settings and this project's `.mcp.json`; names are matched with `JIRA_MCP_MATCH` / `FIGMA_MCP_MATCH` in `.env`. The app ignores Claude.ai account-level connectors and uses local MCP OAuth sessions. Codex loads servers from the local Codex CLI configuration; names containing Jira/Atlassian or Figma are matched automatically.

- **Figma**: the **MCP** and **Desktop bridge** tabs use the selected agent's configured Figma server. Figma API mode is independent of the agent selection.
- **Jira**: Claude and Codex each use their own Atlassian MCP OAuth session. Jira API mode is independent of MCP and its AI checklist uses the selected agent.

## Project layout

```
server/   Express API, Agent SDK wrapper, prompts, Playwright capture, JSON store
src/      Vue 3 UI (App.vue, McpStatus, Checklist)
data/     One folder per ticket (git-ignored):
          data/<KEY>/ticket.json   Jira, Figma and page links
          data/<KEY>/jira.json     ticket data + checklist
          data/<KEY>/figma.json    design data
          data/<KEY>/check.json    last UI check results
          data/<KEY>/check-errors.json  only what failed in the last check (used by Re-check)
          data/<KEY>/screenshot-{desktop,tablet,mobile}.jpg
```
