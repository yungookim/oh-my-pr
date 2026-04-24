# PR Babysitter

The PR Babysitter is oh-my-pr's core feature — an autonomous system that continuously monitors your GitHub pull requests, takes action on review feedback, and can run bounded CI-healing and post-merge deployment-healing loops without manual intervention.

## How It Works

### 1. Repository Watching

When you add a repository to oh-my-pr, the babysitter begins polling for open pull requests that match that repo's watch scope:

- **My PRs only** — the default mode. The watcher auto-discovers only PRs authored by the authenticated GitHub user.
- **My PRs + teammates** — team-wide mode. The watcher auto-discovers every open PR in the repository.
- **Direct PR URLs** — PRs you add explicitly by URL stay tracked regardless of the repo's watch scope.

For tracked PRs, the babysitter syncs:

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

Not all feedback is equal. oh-my-pr classifies each piece of feedback into the triage decisions used by the app:

| Decision | Description | Action |
|----------|-------------|--------|
| **accept** | Actionable feedback that should be fixed | Queued for the configured agent |
| **reject** | No code change is needed, such as acknowledgements or app-authored follow-ups | Marked rejected and eligible for thread closure |
| **flag** | Actionability is unclear | Flagged for human review |

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

### 6. Deployment Healing

When `autoHealDeployments` is enabled, the babysitter also inspects merged PRs for supported deployment markers and queues a durable `heal_deployment` job for eligible repositories. Platform detection currently supports:

- **Vercel** — `vercel.json`, `.vercel/project.json`, or a `package.json` script containing `vercel`
- **Railway** — `railway.toml`, `railway.json`, or `nixpacks.toml`

For a detected platform, the deployment-healing flow is:

1. Wait `deploymentCheckDelayMs` after merge so the deployment can appear upstream.
2. Poll the platform CLI until the deployment reaches `ready`, reaches `error`, or `deploymentCheckTimeoutMs` elapses.
3. If the deployment fails, capture the deployment logs and create a deployment-healing session.
4. Run the configured coding agent from the merge SHA, push a `deploy-fix/<platform>-<timestamp>` branch, and open a follow-up PR back to the merged base branch.
5. Mark the session as `fix_submitted` on success or `escalated` when monitoring times out or the repair attempt cannot be completed automatically.

Deployment-healing sessions move through `monitoring`, `failed`, `fixing`, `fix_submitted`, and `escalated`. Operator visibility is currently API- and MCP-based via `GET /api/deployment-healing-sessions`, `GET /api/deployment-healing-sessions/:id`, `list_deployment_healing_sessions`, and `get_deployment_healing_session`; there is no dedicated dashboard panel yet.

Deployment healing requires the matching platform CLI to be installed and authenticated on the same machine as oh-my-pr:

- `vercel` for Vercel repositories
- `railway` for Railway repositories

## Feedback Lifecycle

Each feedback item moves through a defined state machine:

```
pending → queued → in_progress → resolved
      ↘ rejected
      ↘ flagged
      ↘ failed / warning
```

- **pending** — Feedback just synced from GitHub.
- **queued** — Accepted feedback waiting for an agent run.
- **in_progress** — An agent is actively working on it.
- **resolved** — The agent successfully addressed the feedback.
- **rejected** — Determined to not need a code change.
- **flagged** — Needs human review before automation should continue.
- **failed** / **warning** — The run could not complete cleanly or needs operator attention.

## Merge Conflict Resolution

When a PR branch falls behind the base branch, oh-my-pr can automatically:

1. Detect the conflict.
2. Merge the base branch into the PR worktree.
3. Use an AI agent to resolve non-trivial merge conflicts.
4. Push the resolved branch.

## Configuration

You can control babysitter behavior per repository:

- **Repo watch scope** — Choose `My PRs only` (default) or `My PRs + teammates` for auto-discovery.
- **Poll interval** — How often to check for new reviews (default: 60 seconds).
- **Auto-dispatch** — Whether to automatically dispatch agents or require approval.
- **Agent preference** — Choose the global coding agent, with CLI fallback when the preferred tool is not installed.
- **Per-PR watch toggle** — Pause one tracked PR's background automation while keeping manual runs available.

See [Configuration](./configuration.md) for details.
