# Agent Dispatch

oh-my-pr dispatches local AI agents to fix accepted review feedback, failing status checks, documentation tasks, and merge conflicts. Agents run from your machine inside app-owned git worktrees.

## Supported Agents

| Agent | CLI Tool | Best For |
|-------|----------|----------|
| **Claude Code** | `claude` | Complex reasoning, multi-file refactors, architectural changes |
| **OpenAI Codex** | `codex` | Quick fixes, single-file edits, style corrections |

The global coding agent defaults to `claude`. If the configured CLI is unavailable, oh-my-pr falls back to the other supported CLI when it is installed. If neither `claude` nor `codex` is available, the run fails with a clear setup error.

## How Dispatch Works

### 1. Worktree Isolation

Before an agent runs, oh-my-pr refreshes an app-owned repository cache and creates an isolated git worktree:

```
~/.oh-my-pr/repos/<owner>__<repo>/
~/.oh-my-pr/worktrees/<owner>__<repo>/pr-<pr-number>-<run-id>/
```

This ensures:
- The agent works on an **isolated copy** of the branch.
- Your local working directory is **never touched**.
- Multiple agents can run **in parallel** on different PRs.

### 2. Agent Execution

The agent receives:
- The approved **review-comment tasks** with file, line, source URL, thread, and audit-token metadata.
- The approved **status-check tasks** when CI/status repair is needed.
- The approved **documentation task** summary when the docs assessment says updates are required.
- The PR branch, base/head repository, and remote information needed to commit and push safely.

### 3. Validation

After the agent completes:
- The agent is expected to run relevant verification and commit/push changed files to the PR branch.
- oh-my-pr checks the worktree state, records logs, updates run metadata, and polls CI when needed.
- GitHub follow-up replies and review-thread resolution are handled by oh-my-pr after the agent returns.

### 4. Commit & Push

When the run succeeds, oh-my-pr:
- Verifies that the branch advanced or that no changes were necessary.
- Updates the **feedback status** and run metadata.
- Posts reviewer-facing follow-up summaries and resolves eligible review threads.

## Agent Runs in the Dashboard

Every agent run is tracked in the oh-my-pr dashboard:

- **Status** — Running, succeeded, or failed.
- **Duration** — How long the agent took.
- **Diff** — Exact changes the agent made.
- **Logs** — Full agent output for debugging.

## Agent Selection

The active coding agent is stored in app config as `codingAgent` and can be changed from the dashboard, terminal UI settings pane, REST API, or MCP `update_config` tool. Agent reasoning/model behavior follows the selected CLI runtime; oh-my-pr does not expose a separate model-discovery or model-selection surface today.

## Customization

Override the default agent globally:

- Change **Coding Agent** in the dashboard or terminal UI settings.
- Patch `codingAgent` through `PATCH /api/config` or MCP `update_config`.

See [Configuration](./configuration.md) for all options.
