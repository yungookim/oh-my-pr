# Code Factory

**Autonomous GitHub PR babysitter — watches your repos, triages review feedback, and dispatches AI agents to fix code.**

[![CI](https://github.com/yungookim/codefactory/actions/workflows/ci.yml/badge.svg)](https://github.com/yungookim/codefactory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

---

> Stop babysitting pull requests manually. Code Factory watches your GitHub repos, syncs review comments into a local dashboard, auto-triages feedback, and launches Claude Code CLI or Codex agents to fix everything — all running on your machine.

---

<img width="1365" height="686" alt="SCR-20260318-qsva-2" src="https://github.com/user-attachments/assets/66dfa082-c732-4989-8b05-f19aa550acb5" />

## Why Code Factory?

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

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Copyright 2026 KimY
