# oh-my-pr — Local API & MCP Server

> **Security notice**: Every API endpoint is restricted to the local machine.
> Requests arriving from any non-loopback address are rejected with `HTTP 403`.
> oh-my-pr is a **local-first** tool; never expose its port to the internet.

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
   - [Deployment healing sessions](#deployment-healing-sessions)
   - [Configuration](#configuration)
   - [App updates](#app-updates)
   - [Runtime & drain mode](#runtime--drain-mode)
   - [Social changelogs](#social-changelogs)
   - [Releases](#releases)
   - [Onboarding](#onboarding)
6. [Data types](#data-types)
7. [Error handling](#error-handling)
8. [Environment variables](#environment-variables)

---

## Overview

oh-my-pr runs an **Express HTTP server** (default port `5001`) that serves
both its React dashboard and a machine-readable REST API.  The same API surface
is also exposed as an **MCP (Model Context Protocol) server**, letting any
MCP-compatible agent (Claude Desktop, OpenClaw, etc.) drive oh-my-pr through
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
│       │ stdio MCP    │ oh-my-pr │
│       └─────────────►│ server   │
│                       │ server  │
│                       └─────────┤
│                            │    │
│                       SQLite DB │
│                       ~/.oh-my-pr/
└─────────────────────────────────┘
```

Most long-running runtime actions are **durable and queue-backed**. Repository
sync, initial and manual babysit/apply runs, feedback retries, PR question
answering, release processing, merge-triggered deployment healing, and social
changelog generation are first persisted in SQLite and then claimed by a
dispatcher with leases and heartbeats. Queued work survives process restarts;
on startup, expired leases are re-queued, and interrupted babysitter runs are
resumed from stored run context when possible.

---

## Quick start

### 1. Start the oh-my-pr server

```bash
# development (auto-reloads)
npm run dev

# production
npm run build && npm start
```

The server binds to `0.0.0.0:5001` (configurable via `PORT`), but the
localhost-only middleware rejects every `/api/*` call that does not originate
from `127.0.0.1` or `::1`.

If you enable deployment healing for Vercel or Railway repositories, install
and authenticate the matching platform CLI on the same machine:
`vercel` for Vercel and `railway` for Railway.

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
# Start the MCP server (talks to the running oh-my-pr server on port 5001)
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

If you put Nginx or Caddy in front of oh-my-pr, make sure it forwards
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
so the oh-my-pr main server must be running for any tool to work.

### Claude Desktop / OpenClaw config

Add the following block to your MCP host's configuration file
(`claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "oh-my-pr": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/oh-my-pr/server/mcp.ts"],
      "env": {
        "CODEFACTORY_PORT": "5001"
      }
    }
  }
}
```

Replace `/absolute/path/to/oh-my-pr` with the actual path.

If you have already built the project (`npm run build`), you can use the
compiled output instead:

```json
{
  "mcpServers": {
    "oh-my-pr": {
      "command": "node",
      "args": ["/absolute/path/to/oh-my-pr/dist/mcp.cjs"],
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
| `list_repos` | List watched repositories plus repos inferred from tracked PRs |
| `add_repo` | Add a repo to the watch list (defaults to `My PRs only` discovery) |
| `sync_repos` | Queue an immediate durable sync across all watched repos |
| `list_prs` | List all tracked pull requests |
| `list_archived_prs` | List archived (closed/merged) PRs |
| `get_pr` | Get full PR details including feedback |
| `add_pr` | Register a PR by GitHub URL and queue its initial babysit run |
| `remove_pr` | Remove a PR from tracking |
| `fetch_pr_feedback` | Force-refresh GitHub feedback for a PR |
| `triage_pr` | Auto-triage all un-triaged feedback on a PR |
| `apply_pr_fixes` | Queue AI work to apply accepted fixes |
| `babysit_pr` | Queue a full babysit cycle on a PR |
| `set_feedback_decision` | Manually override triage for a feedback item |
| `retry_feedback_item` | Retry a failed/warned feedback item |
| `list_pr_questions` | List Q&A history for a PR |
| `ask_pr_question` | Store a PR question and queue asynchronous answering |
| `get_logs` | Get activity logs (optional PR filter) |
| `get_config` | Read current configuration |
| `update_config` | Partially update configuration |
| `get_runtime` | Get runtime state (drain mode, active queue handlers) |
| `set_drain_mode` | Enable/disable drain mode for new queue claims |
| `list_changelogs` | List social-media changelogs |
| `get_changelog` | Get one changelog by ID |
| `get_onboarding_status` | Check repo onboarding status |
| `install_review_workflow` | Install GitHub Actions review workflow |
| `list_deployment_healing_sessions` | List deployment-healing sessions, optionally filtered by repo |
| `get_deployment_healing_session` | Get one deployment-healing session by ID |

`update_config` exposes the MCP schema's config subset. Use `PATCH /api/config`
for fields that are REST-writable but not exposed by the MCP schema today,
including release automation, CI healing, and deployment-healing keys.

---

## REST API reference

**Base URL**: `http://localhost:5001`
**Content-Type**: `application/json` for all request bodies

---

### Repositories

#### `GET /api/repos`

Returns the union of explicitly watched repos and repos inferred from tracked PRs.
Use `GET /api/repos/settings` when you need per-repo settings such as
`ownPrsOnly`.

**Response** `200`
```json
["owner/repo-a", "owner/repo-b"]
```

---

#### `GET /api/repos/settings`

Returns repo-level settings for explicitly watched repos plus any repos inferred
from currently tracked PRs.

`ownPrsOnly: true` means the watcher auto-discovers only PRs authored by the
authenticated GitHub user for that repo. `ownPrsOnly: false` enables team-wide
discovery and auto-discovers all open PRs in the repo.

**Response** `200` — array of [WatchedRepo objects](#watchedrepo)

---

#### `POST /api/repos`

Add a repository to the watch list.

**Body**
```json
{ "repo": "owner/repo" }
```
Accepts `"owner/repo"` slugs or full `https://github.com/owner/repo` URLs.

New watched repos default to `ownPrsOnly: true` (`My PRs only`). To switch a
repo to team-wide discovery, call `PATCH /api/repos/settings` after adding it.

**Response** `201`
```json
{ "repo": "owner/repo" }
```

---

#### `PATCH /api/repos/settings`

Update repo-level settings.

`ownPrsOnly: true` keeps auto-discovery limited to PRs authored by the
authenticated GitHub user. `ownPrsOnly: false` switches the repo to team-wide
auto-discovery. Changing this setting does not remove PRs that were already
tracked directly by URL.

**Body**
```json
{
  "repo": "owner/repo",
  "ownPrsOnly": false,
  "autoCreateReleases": true
}
```

Provide `repo` plus one or both of `ownPrsOnly` and `autoCreateReleases`.

**Response** `200` — updated [WatchedRepo object](#watchedrepo)
**Response** `400` — invalid body or no settings provided

---

#### `POST /api/repos/sync`

Queue an immediate durable watcher pass across all watched repos. The queued
sync job performs GitHub reconciliation and then enqueues follow-up babysit,
release, and changelog work as needed. Returns `409` when drain mode is active.

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

Get a single PR by its internal oh-my-pr ID.

**Response** `200` — [PR object](#pr)
**Response** `404` — `{ "error": "PR not found" }`

---

#### `POST /api/prs`

Register a GitHub PR by URL. oh-my-pr fetches the PR summary from GitHub,
stores it, and queues an initial durable babysit run.

This direct registration path is independent of watched-repo discovery scope,
so the PR stays tracked even if its repo is configured as `ownPrsOnly: true`.

**Body**
```json
{ "url": "https://github.com/owner/repo/pull/42" }
```

**Response** `201` — [PR object](#pr) (newly created)
**Response** `201` — [PR object](#pr) (already tracked)
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

Queue the configured AI agent to apply all accepted feedback in an isolated git
worktree. The route returns once the durable job has been stored, not when the
agent run completes. Returns `409` when drain mode is active.

**Response** `200` — updated [PR object](#pr)

---

#### `POST /api/prs/:id/babysit`

Queue a full babysit cycle: sync → triage → apply → report. The route returns
once the durable job has been stored, not when the run finishes. Returns `409`
when drain mode is active.

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

Re-queue a failed or warned feedback item by scheduling another durable
babysit pass for the PR.

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
immediately; a durable background job fills in the answer asynchronously. Both
the question row and the queued answer job persist in SQLite, so pending
questions survive app restarts.

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

Get one healing session by its internal oh-my-pr ID.

**Response** `200` — [HealingSession object](#healingsession)
**Response** `404` — `{ "error": "Healing session not found" }`

---

### Deployment healing sessions

Deployment-healing sessions are created when a merged PR belongs to a detected
Vercel or Railway repository and deployment healing is enabled. The background
job waits for the deployment, captures failure logs when the deployment enters
an error state, and records the repair outcome.

#### `GET /api/deployment-healing-sessions`

List persisted deployment-healing sessions, newest first.

**Query parameters**

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `repo`    | string | Optional repository slug (`owner/repo`) filter |

**Response** `200` — array of [DeploymentHealingSession objects](#deploymenthealingsession)

---

#### `GET /api/deployment-healing-sessions/:id`

Get one deployment-healing session by its internal oh-my-pr ID.

**Response** `200` — [DeploymentHealingSession object](#deploymenthealingsession)
**Response** `404` — `{ "error": "Deployment healing session not found" }`

---

### Configuration

#### `GET /api/config`

Read the current configuration. GitHub tokens are redacted to ordered `***xxxx`
values.

**Response** `200` — [Config object](#config) (tokens redacted)

---

#### `PATCH /api/config`

Partially update the configuration.  Only the provided fields are changed.

**Body** (all fields optional)
```json
{
  "githubTokens": ["ghp_xxxxxxxxxxxx", "github_pat_yyyyyyyyyyyy"],
  "codingAgent": "claude",
  "maxTurns": 15,
  "batchWindowMs": 300000,
  "pollIntervalMs": 120000,
  "maxChangesPerRun": 10,
  "autoResolveMergeConflicts": true,
  "autoCreateReleases": true,
  "autoUpdateDocs": true,
  "includeRepositoryLinksInGitHubComments": true,
  "autoHealCI": false,
  "maxHealingAttemptsPerSession": 3,
  "maxHealingAttemptsPerFingerprint": 2,
  "maxConcurrentHealingRuns": 1,
  "healingCooldownMs": 300000,
  "autoHealDeployments": false,
  "deploymentCheckDelayMs": 60000,
  "deploymentCheckTimeoutMs": 600000,
  "deploymentCheckPollIntervalMs": 15000,
  "watchedRepos": ["owner/repo"],
  "trustedReviewers": ["alice", "bob"],
  "ignoredBots": ["dependabot", "codecov"]
}
```

**Response** `200` — updated [Config object](#config) (tokens redacted)

Some configuration is REST-writable but not exposed by the MCP `update_config`
tool schema today. Use this REST endpoint when changing release automation,
CI-healing, or deployment-healing keys.

---

### App updates

#### `GET /api/app-update`

Return the release-check result used by the dashboard update banner.

The server reads the running app version from `APP_VERSION` and falls back to
`"dev"` when unset. If the current version is a stable semver string, oh-my-pr
checks the latest stable GitHub release for `yungookim/oh-my-pr`, ignores draft
and prerelease releases, and compares the versions. If the current build is not
semver or the GitHub release check fails, the endpoint returns a quiet fallback
with `latestVersion: null`, the releases index URL, and `updateAvailable: false`.

**Response** `200` — [AppUpdateStatus object](#appupdatestatus)

**Example** `200` — newer release available
```json
{
  "currentVersion": "1.0.0",
  "latestVersion": "v1.1.0",
  "latestReleaseUrl": "https://github.com/yungookim/oh-my-pr/releases/tag/v1.1.0",
  "updateAvailable": true
}
```

**Example** `200` — quiet fallback for a non-versioned build or failed check
```json
{
  "currentVersion": "dev",
  "latestVersion": null,
  "latestReleaseUrl": "https://github.com/yungookim/oh-my-pr/releases",
  "updateAvailable": false
}
```

---

### Runtime & drain mode

Runtime state is queue-aware. `activeRuns` counts currently executing queue
handlers (leased jobs); jobs still waiting in SQLite are not included.

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

Enable or disable drain mode. When enabled, the dispatcher stops claiming new
queued jobs but leaves queued rows intact in SQLite. Already-running handlers
are allowed to finish, and `waitForIdle` also waits on any started babysitter
or release work before reporting success. Endpoints that explicitly gate manual
work, such as `POST /api/repos/sync`, `POST /api/prs/:id/apply`, and
`POST /api/prs/:id/babysit`, return `409` while drain mode is active; other
APIs may still enqueue work that remains pending until drain mode is disabled.

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
| `waitForIdle`  | boolean | no       | Wait until queue workers and started babysitter/release runs go idle |
| `timeoutMs`    | number  | no       | Max wait in ms when `waitForIdle` is true (≤600s)|

**Response** `200` — drained successfully (or disabled)
**Response** `202` — drain enabled but timed out before idle

---

### Social changelogs

Social changelog generation is automatic and durable. When a merge-count
milestone is reached, oh-my-pr creates a changelog row with
`status: "generating"` and then fills in `content` from a queued background
job. If the app restarts before completion, the queued job is reclaimed from
SQLite.

#### `GET /api/changelogs`

List all generated social-media changelog posts.

**Response** `200` — array of [SocialChangelog objects](#socialchangelog)

---

#### `GET /api/changelogs/:id`

Get a single social-media changelog by ID.

**Response** `200` — [SocialChangelog object](#socialchangelog)
**Response** `404` — not found

---

### Releases

Release evaluation and publishing are also durable background jobs. When a
tracked PR is archived as merged and automatic releases are enabled, oh-my-pr
persists a release run and queues background processing. Retrying a
failed release run resets it to `detected` and re-queues processing.

#### `GET /api/releases`

List all persisted release runs, newest first.

**Response** `200` — array of [ReleaseRun objects](#releaserun)

---

#### `GET /api/releases/:id`

Get one release run by its internal oh-my-pr ID.

**Response** `200` — [ReleaseRun object](#releaserun)
**Response** `404` — not found

---

#### `POST /api/releases/:id/retry`

Reset an existing release run to `detected` and queue it for durable
reprocessing. The retry request itself is accepted during drain mode, but the
queued job will not be claimed until drain mode is disabled.

**Response** `200` — updated [ReleaseRun object](#releaserun)
**Response** `404` — not found

---

### Onboarding

#### `GET /api/onboarding/status`

Check the onboarding status of all watched repositories (e.g., whether the
oh-my-pr GitHub Actions workflow is installed).

**Response** `200`
```json
{
  "githubConnected": true,
  "githubUser": "octocat",
  "repos": [
    {
      "repo": "owner/repo",
      "accessible": true,
      "codeReviews": {
        "claude": true,
        "codex": false,
        "gemini": false
      }
    }
  ]
}
```

---

#### `POST /api/onboarding/install-review`

Install the oh-my-pr code-review GitHub Actions workflow on a repository.

**Body**
```json
{
  "repo": "owner/repo",
  "tool": "claude"
}
```
`tool` must be `"claude"` or `"codex"`.

**Response** `200`
```json
{
  "path": ".github/workflows/claude-code-review.yml",
  "url": "https://github.com/owner/repo/blob/main/.github/workflows/claude-code-review.yml"
}
```

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
  docsAssessment?: {
    headSha: string;
    status: "needed" | "not_needed" | "failed";
    summary: string;
    assessedAt: string;        // ISO 8601
  } | null;
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
  githubTokens: string[];      // Ordered and redacted to "***xxxx" in GET responses
  githubToken?: string;        // Legacy single-token field, redacted when present
  codingAgent: "claude" | "codex";
  maxTurns: number;
  batchWindowMs: number;
  pollIntervalMs: number;
  maxChangesPerRun: number;
  autoResolveMergeConflicts: boolean;
  autoCreateReleases: boolean;
  autoUpdateDocs: boolean;
  includeRepositoryLinksInGitHubComments: boolean;
  autoHealCI: boolean;
  maxHealingAttemptsPerSession: number;
  maxHealingAttemptsPerFingerprint: number;
  maxConcurrentHealingRuns: number;
  healingCooldownMs: number;
  autoHealDeployments: boolean;
  deploymentCheckDelayMs: number;
  deploymentCheckTimeoutMs: number;
  deploymentCheckPollIntervalMs: number;
  watchedRepos: string[];
  trustedReviewers: string[];
  ignoredBots: string[];
}
```

### WatchedRepo

```typescript
{
  repo: string;               // "owner/repo"
  autoCreateReleases: boolean;
  ownPrsOnly: boolean;        // true => only auto-discover the authenticated user's PRs
}
```

### AppUpdateStatus

```typescript
{
  currentVersion: string;          // APP_VERSION or "dev"
  latestVersion: string | null;    // latest stable GitHub release tag, e.g. "v1.1.0"
  latestReleaseUrl: string;        // release page or releases index fallback
  updateAvailable: boolean;        // true when latestVersion is newer than currentVersion
}
```

### RuntimeSnapshot

```typescript
{
  drainMode: boolean;
  drainRequestedAt: string | null; // ISO 8601
  drainReason: string | null;
  activeRuns: number;              // currently executing durable queue jobs
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

### DeploymentHealingSession

```typescript
{
  id: string;
  repo: string;                // "owner/repo"
  platform: "vercel" | "railway";
  triggerPrNumber: number;
  triggerPrTitle: string;
  triggerPrUrl: string;
  mergeSha: string;
  deploymentId: string | null;
  deploymentLog: string | null;
  fixBranch: string | null;
  fixPrNumber: number | null;
  fixPrUrl: string | null;
  state: "monitoring" | "failed" | "fixing" | "fix_submitted" | "escalated";
  error: string | null;
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  completedAt: string | null;  // ISO 8601
}
```

### ReleaseRun

```typescript
{
  id: string;
  repo: string;                // "owner/repo"
  baseBranch: string;
  triggerPrNumber: number;
  triggerPrTitle: string;
  triggerPrUrl: string;
  triggerMergeSha: string;
  triggerMergedAt: string;     // ISO 8601
  status: "detected" | "evaluating" | "skipped" | "proposed" | "publishing" | "published" | "error";
  decisionReason: string | null;
  recommendedBump: "patch" | "minor" | "major" | null;
  proposedVersion: string | null;
  releaseTitle: string | null;
  releaseNotes: string | null;
  includedPrs: Array<{
    number: number;
    title: string;
    url: string;
    author: string;
    mergedAt: string;          // ISO 8601
    mergeSha: string;
  }>;
  targetSha: string | null;
  githubReleaseId: number | null;
  githubReleaseUrl: string | null;
  error: string | null;
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  completedAt: string | null;  // ISO 8601
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
| `PORT`               | `5001`         | HTTP port for the oh-my-pr server |
| `CODEFACTORY_PORT`   | `5001`         | Port the MCP server connects to (MCP only) |
| `OH_MY_PR_HOME`      | `~/.oh-my-pr` | Directory for SQLite DB, logs, repos, worktrees |
| `CODEFACTORY_HOME`   | —              | Legacy alias used only when `OH_MY_PR_HOME` is not set |
| `GITHUB_TOKEN`       | —              | Fallback GitHub token after saved app tokens and before `gh auth` |
| `NODE_ENV`           | `development`  | Set to `production` for production builds |
| `TAURI_DEV`          | —              | Set to skip auto-opening the browser (used by Tauri) |
