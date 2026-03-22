# Getting Started

Welcome to CodeFactory — the autonomous PR babysitter that watches your repositories, triages review feedback, and dispatches AI agents to fix code.

## Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org/)
- **Git** — installed and configured
- **GitHub Personal Access Token** — with `repo` scope ([create one](https://github.com/settings/tokens))

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/yungookim/codefactory.git
cd codefactory
npm install
```

## Quick Start

### 1. Start the development server

```bash
npm run dev
```

This launches the dashboard at [http://localhost:5001](http://localhost:5001).

### 2. Connect a GitHub repository

1. Open the dashboard in your browser.
2. Click **Add Repository** and paste the URL of a GitHub repository you manage.
3. Enter your GitHub Personal Access Token when prompted.

### 3. Watch CodeFactory work

Once connected, CodeFactory will:

- **Monitor** open pull requests in real time.
- **Sync** review comments and change requests.
- **Triage** feedback into actionable tasks.
- **Dispatch** AI agents (Claude Code or OpenAI Codex) to fix issues.
- **Push** the fixes back to the PR branch.

## Desktop App

CodeFactory is also available as a native desktop application powered by Tauri:

```bash
npm run tauri:dev    # Development
npm run tauri:build  # Production build
```

## Next Steps

- [PR Babysitter](./pr-babysitter.md) — Learn how autonomous PR monitoring works.
- [Agent Dispatch](./agent-dispatch.md) — Understand how AI agents are dispatched to fix code.
- [Configuration](./configuration.md) — Customize CodeFactory for your workflow.
