# Getting Started

Welcome to oh-my-pr — the autonomous PR babysitter that watches your repositories, triages review feedback, and dispatches AI agents to fix code.

## Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org/)
- **Git** — installed and configured
- **GitHub Personal Access Token** — with `repo` scope ([create one](https://github.com/settings/tokens))

## Installation

Install from npm:

```bash
npm install -g oh-my-pr
```

## Quick Start

### 1. Launch the terminal UI

```bash
oh-my-pr
```

This opens the terminal UI. To start the web dashboard instead, run `oh-my-pr web` — it serves at [http://localhost:5001](http://localhost:5001).

### Run from source

If you prefer to run from source instead:

```bash
git clone https://github.com/yungookim/oh-my-pr.git
cd oh-my-pr
npm install
npm run dev
```

### 2. Connect a GitHub repository

1. Open the dashboard in your browser.
2. Click **Add Repository** and paste the URL of a GitHub repository you manage.
3. Enter your GitHub Personal Access Token when prompted.

### 3. Watch oh-my-pr work

Once connected, oh-my-pr will:

- **Monitor** open pull requests in real time.
- **Sync** review comments and change requests.
- **Triage** feedback into actionable tasks.
- **Dispatch** AI agents (Claude Code or OpenAI Codex) to fix issues.
- **Push** the fixes back to the PR branch.

## Desktop App

oh-my-pr is also available as a native desktop application powered by Tauri:

```bash
npm run tauri:dev    # Development
npm run tauri:build  # Production build
```

## Next Steps

- [PR Babysitter](./pr-babysitter.md) — Learn how autonomous PR monitoring works.
- [Agent Dispatch](./agent-dispatch.md) — Understand how AI agents are dispatched to fix code.
- [Configuration](./configuration.md) — Customize oh-my-pr for your workflow.
