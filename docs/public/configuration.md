# Configuration

oh-my-pr is configured through environment variables and the dashboard settings page.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5001` | HTTP server port |
| `OH_MY_PR_HOME` | `~/.oh-my-pr` | Data directory for state and logs |
| `CODEFACTORY_HOME` | — | Legacy alias used only when `OH_MY_PR_HOME` is not set |
| `CODEFACTORY_PORT` | `5001` | Port the MCP server connects to |
| `GITHUB_TOKEN` | — | Fallback GitHub token when no dashboard token is configured; `gh auth` is used after that |

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

## Dashboard Settings

The settings page in the dashboard provides a UI for:

- **GitHub token management** — Add, remove, and reorder saved tokens before falling back to `GITHUB_TOKEN` or `gh auth`.
- **Babysitter tuning** — Control polling, batching, merge-conflict handling, release automation, and automatic docs assessment.
- **PR comment branding** — Toggle whether agent-authored GitHub PR comments link back to oh-my-pr and include the `Posted by oh-my-pr` footer.
- **CI healing** — Enable autonomous CI repair and tune retry/session limits.
- **Deployment healing** — Not yet exposed in the dashboard; use `PATCH /api/config` for the deployment-healing keys listed below.
- **Theme** — Toggle between light and dark mode.

## Repository Watch Settings

Watched repositories also have repo-level settings exposed in the dashboard's repository list and through `GET /api/repos/settings` plus `PATCH /api/repos/settings`.

| Setting | Default | Description |
|---------|---------|-------------|
| `ownPrsOnly` | `true` | Auto-discover only PRs authored by the authenticated GitHub user for that repo. This appears in the dashboard as **My PRs only**. |
| `ownPrsOnly` | `false` | Auto-discover all open PRs in that repo. This appears in the dashboard as **My PRs + teammates**. |
| `autoCreateReleases` | `true` | Keep release automation enabled for the repo when the rest of the release prerequisites are met. |

New watched repos default to **My PRs only**. If you want team-wide tracking for a repository, switch it to **My PRs + teammates** in the dashboard or patch `ownPrsOnly: false` through `/api/repos/settings`.

PRs added directly by URL stay tracked regardless of a repo's `ownPrsOnly` setting.

## App Update Banner

On builds where `APP_VERSION` is a stable semver string, the dashboard calls
`GET /api/app-update` and compares the running version to the latest stable
GitHub release for `yungookim/oh-my-pr`. When a newer release exists, the
dashboard shows an update banner with a link to the matching release page.

Selecting `dismiss for now` stores a release-scoped key in browser
`sessionStorage`, so the banner stays hidden only for the current browser
session and only for that specific `latestVersion`. Opening a new browser
session or publishing a newer release makes the banner eligible to appear
again. If the app is running a non-semver build such as `dev`, or if the
release check fails, the banner stays hidden and the API falls back quietly.

## PR Comment Branding

Agent-authored GitHub PR comments posted by the babysitter — follow-up replies on review threads, echoed `/codefactory` agent-command acknowledgements, status updates, and CI alerts — are branded as oh-my-pr. Each comment references the app name and, by default, appends a `Posted by [oh-my-pr](https://github.com/yungookim/oh-my-pr)` footer that links back to this repository.

| Setting | Default | Description |
|---------|---------|-------------|
| `Repository links in PR comments` | `true` | When enabled, babysitter comments render the app name as a Markdown link to the oh-my-pr repo and append the `Posted by oh-my-pr` footer. When disabled, comments reference `oh-my-pr` as plain text and omit the footer. |

This toggle is available in the dashboard settings page and as `includeRepositoryLinksInGitHubComments` (boolean) in `GET /api/config`, `PATCH /api/config`, and the MCP `update_config` tool. Turning it off is useful for private forks or environments where operators do not want outgoing PR comments to link to the upstream oh-my-pr repository.

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
