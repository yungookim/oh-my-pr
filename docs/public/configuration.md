# Configuration

oh-my-pr is configured through environment variables and the dashboard settings page.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5001` | HTTP server port |
| `OH_MY_PR_HOME` | `~/.oh-my-pr` | Data directory for state and logs |
| `PR_BABYSITTER_ROOT` | `/tmp/pr-babysitter` | Root directory for agent worktrees |
| `CODEFACTORY_AGENT` | (auto) | Preferred agent: `claude` or `codex` |
| `DATABASE_URL` | (SQLite) | PostgreSQL connection string (optional) |
| `GITHUB_TOKEN` | — | Default GitHub personal access token |

## Storage

### SQLite (Default)

By default, oh-my-pr stores all state in a local SQLite database:

```
~/.oh-my-pr/state.sqlite
```

No external database is required. This is ideal for single-user setups.

### PostgreSQL

For team deployments, configure a PostgreSQL connection:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/oh_my_pr
```

Then push the schema:

```bash
npm run db:push
```

## Activity Logs

oh-my-pr writes daily activity logs to:

```
~/.oh-my-pr/log/
```

These logs mirror the dashboard activity feed and are useful for debugging or auditing agent behavior.

## Dashboard Settings

The settings page in the dashboard provides a UI for:

- **GitHub Token management** — Add, update, or rotate tokens.
- **Babysitter tuning** — Control polling, batching, merge-conflict handling, release automation, and automatic docs assessment.
- **CI healing** — Enable autonomous CI repair and tune retry/session limits.
- **Theme** — Toggle between light and dark mode.

## CI Healing Settings

Code Factory can track failing CI checks as first-class healing sessions and, when enabled, dispatch bounded repair attempts in isolated worktrees.

| Setting | Default | Description |
|---------|---------|-------------|
| `Automatic CI healing` | `false` | Enables healable CI failure classification and autonomous repair attempts |
| `Max healing attempts per session` | `3` | Caps total repair attempts for one healing session |
| `Max healing attempts per fingerprint` | `2` | Prevents retry loops on the same normalized failure fingerprint |
| `Max concurrent healing runs` | `1` | Limits how many healing repairs can execute at once |
| `Healing cooldown (ms)` | `300000` | Backoff window before a cooldowned session can retry |

The dashboard shows healing state on each tracked PR, while the local API exposes `GET /api/healing-sessions` and `GET /api/healing-sessions/:id` for external tooling.

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
