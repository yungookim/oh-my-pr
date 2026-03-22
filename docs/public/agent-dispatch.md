# Agent Dispatch

CodeFactory dispatches local AI agents to fix code based on review feedback. Agents run entirely on your machine — your code never leaves your environment.

## Supported Agents

| Agent | CLI Tool | Best For |
|-------|----------|----------|
| **Claude Code** | `claude` | Complex reasoning, multi-file refactors, architectural changes |
| **OpenAI Codex** | `codex` | Quick fixes, single-file edits, style corrections |

CodeFactory automatically detects which CLI tools are available on your system and selects the most appropriate agent for each task.

## How Dispatch Works

### 1. Worktree Isolation

Before an agent runs, CodeFactory creates a **temporary git worktree**:

```
/tmp/pr-babysitter/<repo>/<pr-number>/
```

This ensures:
- The agent works on an **isolated copy** of the branch.
- Your local working directory is **never touched**.
- Multiple agents can run **in parallel** on different PRs.

### 2. Agent Execution

The agent receives:
- The **review feedback** to address.
- The **file context** (relevant source files).
- The **PR description** for broader understanding.
- Any **previous agent attempts** (to avoid repeating failed approaches).

### 3. Validation

After the agent completes:
- Changes are **diffed** against the original branch.
- If configured, **tests are run** to validate the fix.
- The diff is **logged** for human review in the dashboard.

### 4. Commit & Push

If validation passes, CodeFactory:
- Creates a **descriptive commit message** explaining what was fixed.
- Pushes the commit to the **PR branch** on GitHub.
- Updates the **feedback status** to resolved.

## Agent Runs in the Dashboard

Every agent run is tracked in the CodeFactory dashboard:

- **Status** — Running, succeeded, or failed.
- **Duration** — How long the agent took.
- **Diff** — Exact changes the agent made.
- **Logs** — Full agent output for debugging.

## Model Discovery

CodeFactory discovers available models from your local CLI installations. You can view and refresh available models from the **Settings** page in the dashboard.

## Customization

Override the default agent per repository or globally:

- Set `CODEFACTORY_AGENT=claude` or `CODEFACTORY_AGENT=codex` as an environment variable.
- Configure per-repo preferences in the dashboard under repository settings.

See [Configuration](./configuration.md) for all options.
