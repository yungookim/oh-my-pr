# PR Babysitter

The PR Babysitter is CodeFactory's core feature — an autonomous system that continuously monitors your GitHub pull requests and takes action on review feedback without manual intervention.

## How It Works

### 1. Repository Watching

When you add a repository to CodeFactory, the babysitter begins polling for open pull requests. It tracks:

- New PRs opened against the repository.
- Review comments and change requests on existing PRs.
- Status changes (approvals, dismissals, re-requests).

### 2. Review Sync

Every review comment is captured and stored locally. CodeFactory understands GitHub's threaded review model:

- **Top-level review comments** — general feedback on the PR.
- **Inline comments** — feedback attached to specific lines of code.
- **Review threads** — multi-message conversations about a specific change.

### 3. Feedback Triage

Not all feedback is equal. CodeFactory classifies each piece of feedback:

| Category | Description | Action |
|----------|-------------|--------|
| **Blocking** | Must be fixed before merge | Agent dispatched immediately |
| **Suggestion** | Improvement that should be considered | Queued for agent review |
| **Nitpick** | Style or preference issue | Logged but deprioritized |
| **Question** | Reviewer needs clarification | Flagged for human response |

### 4. Automated Resolution

For actionable feedback, CodeFactory:

1. Creates an **isolated worktree** — a clean copy of the branch.
2. Dispatches an **AI agent** (Claude Code or OpenAI Codex) with the feedback context.
3. The agent makes changes, runs tests, and validates the fix.
4. Changes are **committed and pushed** back to the PR branch.

## Feedback Lifecycle

Each feedback item moves through a defined state machine:

```
pending → triaged → dispatched → resolved
                  ↘ skipped
```

- **pending** — Feedback just synced from GitHub.
- **triaged** — Classified by category and priority.
- **dispatched** — An agent is actively working on it.
- **resolved** — The agent successfully addressed the feedback.
- **skipped** — Determined to not need automated action.

## Merge Conflict Resolution

When a PR branch falls behind the base branch, CodeFactory can automatically:

1. Detect the conflict.
2. Rebase the branch.
3. Use an AI agent to resolve non-trivial merge conflicts.
4. Push the resolved branch.

## Configuration

You can control babysitter behavior per repository:

- **Poll interval** — How often to check for new reviews (default: 60 seconds).
- **Auto-dispatch** — Whether to automatically dispatch agents or require approval.
- **Agent preference** — Choose between Claude Code, OpenAI Codex, or let CodeFactory decide.

See [Configuration](./configuration.md) for details.
