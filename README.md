# Code Factory

**Mission: get to unsupervised software development. Remove the human bottleneck.**

**Autonomous GitHub PR babysitter — watches your repos, triages review feedback, and dispatches AI agents to fix code.**

[![CI](https://github.com/yungookim/codefactory/actions/workflows/ci.yml/badge.svg)](https://github.com/yungookim/codefactory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

---

> Stop babysitting pull requests manually. Code Factory watches your GitHub repos, syncs review comments into a local dashboard, auto-triages feedback, and launches Claude Code CLI or Codex agents to fix everything — all running on your machine.

> **Note:** This project is intended for those obsessed with development speed

---

<img width="1365" height="686" alt="SCR-20260318-qsva-2" src="https://github.com/user-attachments/assets/66dfa082-c732-4989-8b05-f19aa550acb5" />

## Why Code Factory?

This is what Code Factory is good at:
1. Watch the PR to check for PR feedback from humans, agents, failing lint/tests, conflicts etc and auto-fix them
2. Automatically generate lacking tests for all open PR
3. Auto-generate and update user-facing documents

Code Factory runs locally and uses the CLI coding agents that are already installed in your machine. No need to add OPEN_API_KEY or any such. Just install & have it running and let it do its thing.

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

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Watch Repos  │────▶│ Sync Reviews │────▶│ Triage Items │────▶│ Agent Runs   │
│ & PRs        │     │ & Comments   │     │ accept/      │     │ codex or     │
│              │     │              │     │ reject/flag  │     │ claude CLI   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                                                                      ▼
                                                               ┌──────────────┐
                                                               │  Conflict    │
                                                               │  Resolution  │
                                                               └──────┬───────┘
                                                                      │
                                                                      ▼
                                                               ┌──────────────┐
                                                               │ Commit & Push│
                                                               │ to PR branch │
                                                               └──────────────┘
```

1. Add a repository to the watch list or register a PR directly by URL.
2. The watcher polls GitHub on a configurable interval.
3. Open PRs and their review feedback are fetched, normalized, and stored.
4. The babysitter triages what needs action and what can be ignored.
5. An agent run happens inside an isolated git worktree — your working copy stays untouched.
6. If merge conflicts appear, the babysitter attempts conflict resolution in that worktree.
7. Verification, commit, push, and detailed logs are recorded for the dashboard.

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
# Clone the repository
git clone https://github.com/yungookim/codefactory.git
cd codefactory

# Install dependencies
npm install

# Start in development mode
npm run dev
```

The server starts on port `5001` (configurable via `PORT`) and serves both the API and the dashboard.

### Production Build

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
| `/tmp/pr-babysitter` | PR worktrees for isolated agent runs |

Override paths with `CODEFACTORY_HOME` and `PR_BABYSITTER_ROOT` environment variables.

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

## Using Code Factory with OpenClaw

[OpenClaw](https://openclaw.dev) is a local AI agent that can control Code Factory through its MCP server, letting you manage PRs, trigger babysit runs, and query status entirely through natural language — without opening the dashboard.

### 1. Install Code Factory

```bash
# Clone and install
git clone https://github.com/yungookim/codefactory.git
cd codefactory
npm install

# Start the server (keep this running in the background)
npm run dev
```

The API server starts on `http://localhost:5001`. It only accepts connections from the local machine — external requests are rejected with `403`.

### 2. Configure OpenClaw to use the MCP server

Add Code Factory to OpenClaw's MCP server list. In your OpenClaw configuration file (usually `~/.openclaw/config.json` or the OpenClaw settings UI), add:

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

Replace `/absolute/path/to/codefactory` with the actual path where you cloned the repo (e.g. `/home/alice/codefactory`).

> **Tip:** If you have already run `npm run build`, you can use the compiled binary instead and skip the `tsx` dependency:
> ```json
> {
>   "command": "node",
>   "args": ["/absolute/path/to/codefactory/dist/mcp.cjs"]
> }
> ```

### 3. Restart OpenClaw

After saving the config, restart OpenClaw. It will spawn the Code Factory MCP process automatically on startup. You should see `codefactory` listed as a connected tool source.

### 4. Example prompts

Once connected, you can talk to OpenClaw naturally:

| What you say | What happens |
|---|---|
| *"Watch the repo yungookim/myapp"* | Calls `add_repo` → `sync_repos` |
| *"Show me all open PRs"* | Calls `list_prs` and summarises the results |
| *"Triage PR abc123 and apply the fixes"* | Calls `triage_pr` then `apply_pr_fixes` |
| *"Why is the linter failing on PR abc123?"* | Calls `ask_pr_question` with your question |
| *"Reject the first feedback item on PR abc123"* | Calls `set_feedback_decision` with `"reject"` |
| *"Put Code Factory in drain mode — I'm deploying"* | Calls `set_drain_mode` with `enabled: true` |
| *"Show me the last 20 log entries for PR abc123"* | Calls `get_logs` with the PR filter |

### 5. All available MCP tools

| Tool | Description |
|------|-------------|
| `list_repos` | List all watched repositories |
| `add_repo` | Add a repo to the watch list |
| `sync_repos` | Force an immediate sync across all repos |
| `list_prs` | List actively tracked pull requests |
| `list_archived_prs` | List archived (closed/merged) PRs |
| `get_pr` | Get full PR details including all feedback |
| `add_pr` | Register a PR by GitHub URL |
| `remove_pr` | Remove a PR from tracking |
| `fetch_pr_feedback` | Force-refresh GitHub comments for a PR |
| `triage_pr` | Auto-triage all un-triaged feedback |
| `apply_pr_fixes` | Dispatch AI agent to apply accepted fixes |
| `babysit_pr` | Run a full sync → triage → apply cycle |
| `set_feedback_decision` | Manually accept / reject / flag a feedback item |
| `retry_feedback_item` | Retry a failed or warned feedback item |
| `list_pr_questions` | List Q&A history for a PR |
| `ask_pr_question` | Ask the AI agent a question about a PR |
| `get_logs` | Get activity logs (optional PR filter) |
| `get_config` | Read current configuration |
| `update_config` | Partially update configuration |
| `get_agent_models` | List available AI models |
| `refresh_agent_models` | Re-discover installed agent models |
| `get_runtime` | Get runtime state (drain mode, active runs) |
| `set_drain_mode` | Enable / disable drain mode |
| `list_changelogs` | List generated social-media changelogs |
| `get_changelog` | Get one changelog by ID |
| `get_onboarding_status` | Check repo onboarding status |
| `install_review_workflow` | Install GitHub Actions review workflow on a repo |

For full parameter details see [LOCAL_API.md](LOCAL_API.md).

### Troubleshooting

**MCP server not connecting**
- Make sure `npm run dev` is running before you open OpenClaw.
- Check that the path in the MCP config is absolute and correct.
- Run `CODEFACTORY_PORT=5001 npx tsx /path/to/codefactory/server/mcp.ts` manually to see any startup errors.

**`403 Forbidden` errors**
- All API calls must come from the local machine. If OpenClaw runs inside a container or VM, adjust its networking so outbound requests use `127.0.0.1`.

**Wrong port**
- The default port is `5001`. If you changed it with `PORT=XXXX npm run dev`, set the same value as `CODEFACTORY_PORT` in the MCP config.

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Copyright 2026 KimY
