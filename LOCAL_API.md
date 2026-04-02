# Code Factory — Local API & MCP Server

> **Security notice**: Every API endpoint is restricted to the local machine.
> Requests arriving from any non-loopback address are rejected with `HTTP 403`.
> Code Factory is a **local-first** tool; never expose its port to the internet.

---

## Table of contents

1. [Overview](#overview)
2. [Quick start](#quick-start)
3. [Security model](#security-model)
4. [MCP server (for AI agents)](#mcp-server)
   - [Claude Desktop config](#claude-desktop--openclaw-config)
   - [All MCP tools](#all-mcp-tools)
5. [REST API reference](#rest-api-reference)
   - [Repositories](#repositories)
   - [Pull Requests](#pull-requests)
   - [Feedback items](#feedback-items)
   - [PR Q&A](#pr-qa)
   - [Logs](#logs)
   - [CI healing sessions](#ci-healing-sessions)
   - [Configuration](#configuration)
   - [Agent models](#agent-models)
   - [Runtime & drain mode](#runtime--drain-mode)
   - [Social changelogs](#social-changelogs)
   - [Onboarding](#onboarding)
6. [Data types](#data-types)
7. [Error handling](#error-handling)
8. [Environment variables](#environment-variables)

---

## Overview

Code Factory runs an **Express HTTP server** (default port `5001`) that serves
both its React dashboard and a machine-readable REST API.  The same API surface
is also exposed as an **MCP (Model Context Protocol) server**, letting any
MCP-compatible agent (Claude Desktop, OpenClaw, etc.) drive Code Factory through
structured tool calls without writing a single line of HTTP client code.

```
┌─────────────────────────────────┐
│  local machine only             │
│                                 │
│  ┌──────────┐    HTTP           │
│  │ OpenClaw │──────────────┐    │
│  │ / Claude │   127.0.0.1  │    │
│  │ Desktop  │   :5001/api  │    │
│  └──────────┘              ▼    │
│       │              ┌──────────┤
│       │ stdio MCP    │ Code     │
│       └─────────────►│ Factory  │
│                       │ server  │
│                       └─────────┤
│                            │    │
│                       SQLite DB │
│                       ~/.oh-my-pr/
└─────────────────────────────────┘
```

---

## Quick start

### 1. Start the Code Factory server

```bash
# development (auto-reloads)
npm run dev

# production
npm run build && npm start
```

The server binds to `0.0.0.0:5001` (configurable via `PORT`), but the
localhost-only middleware rejects every `/api/*` call that does not originate
from `127.0.0.1` or `::1`.

### 2. Call the API

```bash
# List watched repos
curl http://localhost:5001/api/repos

# Add a PR
curl -X POST http://localhost:5001/api/prs \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/owner/repo/pull/42"}'
```

### 3. Use the MCP server

```bash
# Start the MCP server (talks to the running Code Factory on port 5001)
npm run mcp

# Custom port
CODEFACTORY_PORT=5001 npm run mcp
```

---

## Security model

### Localhost-only enforcement

The middleware in `server/localOnly.ts` runs before every `/api/*` handler.
It checks the resolved IP address of each incoming request:

| Source IP              | Allowed? |
|------------------------|----------|
| `127.0.0.1`            | ✅ yes   |
| `::1`                  | ✅ yes   |
| `::ffff:127.x.x.x`     | ✅ yes   |
| `127.x.x.x` (any /8)  | ✅ yes   |
| Everything else        | ❌ 403   |

**What this means in practice**

- Only processes running on the same machine can call the API.
- Docker containers, VMs, LAN peers, and the internet are all rejected.
- The UI (served at `/`) is unaffected — it uses a browser on the same host.

### Running behind a reverse proxy

If you put Nginx or Caddy in front of Code Factory, make sure it forwards
`X-Forwarded-For` and that Express's `trust proxy` setting is configured
appropriately.  If `trust proxy` is not set, `req.ip` will always be
`127.0.0.1` (the proxy itself) — which is fine for a purely local setup but
could allow any traffic the proxy accepts if the proxy is network-facing.

---

## MCP server

The MCP server (`server/mcp.ts`) implements the
[Model Context Protocol](https://modelcontextprotocol.io/) over **stdio**,
the standard transport used by Claude Desktop and most agent frameworks.

It translates every MCP tool call into an HTTP request to `127.0.0.1:5001`,
so the Code Factory main server must be running for any tool to work.

### Claude Desktop / OpenClaw config

Add the following block to your MCP host's configuration file
(`claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "codefactory": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/codefactory/server/mcp.ts"],
      "env": {
        "CODEFACTORY_PORT": "5001"
      }
    }
  }
}
```

Replace `/absolute/path/to/codefactory` with the actual path.

If you have already built the project (`npm run build`), you can use the
compiled output instead:

```json
{
  "mcpServers": {
    "codefactory": {
      "command": "node",
      "args": ["/absolute/path/to/codefactory/dist/mcp.cjs"],
      "env": {
        "CODEFACTORY_PORT": "5001"
      }
    }
  }
}
```

### All MCP tools

| Tool name | Description |
|-----------|-------------|
| `list_repos` | List all watched repositories |
| `add_repo` | Add a repo to the watch list |
| `sync_repos` | Force an immediate sync across all repos |
| `list_prs` | List all tracked pull requests |
| `list_archived_prs` | List archived (closed/merged) PRs |
| `get_pr` | Get full PR details including feedback |
| `add_pr` | Register a PR by GitHub URL |
| `remove_pr` | Remove a PR from tracking |
| `fetch_pr_feedback` | Force-refresh GitHub feedback for a PR |
| `triage_pr` | Auto-triage all un-triaged feedback on a PR |
| `apply_pr_fixes` | Dispatch AI agent to apply accepted fixes |
| `babysit_pr` | Run a full babysit cycle on a PR |
| `set_feedback_decision` | Manually override triage for a feedback item |
| `retry_feedback_item` | Retry a failed/warned feedback item |
| `list_pr_questions` | List Q&A history for a PR |
| `ask_pr_question` | Ask the AI agent a question about a PR |
| `get_logs` | Get activity logs (optional PR filter) |
| `get_config` | Read current configuration |
| `update_config` | Partially update configuration |
| `get_agent_models` | List available AI models |
| `refresh_agent_models` | Rediscover installed agent models |
| `get_runtime` | Get runtime state (drain mode, active runs) |
| `set_drain_mode` | Enable/disable drain mode |
| `list_changelogs` | List social-media changelogs |
| `get_changelog` | Get one changelog by ID |
| `get_onboarding_status` | Check repo onboarding status |
| `install_review_workflow` | Install GitHub Actions review workflow |

---

## REST API reference

**Base URL**: `http://localhost:5001`
**Content-Type**: `application/json` for all request bodies

---

### Repositories

#### `GET /api/repos`

Returns the union of explicitly watched repos and repos inferred from tracked PRs.

**Response** `200`
```json
["owner/repo-a", "owner/repo-b"]
```

---

#### `POST /api/repos`

Add a repository to the watch list.

**Body**
```json
{ "repo": "owner/repo" }
```
Accepts `"owner/repo"` slugs or full `https://github.com/owner/repo` URLs.

**Response** `201`
```json
{ "repo": "owner/repo" }
```

---

#### `POST /api/repos/sync`

Force an immediate babysitter sync cycle across all watched repos.
Returns `409` when drain mode is active.

**Response** `200`
```json
{ "ok": true }
```

---

### Pull Requests

#### `GET /api/prs`

List all actively tracked PRs with full feedback arrays.

**Response** `200` — array of [PR objects](#pr)

---

#### `GET /api/prs/archived`

List archived (closed/merged) PRs.

**Response** `200` — array of [PR objects](#pr)

---

#### `GET /api/prs/:id`

Get a single PR by its internal Code Factory ID.

**Response** `200` — [PR object](#pr)
**Response** `404` — `{ "error": "PR not found" }`

---

#### `POST /api/prs`

Register a GitHub PR by URL. Code Factory fetches the PR summary from GitHub,
stores it, and immediately starts a babysit run.

**Body**
```json
{ "url": "https://github.com/owner/repo/pull/42" }
```

**Response** `201` — [PR object](#pr) (newly created)
**Response** `200` — [PR object](#pr) (already tracked)
**Response** `400` — invalid URL
**Response** `4xx` — GitHub API error

---

#### `DELETE /api/prs/:id`

Remove a PR from tracking.

**Response** `200` — `{ "ok": true }`
**Response** `404` — not found

---

#### `PATCH /api/prs/:id/watch`

Pause or resume background automation for a single tracked PR.

When `enabled` is `false`, the background watcher skips autonomous sync/apply
cycles for that PR, but manual routes such as `POST /api/prs/:id/fetch`,
`POST /api/prs/:id/triage`, `POST /api/prs/:id/apply`, and
`POST /api/prs/:id/babysit` still work. Re-enabling watch schedules an
immediate watcher pass.

**Body**
```json
{ "enabled": false }
```

**Response** `200` — updated [PR object](#pr)
**Response** `400` — invalid body
**Response** `404` — PR not found

---

#### `POST /api/prs/:id/fetch`

Force a fresh pull of comments and reviews from GitHub for this PR.

**Response** `200` — updated [PR object](#pr)

---

#### `POST /api/prs/:id/triage`

Run auto-triage on all un-triaged feedback items.

Classification rules (keyword-based):
- **reject** — contains "lgtm", "looks good"
- **accept** — contains "please", "should", "fix", "error", "fail"
- **flag** — everything else

**Response** `200` — updated [PR object](#pr)

---

#### `POST /api/prs/:id/apply`

Dispatch the configured AI agent to apply all accepted feedback in an isolated
git worktree.  Returns `409` when drain mode is active.

**Response** `200` — updated [PR object](#pr)

---

#### `POST /api/prs/:id/babysit`

Run a full babysit cycle: sync → triage → apply → report.
Returns `409` when drain mode is active.

**Response** `200` — updated [PR object](#pr)

---

### Feedback items

#### `PATCH /api/prs/:id/feedback/:feedbackId`

Manually override the triage decision for a single feedback item.

**Body**
```json
{ "decision": "accept" }
```
Valid values: `"accept"` | `"reject"` | `"flag"`

**Response** `200` — updated [PR object](#pr)

---

#### `POST /api/prs/:id/feedback/:feedbackId/retry`

Re-queue a failed or warned feedback item.

**Response** `200` — updated [PR object](#pr)
**Response** `404` — PR or feedback item not found
**Response** `400` — item is not in a retryable state

---

### PR Q&A

#### `GET /api/prs/:id/questions`

List the full question/answer history for a PR.

**Response** `200` — array of [PRQuestion objects](#prquestion)

---

#### `POST /api/prs/:id/questions`

Ask the configured AI agent a question about the PR.  The question is stored
immediately; the answer is filled in asynchronously.

**Body**
```json
{ "question": "Why does the linter keep failing on line 42?" }
```
Maximum 2000 characters.

**Response** `201` — [PRQuestion object](#prquestion) (answer will be `null` until the agent responds)

---

### Logs

#### `GET /api/logs`

Retrieve activity logs, optionally filtered by PR.

**Query parameters**

| Parameter | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `prId`    | string | Filter to a single PR (optional)     |

**Response** `200` — array of [LogEntry objects](#logentry)

---

### CI healing sessions

#### `GET /api/healing-sessions`

List all persisted healing sessions, newest first.

**Response** `200` — array of [HealingSession objects](#healingsession)

---

#### `GET /api/healing-sessions/:id`

Get one healing session by its internal Code Factory ID.

**Response** `200` — [HealingSession object](#healingsession)
**Response** `404` — `{ "error": "Healing session not found" }`

---

### Configuration

#### `GET /api/config`

Read the current configuration.  The GitHub token is redacted to `***xxxx`.

**Response** `200` — [Config object](#config) (token redacted)

---

#### `PATCH /api/config`

Partially update the configuration.  Only the provided fields are changed.

**Body** (all fields optional)
```json
{
  "githubToken": "ghp_xxxxxxxxxxxx",
  "codingAgent": "claude",
  "maxTurns": 15,
  "batchWindowMs": 300000,
  "pollIntervalMs": 120000,
  "maxChangesPerRun": 10,
  "autoResolveMergeConflicts": true,
  "autoCreateReleases": true,
  "autoUpdateDocs": true,
  "autoHealCI": false,
  "maxHealingAttemptsPerSession": 3,
  "maxHealingAttemptsPerFingerprint": 2,
  "maxConcurrentHealingRuns": 1,
  "healingCooldownMs": 300000,
  "watchedRepos": ["owner/repo"],
  "trustedReviewers": ["alice", "bob"],
  "ignoredBots": ["dependabot", "codecov"]
}
```

**Response** `200` — updated [Config object](#config) (token redacted)

---

### Agent models

#### `GET /api/agent-models`

Get the cached list of available models for each agent type.

**Response** `200`
```json
{
  "claude": ["claude-sonnet-4-6", "claude-opus-4-6"],
  "codex": ["codex-mini-latest", "o4-mini"]
}
```

---

#### `POST /api/agent-models/refresh`

Trigger a fresh model discovery scan (runs `claude model list` / `codex --help`).

**Response** `200` — updated model map (same shape as `GET /api/agent-models`)

---

### Runtime & drain mode

#### `GET /api/runtime`

Get the current runtime state.

**Response** `200`
```json
{
  "drainMode": false,
  "drainRequestedAt": null,
  "drainReason": null,
  "activeRuns": 2
}
```

---

#### `POST /api/runtime/drain`

Enable or disable drain mode.

**Body**
```json
{
  "enabled": true,
  "reason": "Deploying new version",
  "waitForIdle": true,
  "timeoutMs": 120000
}
```

| Field          | Type    | Required | Description                                      |
|----------------|---------|----------|--------------------------------------------------|
| `enabled`      | boolean | yes      | `true` to enable drain mode, `false` to disable  |
| `reason`       | string  | no       | Human-readable reason (stored in state)          |
| `waitForIdle`  | boolean | no       | Block until all active runs finish               |
| `timeoutMs`    | number  | no       | Max wait in ms when `waitForIdle` is true (≤600s)|

**Response** `200` — drained successfully (or disabled)
**Response** `202` — drain enabled but timed out before idle

---

### Social changelogs

#### `GET /api/changelogs`

List all generated social-media changelog posts.

**Response** `200` — array of [SocialChangelog objects](#socialchangelog)

---

#### `GET /api/changelogs/:id`

Get a single social-media changelog by ID.

**Response** `200` — [SocialChangelog object](#socialchangelog)
**Response** `404` — not found

---

### Onboarding

#### `GET /api/onboarding/status`

Check the onboarding status of all watched repositories (e.g., whether the
Code Factory GitHub Actions workflow is installed).

**Response** `200`
```json
[
  {
    "repo": "owner/repo",
    "workflowInstalled": true
  }
]
```

---

#### `POST /api/onboarding/install-review`

Install the Code Factory code-review GitHub Actions workflow on a repository.

**Body**
```json
{
  "repo": "owner/repo",
  "tool": "claude"
}
```
`tool` must be `"claude"` or `"codex"`.

**Response** `200` — installation result object

---

## Data types

### PR

```typescript
{
  id: string;                  // Internal UUID
  number: number;              // GitHub PR number
  title: string;
  repo: string;                // "owner/repo"
  branch: string;
  author: string;
  url: string;                 // Full GitHub URL
  status: "watching" | "processing" | "done" | "error" | "archived";
  feedbackItems: FeedbackItem[];
  accepted: number;            // Count of accepted items
  rejected: number;
  flagged: number;
  testsPassed: boolean | null;
  lintPassed: boolean | null;
  lastChecked: string | null;  // ISO 8601
  watchEnabled: boolean;       // false pauses autonomous watcher runs for this PR
  addedAt: string;             // ISO 8601
}
```

### FeedbackItem

```typescript
{
  id: string;
  author: string;
  body: string;
  bodyHtml: string;
  replyKind: "review_thread" | "review" | "general_comment";
  sourceId: string;
  sourceNodeId: string | null;
  sourceUrl: string | null;
  threadId: string | null;
  threadResolved: boolean | null;
  auditToken: string;
  file: string | null;
  line: number | null;
  type: "review_comment" | "review" | "general_comment";
  createdAt: string;           // ISO 8601
  decision: "accept" | "reject" | "flag" | null;
  decisionReason: string | null;
  action: string | null;
  status: "pending" | "queued" | "in_progress" | "resolved" | "failed" | "warning" | "rejected" | "flagged";
  statusReason: string | null;
}
```

### PRQuestion

```typescript
{
  id: string;
  prId: string;
  question: string;
  answer: string | null;       // null until the agent responds
  status: "pending" | "answering" | "answered" | "error";
  error: string | null;
  createdAt: string;           // ISO 8601
  answeredAt: string | null;   // ISO 8601
}
```

### LogEntry

```typescript
{
  id: string;
  prId: string;
  runId: string | null;
  timestamp: string;           // ISO 8601
  level: "info" | "warn" | "error";
  phase: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
}
```

### Config

```typescript
{
  githubToken: string;         // Redacted to "***xxxx" in GET responses
  codingAgent: "claude" | "codex";
  maxTurns: number;
  batchWindowMs: number;
  pollIntervalMs: number;
  maxChangesPerRun: number;
  autoResolveMergeConflicts: boolean;
  autoCreateReleases: boolean;
  autoUpdateDocs: boolean;
  autoHealCI: boolean;
  maxHealingAttemptsPerSession: number;
  maxHealingAttemptsPerFingerprint: number;
  maxConcurrentHealingRuns: number;
  healingCooldownMs: number;
  watchedRepos: string[];
  trustedReviewers: string[];
  ignoredBots: string[];
}
```

### HealingSession

```typescript
{
  id: string;
  prId: string;
  repo: string;                // "owner/repo"
  prNumber: number;
  initialHeadSha: string;
  currentHeadSha: string;
  state:
    | "idle"
    | "triaging"
    | "awaiting_repair_slot"
    | "repairing"
    | "awaiting_ci"
    | "verifying"
    | "healed"
    | "cooldown"
    | "blocked"
    | "escalated"
    | "superseded";
  startedAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  endedAt: string | null;      // ISO 8601
  blockedReason: string | null;
  escalationReason: string | null;
  latestFingerprint: string | null;
  attemptCount: number;
  lastImprovementScore: number | null;
}
```

### SocialChangelog

```typescript
{
  id: string;
  date: string;                // "YYYY-MM-DD"
  triggerCount: number;        // nth merge that triggered this (5, 10, 15…)
  prSummaries: Array<{
    number: number;
    title: string;
    url: string;
    author: string;
    repo: string;
  }>;
  content: string | null;      // Generated social-media post
  status: "generating" | "done" | "error";
  error: string | null;
  createdAt: string;           // ISO 8601
  completedAt: string | null;  // ISO 8601
}
```

---

## Error handling

All error responses share this shape:

```json
{ "error": "Human-readable description" }
```

| Status | Meaning |
|--------|---------|
| `400`  | Validation error (bad input) |
| `403`  | Request blocked — not from localhost |
| `404`  | Resource not found |
| `409`  | Conflict — e.g. drain mode is active |
| `500`  | Internal server error |

---

## Environment variables

| Variable             | Default        | Description |
|----------------------|----------------|-------------|
| `PORT`               | `5001`         | HTTP port for the Code Factory server |
| `CODEFACTORY_PORT`   | `5001`         | Port the MCP server connects to (MCP only) |
| `OH_MY_PR_HOME`      | `~/.oh-my-pr` | Directory for SQLite DB, logs, repos, worktrees |
| `PR_BABYSITTER_ROOT` | —              | Override worktree root directory |
| `GITHUB_TOKEN`       | —              | GitHub personal access token (falls back to config / `gh auth`) |
| `NODE_ENV`           | `development`  | Set to `production` for production builds |
| `TAURI_DEV`          | —              | Set to skip auto-opening the browser (used by Tauri) |
