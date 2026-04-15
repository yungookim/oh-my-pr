# Oh-my-PR
**This project is going to save you tons of time by automating the whole PR process.**

**Local-first GitHub PR babysitter for Codex and Claude**

<p align="center">
  <img width="409" height="409" alt="Code Factory logo" src="https://github.com/user-attachments/assets/ca339a71-40d9-4619-900f-55825f30a57f" />
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-pr.svg)](https://www.npmjs.com/package/oh-my-pr)
[![CI](https://github.com/yungookim/oh-my-pr/actions/workflows/ci.yml/badge.svg)](https://github.com/yungookim/oh-my-pr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

Oh-my-pr babysits your PRs from your local machine, reads all PR comments and CI/CD logs, and gets your PR ready for merge to main. It uses your local Claude Code or Codex to address any issues identified in the PR or CI/CD pipeline and to ensure that any documentation is up to date. You can push a PR, walk away, and come back to a clean PR ready to be merged.

<img width="1365" height="686" alt="Code Factory dashboard" src="https://github.com/user-attachments/assets/66dfa082-c732-4989-8b05-f19aa550acb5" />

## Features

- Watch multiple repositories or add a single PR by URL.
- Auto-register open PRs, archive closed or merged PRs, and keep syncing review activity.
- Pause background automation for an individual tracked PR while keeping manual runs available.
- Store PR state, background jobs, questions, release runs, logs, and social changelogs in SQLite with mirrored log files.
- Queue repo sync, babysit/apply runs, PR questions, release processing, deployment healing, and social changelog generation in a durable SQLite-backed dispatcher that survives restarts.
- Triage feedback into `accept`, `reject`, or `flag`, with manual overrides and retry for failed or warned items.
- Run `codex` or `claude` in isolated worktrees under `~/.oh-my-pr`, then push verified fixes back to the PR branch.
- Evaluate review comments and failing CI statuses, post GitHub follow-ups, resolve review threads, and heal CI failures through persisted CI healing sessions per PR head.
- Monitor merged Vercel or Railway deployments, capture deployment logs on failure, and open follow-up `deploy-fix/*` PRs when deployment healing is enabled.
- Detect merge conflicts and optionally let the agent resolve them automatically.
- Ask natural-language questions about any tracked PR from the dashboard or via MCP.
- Configure trusted reviewers, ignored bots, polling, batching, run limits, and CI-healing retry budgets from settings.
- Enable drain mode to stop claiming new queued work and optionally wait for active queue handlers to finish before deploys or upgrades.
- Check onboarding status, install Claude or Codex review workflows, and generate social changelogs every 5 PRs merged to `main`.
- Use the React dashboard, local REST API, MCP server, or optional Tauri desktop shell.

## How It Works

1. Add a repository to the watch list or register a PR directly by URL.
2. The watcher enqueues a durable repo-sync job in SQLite.
3. That sync job polls GitHub, auto-registers open PRs, syncs reviews and comments, archives PRs that closed upstream, records failing CI on the current head SHA, and queues babysitter runs for tracked PRs whose background watch is enabled.
4. Manual apply/babysit requests, PR questions, release processing, and social changelog generation go through the same durable queue before work executes in an app-owned repo cache and isolated git worktree under `~/.oh-my-pr`.
5. The agent applies fixes, verifies the result, pushes to the PR branch, updates GitHub threads, and writes logs for the full run.

Repo sync, babysit/apply, PR Q&A, release processing, deployment healing, and social changelog generation all run through durable background jobs stored in `state.sqlite`. On startup the dispatcher reclaims expired job leases, and interrupted babysitter runs are resumed from stored run context when possible.

## CI Healing

When `Automatic CI healing` is enabled, Code Factory creates a healing session for each failing PR head SHA, classifies failures as safe to fix in-branch or blocked external, and runs bounded repair attempts in isolated worktrees. The dashboard surfaces the current session state and retry budget, and the local API exposes `GET /api/healing-sessions` plus `GET /api/healing-sessions/:id` for operator visibility.

## Deployment Healing

When deployment healing is enabled through `PATCH /api/config`, Code Factory inspects merged PRs for supported deployment markers, waits for the post-merge deployment to appear, and polls the matching platform CLI for success or failure. On failure, it captures deployment logs, runs the configured agent from the merge commit in the app-owned repo cache, pushes a `deploy-fix/<platform>-<timestamp>` branch, and opens a follow-up PR against the merged base branch.

Deployment healing currently supports Vercel and Railway repositories detected from common repo-local config files. It requires the matching CLI in `PATH` and authenticated on the same machine running Code Factory. Session history is exposed through `GET /api/deployment-healing-sessions`, `GET /api/deployment-healing-sessions/:id`, and the matching MCP read tools.

## Quick Start

```bash
npm install -g oh-my-pr
oh-my-pr
```

That's it. The terminal UI launches in your shell. Run `oh-my-pr web` to start the web dashboard instead.

### Prerequisites

- **Node.js 22+** (tested with Node v24.12.0)
- **git**
- GitHub auth via `gh auth login`, `GITHUB_TOKEN`, app config, or a saved dashboard token
- Either the `codex` CLI or `claude` CLI installed and authenticated locally
- Optional for deployment healing: the `vercel` CLI and/or `railway` CLI installed and authenticated for repositories you want to auto-heal after merge

### CLI Usage

```bash
oh-my-pr              Launch the terminal UI (default)
oh-my-pr web          Start the web dashboard server (opens browser)
oh-my-pr mcp          Start the MCP server for Claude Desktop / OpenClaw
oh-my-pr --help       Show help message
oh-my-pr --version    Print the version
```

Set `PORT` to change the default web server port (`5001`).

### Run From Source

```bash
git clone https://github.com/yungookim/oh-my-pr.git
cd oh-my-pr
npm install
npm run dev
```

The dashboard is served on port `5001` by default. All `/api/*` routes are restricted to loopback callers.

## MCP and API

Oh-my-pr exposes the same local system through REST and MCP.

```bash
oh-my-pr mcp
```

Use it with MCP hosts such as Claude Desktop or OpenClaw, or call the REST API directly from local tooling. Full endpoint and tool docs live in [LOCAL_API.md](LOCAL_API.md).

## Docs

- [Getting Started](docs/public/getting-started.md)
- [PR Babysitter](docs/public/pr-babysitter.md)
- [Agent Dispatch](docs/public/agent-dispatch.md)
- [Configuration](docs/public/configuration.md)
- [Local API and MCP](LOCAL_API.md)

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Build the production bundle |
| `npm run start` | Run the production build |
| `npm run mcp` | Start the MCP server |
| `npm run check` | Run TypeScript checks |
| `npm run lint` | Run ESLint |
| `npm run test` | Run the server test suite |
| `npm run tauri:dev` | Start the Tauri desktop app in development |
| `npm run tauri:build` | Build the Tauri desktop app |

## Local State

By default Code Factory stores its runtime data in `~/.oh-my-pr`:

- `state.sqlite` for durable app state, runtime flags, background jobs, questions, releases, and changelogs
- `log/` for mirrored activity logs
- `repos/` for app-owned repository caches
- `worktrees/` for isolated PR worktrees

Set `OH_MY_PR_HOME` to override the root path. The legacy `CODEFACTORY_HOME` name is still supported for compatibility.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) Copyright 2026 KimY
