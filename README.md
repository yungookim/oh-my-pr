# oh-my-pr

<p align="center">
  <img width="409" height="409" alt="oh-my-pr logo" src="https://github.com/user-attachments/assets/ca339a71-40d9-4619-900f-55825f30a57f" />
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-pr.svg)](https://www.npmjs.com/package/oh-my-pr)
[![CI](https://github.com/yungookim/oh-my-pr/actions/workflows/ci.yml/badge.svg)](https://github.com/yungookim/oh-my-pr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

oh-my-pr is a local-first GitHub PR babysitter. It watches the pull requests you care about, reads review feedback and CI failures, then uses your local Codex or Claude CLI to make fixes in isolated worktrees and push them back to the PR branch.

If you regularly lose time to review comments, flaky checks, merge conflicts, and back-and-forth cleanup before merge, this is the tool for that.

<img width="1365" height="686" alt="oh-my-pr dashboard" src="https://github.com/user-attachments/assets/66dfa082-c732-4989-8b05-f19aa550acb5" />

## Why It Exists

Pull requests often stall for boring reasons:

- review comments arrive after you have switched context
- CI fails after you think the work is done
- fixes require reopening local context and rebuilding the same mental model
- merge prep becomes repetitive babysitting instead of real development

oh-my-pr keeps that loop moving from your machine. You push a branch, let it watch the PR, and come back to something much closer to merge-ready.

## Quick Start

You need:

- Node.js 22+
- `git`
- GitHub auth via `gh auth login` or `GITHUB_TOKEN`
- either the `codex` CLI or `claude` CLI installed and authenticated locally

Install and launch:

```bash
npm install -g oh-my-pr
oh-my-pr
```

That opens the terminal UI. If you prefer the browser dashboard, run:

```bash
oh-my-pr web
```

Then:

1. Add a GitHub repository you want to watch.
2. Choose whether to auto-discover only your PRs or your team's PRs too.
3. Add a PR directly by URL if you want to track just one pull request.
4. Let oh-my-pr sync comments, checks, and follow-up work.

## What It Does

- Watches repositories and tracked PRs for review activity, comments, and failing checks
- Triages feedback into actionable items
- Runs `codex` or `claude` in isolated worktrees under `~/.oh-my-pr`
- Replies to GitHub PR comments on your behalf and resolves conversations to keep the thread clean
- Pushes verified fixes back to the PR branch
- Can automatically create a GitHub release when a merged PR is important enough to justify a version bump
- Keeps logs, run history, and PR state on your machine
- Exposes the same system through a dashboard, local API, and MCP server

## Technical Details

### Local-First

oh-my-pr runs on your machine and works with your local agent CLI. Repository caches (`repos/`), worktrees (`worktrees/`), logs (`log/`), and app state (`state.sqlite`) live under `~/.oh-my-pr` by default. Set `OH_MY_PR_HOME` if you want a different location.

### Isolation

Each fix run happens in an app-owned repository cache and an isolated git worktree. That keeps agent changes scoped to the PR branch instead of mutating your day-to-day checkout.

### GitHub Auth

You can authenticate with:

- `gh auth login`
- `GITHUB_TOKEN`
- app config in the dashboard
- a saved dashboard token

### Watch Scope

Watched repositories default to `My PRs only`. You can switch a repo to `My PRs + teammates`, or skip auto-discovery entirely and register a single PR by URL.

### Interfaces

oh-my-pr can be used in a few ways:

- terminal UI: `oh-my-pr`
- web dashboard: `oh-my-pr web`
- MCP server: `oh-my-pr mcp`
- local REST API: see [LOCAL_API.md](LOCAL_API.md)
- optional Tauri desktop shell

### Optional Automation

If you enable them, oh-my-pr can also:

- attempt bounded CI healing for failing PR heads
- monitor merged deployments and open follow-up fix PRs for supported Vercel and Railway failures
- create GitHub releases automatically for merged changes that are worthy of a new version
- answer natural-language questions about tracked PRs through the dashboard or MCP

Those features are optional and documented in the linked docs below.

## Commands

```bash
oh-my-pr              # terminal UI
oh-my-pr web          # web dashboard
oh-my-pr mcp          # MCP server
oh-my-pr --help       # help
oh-my-pr --version    # version
```

Set `PORT` to change the default web server port (`5001`).

## Run From Source

```bash
git clone https://github.com/yungookim/oh-my-pr.git
cd oh-my-pr
npm install
npm run dev
```

The dashboard is available at `http://localhost:5001` by default. All `/api/*` routes are restricted to loopback callers.

## Docs

- [Getting Started](docs/public/getting-started.md)
- [PR Babysitter](docs/public/pr-babysitter.md)
- [Agent Dispatch](docs/public/agent-dispatch.md)
- [Configuration](docs/public/configuration.md)
- [Local API and MCP](LOCAL_API.md)
- [Contributing](CONTRIBUTING.md)

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

## License

[MIT](LICENSE) Copyright 2026 KimY
