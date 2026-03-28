# Code Factory - Get to unsupervised software development
## Autonomous PR improvements to release management

<p align="center">
  <img width="409" height="409" alt="image__7_-removebg-preview" src="https://github.com/user-attachments/assets/ca339a71-40d9-4619-900f-55825f30a57f" />
</p>


**Autonomous GitHub PR babysitter — watches your repos, triages review feedback, dispatches AI agents to fix code, and creates releases**

[![npm version](https://img.shields.io/npm/v/codefactory.svg)](https://www.npmjs.com/package/codefactory)
[![CI](https://github.com/yungookim/codefactory/actions/workflows/ci.yml/badge.svg)](https://github.com/yungookim/codefactory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

---

> Stop babysitting pull requests manually. Code Factory watches your GitHub repos, syncs review comments into a local dashboard, auto-triages feedback, and launches Claude Code CLI or Codex agents to fix everything — all running on your machine.

> **Note:** This project is intended for those obsessed with development speed and is still in development.

---

<img width="1365" height="686" alt="SCR-20260318-qsva-2" src="https://github.com/user-attachments/assets/66dfa082-c732-4989-8b05-f19aa550acb5" />

## Why Code Factory?

This is what Code Factory is good at:
1. Watch the PR to check for PR feedback from humans, agents, failing lint/tests, conflicts etc and auto-fix them
2. Automatically generate lacking tests for all open PR
3. Auto-generate and update user-facing documents

Code Factory runs locally and uses the CLI coding agents that are already installed in your machine. No need to add OPEN_API_KEY or any such. Just install & have it running and let it do its thing.

<p align="center">
  <img src="docs/architecture-diagram.svg" alt="Code Factory Architecture" width="900" />
</p>

Managing PR feedback across multiple repositories is tedious. Review comments pile up, context-switching kills productivity, and small fixes sit idle for hours. Code Factory automates the entire feedback loop:

- **Watch** one or more GitHub repositories for open pull requests
- **Sync** review comments, reviews, and discussion threads into persistent local storage
- **Triage** feedback into `accept`, `reject`, or `flag` buckets — automatically or manually
- **Dispatch** Claude or Codex agents in isolated git worktrees to apply approved changes
- **Ask** follow-up questions about PR status, feedback, and activity from the dashboard
- **Resolve** merge conflicts automatically using AI-powered conflict resolution
- **Push** verified fixes back to the PR branch with full audit logs

All of this happens locally on your machine. No hosted service, no data leaving your environment.

## How It Works

On startup, Code Factory restores the watcher schedule, resumes interrupted runs, and starts a sync cycle immediately.

<img width="969" height="572" alt="image" src="https://github.com/user-attachments/assets/b9dbd102-ae2e-4837-a862-a0282bdfa0b8" />


1. Add a repository to the watch list or register a PR directly by URL.
2. The watcher polls GitHub, auto-registers open PRs, archives PRs that closed upstream, and queues babysitter runs.
3. Each run syncs PR metadata and review feedback into SQLite and mirrored logs while preserving prior decisions and run state.
4. The babysitter evaluates pending comments and failing CI statuses with the configured agent; accepted items become actionable tasks.
5. If work is needed, Code Factory prepares an app-owned repo cache and isolated worktree under `~/.codefactory`, and resolves merge conflicts there when needed.
6. The agent works inside that isolated worktree, runs verification, commits, and pushes directly to the PR branch.
7. Code Factory re-syncs GitHub, posts follow-up comments, resolves review threads, polls CI on the new commit, and returns the PR to `watching`.

## Features

| Feature | Description |
|---------|-------------|
| **Multi-repo watching** | Monitor multiple GitHub repos simultaneously |
| **PR registration** | Add individual PRs by URL for one-off tracking |
| **Smart triage** | Auto-categorize feedback with manual override support |
| **Agent flexibility** | Choose between Claude and Codex for code remediation |
| **PR Q&A** | Ask the configured agent questions about a PR and get context-aware answers from feedback and logs |
| **Isolated worktrees** | Agent runs happen in detached git worktrees — zero risk to your working copy |
| **Persistent state** | SQLite-backed storage survives restarts |
| **Activity logs** | Daily mirrored log files with full run details |
| **Trusted reviewers** | Configure whose feedback gets auto-accepted |
| **Conflict resolution** | Automatically resolve merge conflicts using AI agents |
| **Bot filtering** | Ignore noise from dependabot, codecov, and other bots |
| **Real-time dashboard** | React-based UI with live status, triage controls, PR Q&A, and config management |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Node.js 22+, TypeScript (strict), Express 5 |
| **Client** | React 18, Vite, TanStack Query, Tailwind CSS, shadcn/ui |
| **Storage** | SQLite via `node:sqlite`, Drizzle ORM |
| **GitHub** | Octokit + `gh auth token` fallback |
| **Agents** | Claude CLI or Codex CLI |
| **Testing** | Node test runner with tsx |

## Quick Start

### Prerequisites

- **Node.js 22+** (tested with Node v24.12.0)
- **npm**
- **git**
- A GitHub token (via `GITHUB_TOKEN`, app config, or `gh auth login`)
- Either `codex` or `claude` CLI installed

### Install & Run

```bash
# Install globally from npm
npm install -g codefactory

# Start the server
codefactory
```

The server starts on port `5001` (configurable via `PORT`) and serves both the API and the dashboard.

### Install from Source

```bash
# Clone the repository
git clone https://github.com/yungookim/codefactory.git
cd codefactory

# Install dependencies
npm install

# Start in development mode
npm run dev
```

### Production Build (from source)

```bash
npm run build    # Build the production bundle
npm run start    # Start the production server
```

### Other Commands

```bash
npm run check    # TypeScript strict typecheck
npm run lint     # ESLint validation
npm run test     # Run all tests
npm run db:push  # Push Drizzle schema changes
```

## Authentication

GitHub auth is resolved in order:

1. `GITHUB_TOKEN` environment variable
2. Token stored in app config (via the dashboard)
3. `gh auth token` (GitHub CLI fallback)

## Configuration

All configuration is managed through the dashboard or the API. Persisted settings include:

| Setting | Description |
|---------|-------------|
| **Agent** | `codex` or `claude` |
| **Model** | Model name for the selected agent |
| **Max turns** | Maximum agent conversation turns |
| **Polling interval** | How often to check GitHub for updates |
| **Batch window** | Time window for batching feedback |
| **Max changes per run** | Limit on changes per agent execution |
| **Watched repositories** | List of repos to monitor |
| **Trusted reviewers** | Reviewers whose feedback is auto-accepted |
| **Ignored bots** | Bot accounts to filter out (defaults: dependabot, codecov, github-actions) |

## Local State & Filesystem

| Path | Purpose |
|------|---------|
| `~/.codefactory/state.sqlite` | Durable app state |
| `~/.codefactory/log/` | Daily mirrored activity logs |
| `~/.codefactory/repos/` | App-owned repo caches used to create clean PR worktrees |
| `~/.codefactory/worktrees/` | Isolated PR worktrees for agent runs |

Override the root path with the `CODEFACTORY_HOME` environment variable.

## API Reference

The dashboard communicates with the server through a REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/repos` | List watched repositories |
| `POST` | `/api/repos` | Add a repository to watch |
| `GET` | `/api/prs` | List tracked pull requests |
| `GET` | `/api/prs/:id` | Get PR details with feedback |
| `POST` | `/api/prs` | Register a PR by URL |
| `DELETE` | `/api/prs/:id` | Remove a tracked PR |
| `POST` | `/api/prs/:id/fetch` | Force-refresh PR feedback |
| `POST` | `/api/prs/:id/triage` | Run triage on a PR |
| `POST` | `/api/prs/:id/apply` | Apply accepted changes via agent |
| `POST` | `/api/prs/:id/babysit` | Run full babysit cycle |
| `PATCH` | `/api/prs/:id/feedback/:feedbackId` | Update feedback triage status |
| `GET` | `/api/prs/:id/questions` | List PR question/answer history |
| `POST` | `/api/prs/:id/questions` | Ask the configured agent a question about the PR |
| `GET` | `/api/logs` | Retrieve activity logs |
| `GET` | `/api/config` | Get current configuration |
| `PATCH` | `/api/config` | Update configuration |

## Project Structure

```
client/          React dashboard (Vite + Tailwind + shadcn/ui)
server/          Express API, babysitter logic, GitHub integration, storage
shared/          Shared Zod schemas and TypeScript types
script/          Build tooling
docs/plans/      Design and implementation planning documents
tasks/           Project lessons and working notes
```

## For OpenClaw agents

This section is addressed to you, the OpenClaw agent. Read it in full before interacting with Code Factory.

### What you can do

You have access to Code Factory via its MCP server. Code Factory is a local PR babysitter: it watches GitHub repositories, syncs review feedback, triages it, and dispatches AI agents to apply fixes. Every feature is available to you as an MCP tool.

### Step 1 — Check whether Code Factory is already running

Before doing anything, verify the server is up:

```
GET http://localhost:5001/api/runtime
```

If you get a `200` response, Code Factory is running and you can proceed to Step 3. If the connection is refused, go to Step 2.

### Step 2 — Install and start Code Factory

Run these shell commands on the local machine:

```bash
npm install -g codefactory
codefactory &
```

Or from source:

```bash
git clone https://github.com/yungookim/codefactory.git
cd codefactory
npm install
npm run dev &
```

Wait until you see `serving on port 5001` in the output, then confirm with `GET http://localhost:5001/api/runtime` before continuing.

### Step 3 — How to use your MCP tools

All tools communicate with `http://localhost:5001` over the local network only. External requests are blocked. Call tools in this order for common workflows:

**Watch a new repository and process its PRs**
1. `add_repo` — add the repo slug (e.g. `"owner/repo"`)
2. `sync_repos` — trigger an immediate fetch from GitHub
3. `list_prs` — inspect what was found

**Handle a specific PR end-to-end**
1. `get_pr` — read current state and feedback items
2. `triage_pr` — auto-classify all un-triaged feedback
3. `apply_pr_fixes` — dispatch the AI agent to apply accepted items
   — or use `babysit_pr` to do all three in one call

**Investigate a PR**
1. `fetch_pr_feedback` — force a fresh pull from GitHub
2. `get_logs` with `pr_id` — read the full activity history
3. `ask_pr_question` — ask a natural-language question; poll the returned question `id` via `list_pr_questions` until `status` is `"answered"`

**Override a triage decision**
- `set_feedback_decision` with `decision: "accept" | "reject" | "flag"`

**Graceful shutdown before a deploy**
1. `set_drain_mode` with `enabled: true, wait_for_idle: true`
2. Wait for `activeRuns: 0` in the response
3. Perform your deploy, then call `set_drain_mode` with `enabled: false`

### Available tools

| Tool | What it does |
|------|-------------|
| `list_repos` | List all watched repositories |
| `add_repo` | Add a repo (`owner/repo` or full URL) to the watch list |
| `sync_repos` | Force an immediate sync cycle across all repos |
| `list_prs` | List all actively tracked PRs |
| `list_archived_prs` | List archived (closed/merged) PRs |
| `get_pr` | Get full PR details including every feedback item |
| `add_pr` | Register a PR by its full GitHub URL |
| `remove_pr` | Remove a PR from tracking |
| `fetch_pr_feedback` | Force-refresh GitHub comments and reviews for a PR |
| `triage_pr` | Auto-triage all un-triaged feedback on a PR |
| `apply_pr_fixes` | Dispatch AI agent to apply accepted feedback |
| `babysit_pr` | Full cycle: sync → triage → apply in one call |
| `set_feedback_decision` | Manually set `accept`, `reject`, or `flag` on a feedback item |
| `retry_feedback_item` | Re-queue a failed or warned feedback item |
| `list_pr_questions` | List Q&A history for a PR |
| `ask_pr_question` | Ask the AI agent a question about a PR (async — poll for answer) |
| `get_logs` | Get activity logs; pass `pr_id` to filter to one PR |
| `get_config` | Read current configuration (token is redacted) |
| `update_config` | Partially update configuration |
| `get_agent_models` | List available AI models for each agent type |
| `refresh_agent_models` | Re-discover installed agent models |
| `get_runtime` | Get runtime state: drain mode status and active run count |
| `set_drain_mode` | Enable or disable drain mode |
| `list_changelogs` | List generated social-media changelogs |
| `get_changelog` | Get one changelog by ID |
| `get_onboarding_status` | Check GitHub Actions workflow status for watched repos |
| `install_review_workflow` | Install the Code Factory review workflow on a repo |

Full parameter schemas are in [LOCAL_API.md](LOCAL_API.md).

### Error conditions you must handle

| Error | Meaning | Action |
|-------|---------|--------|
| Connection refused on port 5001 | Server is not running | Run `npm run dev` in the codefactory directory |
| `403 Forbidden` | Request did not come from localhost | Ensure you are calling `127.0.0.1`, not a hostname that resolves externally |
| `409 Conflict` | Drain mode is active | Call `set_drain_mode` with `enabled: false` first, or wait for the drain to complete |
| `404 Not Found` | PR or feedback item ID is wrong | Call `list_prs` to get valid IDs before acting on them |

### If something is broken or missing, file a GitHub issue

If you encounter a bug, an unexpected error response, a missing tool, or behaviour that does not match this documentation, create a GitHub issue so the maintainers can fix it.

**Issue URL:** `https://github.com/yungookim/codefactory/issues/new`

Include the following in the issue body:
- What you were trying to do (the goal)
- Which tool or endpoint you called and with what parameters
- The exact error or unexpected response you received
- The output of `get_logs` filtered to the relevant PR (if applicable)
- The output of `get_runtime` at the time of the failure

Use a clear title such as `[OpenClaw] <tool_name> returns unexpected 500 when X`.

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Copyright 2026 KimY
