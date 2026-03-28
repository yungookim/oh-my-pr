# Configuration

CodeFactory is configured through environment variables and the dashboard settings page.

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

By default, CodeFactory stores all state in a local SQLite database:

```
~/.oh-my-pr/state.sqlite
```

No external database is required. This is ideal for single-user setups.

### PostgreSQL

For team deployments, configure a PostgreSQL connection:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/codefactory
```

Then push the schema:

```bash
npm run db:push
```

## Activity Logs

CodeFactory writes daily activity logs to:

```
~/.oh-my-pr/log/
```

These logs mirror the dashboard activity feed and are useful for debugging or auditing agent behavior.

## Dashboard Settings

The settings page in the dashboard provides a UI for:

- **GitHub Token management** — Add, update, or rotate tokens.
- **Repository preferences** — Per-repo agent and poll interval settings.
- **Model discovery** — View and refresh available AI models.
- **Theme** — Toggle between light and dark mode.

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
