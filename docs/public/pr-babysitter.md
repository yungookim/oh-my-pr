# PR Babysitter

The PR Babysitter is oh-my-pr's core feature — an autonomous system that continuously monitors your GitHub pull requests, takes action on review feedback, and can run bounded CI-healing loops without manual intervention.

## How It Works

### 1. Repository Watching

When you add a repository to oh-my-pr, the babysitter begins polling for open pull requests. It tracks:

- New PRs opened against the repository.
- Review comments and change requests on existing PRs.
- Failing CI checks on the current PR head SHA.
- Status changes (approvals, dismissals, re-requests).
- A per-PR watch state so you can pause background automation for one tracked PR without removing it.

Paused PRs stay tracked locally and can still be run manually from the dashboard or API. While paused, the background watcher skips autonomous sync and babysitter runs for that PR until you resume watch.

### 2. Review Sync

Every review comment is captured and stored locally. oh-my-pr understands GitHub's threaded review model:

- **Top-level review comments** — general feedback on the PR.
- **Inline comments** — feedback attached to specific lines of code.
- **Review threads** — multi-message conversations about a specific change.

### 3. Feedback Triage

Not all feedback is equal. oh-my-pr classifies each piece of feedback:

| Category | Description | Action |
|----------|-------------|--------|
| **Blocking** | Must be fixed before merge | Agent dispatched immediately |
| **Suggestion** | Improvement that should be considered | Queued for agent review |
| **Nitpick** | Style or preference issue | Logged but deprioritized |
| **Question** | Reviewer needs clarification | Flagged for human response |

### 4. Automated Resolution

For actionable feedback, oh-my-pr:

1. Creates an **isolated worktree** — a clean copy of the branch.
2. Dispatches an **AI agent** (Claude Code or OpenAI Codex) with the feedback context.
3. The agent makes changes, runs tests, and validates the fix.
4. Changes are **committed and pushed** back to the PR branch.

### 5. CI Healing

When **Automatic CI healing** is enabled, the babysitter also watches failing checks and creates a healing session for the current PR head SHA. Each normalized failure fingerprint is classified as one of:

- **`healable_in_branch`** — safe to attempt inside the PR branch with a bounded repair loop.
- **`blocked_external`** — likely missing secrets, auth failures, or upstream outages the agent should not try to fix in-branch.
- **`flaky_or_ambiguous`** — likely transient or inconclusive failures that should not immediately trigger an automated code change.
- **`unknown`** — failures that do not match the current classifier heuristics and are surfaced for operator review.

Only `healable_in_branch` failures queue a dedicated repair attempt. Healing sessions move through explicit states such as `triaging`, `awaiting_repair_slot`, `repairing`, `awaiting_ci`, `verifying`, `healed`, `cooldown`, `blocked`, `escalated`, and `superseded`.

The dashboard shows the latest session for each tracked PR, including the current state badge, attempt summary, latest fingerprint, reason text, and current head SHA. The local API exposes session history via `GET /api/healing-sessions` and `GET /api/healing-sessions/:id`.

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

When a PR branch falls behind the base branch, oh-my-pr can automatically:

1. Detect the conflict.
2. Rebase the branch.
3. Use an AI agent to resolve non-trivial merge conflicts.
4. Push the resolved branch.

## Configuration

You can control babysitter behavior per repository:

- **Poll interval** — How often to check for new reviews (default: 60 seconds).
- **Auto-dispatch** — Whether to automatically dispatch agents or require approval.
- **Agent preference** — Choose between Claude Code, OpenAI Codex, or let oh-my-pr decide.
- **Per-PR watch toggle** — Pause one tracked PR's background automation while keeping manual runs available.

See [Configuration](./configuration.md) for details.
