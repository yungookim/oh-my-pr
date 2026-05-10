# Configuration

oh-my-pr is configured through environment variables and the dashboard settings page.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5001` | HTTP server port |
| `OH_MY_PR_PORT` | `5001` | Port the MCP server connects to when the HTTP server is not on the default port |
| `OH_MY_PR_HOME` | `~/.oh-my-pr` | Data directory for state and logs |
| `CODEFACTORY_HOME` | — | Legacy alias used only when `OH_MY_PR_HOME` is not set |
| `CODEFACTORY_PORT` | `5001` | Legacy port the MCP server connects to when `OH_MY_PR_PORT` is not set |
| `DATABASE_URL` | (SQLite) | PostgreSQL connection string (optional) |
| `GITHUB_TOKEN` | — | Fallback GitHub token when no dashboard token is configured; `gh auth` is used after that |
| `LOG_LEVEL` | `debug` in development, `info` in production | Server log level: `trace`, `debug`, `info`, `warn`, `error`, or `fatal` |
| `OH_MY_PR_LOG_FILE` | `~/.oh-my-pr/log/server.log` | Override the structured server log file path |
| `OH_MY_PR_NO_LOG_FILE` | — | Set to `1` to disable structured server log file output |

`CODEFACTORY_PORT` is still accepted by the MCP server as a legacy fallback, but new MCP configurations should use `OH_MY_PR_PORT`.

## Storage

### SQLite (Default)

By default, oh-my-pr stores all state in a local SQLite database:

```
~/.oh-my-pr/state.sqlite
```

No external database is required. This is ideal for single-user setups.

## Activity Logs

oh-my-pr writes daily activity logs to:

```
~/.oh-my-pr/log/
```

These logs mirror the dashboard activity feed and are useful for debugging or auditing agent behavior.

The server also writes structured runtime logs to `~/.oh-my-pr/log/server.log` by default. Use `LOG_LEVEL`, `OH_MY_PR_LOG_FILE`, or `OH_MY_PR_NO_LOG_FILE=1` to tune file output.

CLI flags can override the same logging settings for a single run:

```
oh-my-pr --quiet
oh-my-pr --verbose
oh-my-pr --log-level warn
oh-my-pr --log-level=trace
oh-my-pr --log-file /tmp/oh-my-pr.log
oh-my-pr --no-log-file
```

The dashboard also exposes a server log viewer at `/logs`. It shows recent structured server logs from the in-memory ring buffer, supports level/source/search filtering, and tails new log records live while the page is open. The live tail uses Server-Sent Events over the local HTTP server, so keep access local and avoid putting the dashboard behind buffering proxies.

## Dashboard Settings

The settings page in the dashboard provides a UI for:

- **GitHub token management** — Add, remove, and reorder saved tokens before falling back to `GITHUB_TOKEN` or `gh auth`.
- **Agent selection** — Choose whether autonomous runs use Claude Code or OpenAI Codex. If the default run fails and a code-owner fallback is launched, the fallback uses the same resolved agent; enabling **Fallback to next coding agent** lets oh-my-pr resolve that fallback to the other local CLI when needed.
- **Babysitter tuning** — Control polling, batching, merge-conflict handling, release automation, and automatic docs assessment.
- **Runtime drain mode** — Pause new background automation and manual agent-triggering actions while allowing in-flight work to finish. During drain mode, the dashboard disables Run now/apply, feedback retry, Ask Agent, manual Release, and release retry actions; matching API calls return `409` instead of queueing new agent work.
- **Ignored bots** — Add or remove bot logins whose comments and reviews should be ignored.
- **PR comment branding** — Customize the app name shown in agent-authored GitHub PR comments, or remove that signature entirely. Toggle whether the signature links back to oh-my-pr and includes the `Posted by oh-my-pr` footer.
- **GitHub progress replies** — Toggle whether the babysitter posts public Accepted/running/completed status replies while working through review comments.
- **CI healing** — Enable autonomous CI repair and tune retry/session limits.
- **Deployment healing** — Not yet exposed in the dashboard; use `PATCH /api/config` for the deployment-healing keys listed below.
- **Theme** — Toggle between light and dark mode.

### Agent Health and Drain Mode

Drain mode is reserved for failures that need operator action. oh-my-pr enables it when the selected agent is deterministically unavailable, such as a missing CLI, auth failure, or unsupported agent setting.

Transient agent health failures, including health-check timeouts, do not enable drain mode. Affected PRs log `Automation skipped`, leave existing queued or running feedback state intact, and can be retried on the next poll or manual run.

## Repository Watch Settings

Watched repositories also have repo-level settings exposed in the dashboard's repository list and through `GET /api/repos/settings` plus `PATCH /api/repos/settings`.

| Setting | Default | Description |
|---------|---------|-------------|
| `ownPrsOnly` | `true` | Auto-discover only PRs authored by the authenticated GitHub user for that repo. This appears in the dashboard as **My PRs only**. |
| `ownPrsOnly` | `false` | Auto-discover all open PRs in that repo. This appears in the dashboard as **My PRs + teammates**. |
| `autoCreateReleases` | `false` | Keep automatic release publishing opt-in for the repo. Enable it when merged PRs should publish GitHub releases automatically after the rest of the release prerequisites are met. |

New watched repos default to **My PRs only** with automatic release publishing disabled. If you want team-wide tracking for a repository, switch it to **My PRs + teammates** in the dashboard or patch `ownPrsOnly: false` through `/api/repos/settings`.

PRs added directly by URL stay tracked regardless of a repo's `ownPrsOnly` setting.

## Manual Repository Releases

Each watched repository row in the dashboard includes a **Release** button. Pressing it queues a manual release run for the latest unreleased merged PR in that repository, using the same release evaluation, version bump, notes, and GitHub publishing flow as automatic release creation.

Manual release runs are allowed even when `autoCreateReleases` is disabled, so you can keep automatic publishing off and still publish releases on demand. If the repository has no unreleased merged PRs, the API returns `409` and no release run is created.

Runtime drain mode also blocks manual release creation and release retries until drain mode is disabled. Release work already in flight is allowed to finish.

## App Update Banner

On builds where `APP_VERSION` is a stable semver string, the dashboard calls
`GET /api/app-update` and compares the running version to the latest stable
GitHub release for `yungookim/oh-my-pr`. When a newer release exists, the
dashboard shows an update banner with a link to the matching release page and
step-by-step npm update instructions:

1. Stop the running `oh-my-pr` process.
2. Run `npm install -g oh-my-pr@latest`.
3. Start `oh-my-pr` again.

Selecting `dismiss for now` stores a release-scoped key in browser
`sessionStorage`, so the banner stays hidden only for the current browser
session and only for that specific `latestVersion`. Opening a new browser
session or publishing a newer release makes the banner eligible to appear
again. If the app is running a non-semver build such as `dev`, or if the
release check fails, the banner stays hidden and the API falls back quietly.

## PR Comment Branding

Agent-authored GitHub PR comments posted by the babysitter — follow-up replies on review threads, agent-command acknowledgements, status updates, and CI alerts — are branded as oh-my-pr by default. Each comment references the configured app name and, by default, appends a `Posted by [oh-my-pr](https://github.com/yungookim/oh-my-pr)` footer that links back to this repository. Set the GitHub reply signature to a different name to replace `oh-my-pr`, or leave it blank to remove the visible app signature from GitHub replies and footers.

| Setting | Default | Description |
|---------|---------|-------------|
| `GitHub reply signature` | `oh-my-pr` | App name shown in public GitHub replies and `Posted by ...` footers. Leave blank to remove the signature. |
| `Repository links in PR comments` | `true` | When enabled, babysitter comments render the configured app name as a Markdown link to the oh-my-pr repo and append the `Posted by ...` footer. When disabled, comments reference the configured app name as plain text and omit the footer. |
| `GitHub progress replies` | `false` | When enabled, the babysitter posts public status replies on accepted review feedback as it moves from queued to running, completed, and resolved. When disabled, it still posts the final follow-up reply without intermediate public progress updates. |

These settings are available in the dashboard settings page and as `githubCommentAppName` (string), `includeRepositoryLinksInGitHubComments` (boolean), and `postGitHubProgressReplies` (boolean) in `GET /api/config`, `PATCH /api/config`, and the MCP `update_config` tool. Turning repository links off is useful for private forks or environments where operators do not want outgoing PR comments to link to the upstream oh-my-pr repository.

## CI Healing Settings

oh-my-pr can track failing CI checks as first-class healing sessions and, when enabled, dispatch bounded repair attempts in isolated worktrees.

| Setting | Default | Description |
|---------|---------|-------------|
| `Automatic CI healing` | `false` | Enables healable CI failure classification and autonomous repair attempts |
| `Max healing attempts per session` | `3` | Caps total repair attempts for one healing session |
| `Max healing attempts per fingerprint` | `2` | Prevents retry loops on the same normalized failure fingerprint |
| `Max concurrent healing runs` | `1` | Limits how many healing repairs can execute at once |
| `Healing cooldown (ms)` | `300000` | Backoff window before a cooldowned session can retry |

The dashboard shows healing state on each tracked PR, while the local API exposes `GET /api/healing-sessions` and `GET /api/healing-sessions/:id` for external tooling.

## Deployment Healing Settings

oh-my-pr can monitor merged PRs for failed Vercel or Railway deployments and open a follow-up fix PR when the deployment breaks after merge.

A repository is eligible only when platform detection finds one of these markers in the app-owned repo cache:

- **Vercel** — `vercel.json`, `.vercel/project.json`, or a `package.json` script containing `vercel`
- **Railway** — `railway.toml`, `railway.json`, or `nixpacks.toml`

| Setting | Default | Description |
|---------|---------|-------------|
| `Automatic deployment healing` | `false` | Queue post-merge deployment monitoring for detected Vercel or Railway repositories |
| `Deployment check delay (ms)` | `60000` | Wait after merge before the first deployment status check |
| `Deployment check timeout (ms)` | `600000` | Maximum time to wait for the deployment to reach `ready` or `error` before escalation |
| `Deployment check poll interval (ms)` | `15000` | Poll cadence while the deployment is still building or deploying |

These values map to `autoHealDeployments`, `deploymentCheckDelayMs`, `deploymentCheckTimeoutMs`, and `deploymentCheckPollIntervalMs` in `GET /api/config` and `PATCH /api/config`.

Deployment healing also requires the matching platform CLI on the machine running oh-my-pr:

- Install and authenticate `vercel` to heal Vercel deployments.
- Install and authenticate `railway` to heal Railway deployments.

Deployment session history is exposed through `GET /api/deployment-healing-sessions`, `GET /api/deployment-healing-sessions/:id`, and the matching MCP read tools. The dashboard settings page and MCP `update_config` tool do not yet expose these deployment-healing knobs; use `PATCH /api/config` for them.

## Build & Deploy

### Development

```bash
npm run dev          # Start dev server with hot reload
```

### Production

```bash
npm run build        # Bundle client and server
npm run start        # Run production server
```

### Desktop App

```bash
npm run tauri:dev    # Tauri dev build
npm run tauri:build  # Tauri production build
```
