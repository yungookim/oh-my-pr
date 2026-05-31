# Recent Log Failure Fix Baseline - 2026-05-31

## Scope

This baseline records fixes applied after reviewing local oh-my-pr logs for the 24-hour window ending May 31, 2026.

Implementation branch:

- `fix/log-observability-fixes`
- Base: `origin/main@71e6371627c81771ee02dcd7c151d93ba150b660`
- Recorded at: `2026-05-31T13:23:50Z`

## Fixes Applied

### Runtime Watcher Freshness

Runtime state now persists watcher start, heartbeat, stop, interval, and last-error fields so future scans can distinguish a stopped watcher from missing logs.

Expected future signal:

- Active watchers keep `watcherHeartbeatAt` fresh in runtime state.
- Stopped watchers record `watcherCompletedAt`.
- Scheduler failures record `watcherLastError`.

### Daily Log Scan Queryability

SQLite log storage now creates a timestamp-only log index for direct time-window scans.

Expected future signal:

- Last-24-hour scans can use `idx_logs_timestamp` without depending on level or source filters.

### Repo Cache Reclone Blocks

Repo cache reclone blocks now use a structured error that records why cleanup was blocked and how many active or registered worktrees were present.

Expected future signal:

- Babysitter errors caused by repo cache reclone protection include `repoCache.kind = "repo_cache_reclone_blocked"`.
- The telemetry includes block reason, cache path, active workspace count, and registered worktree count.

### Post-Fix CI Failure Context

When CI remains failed after an agent fix, babysitter logs now include grouped failure summaries and the head SHA.

Expected future signal:

- `CI/CD still failing after agent fix` includes `failureSummary` grouped by conclusion and status.
- The same event records the `headSha` used for CI polling.

### Subprocess Stderr Classification

Captured subprocess stream logs now include a structured stream kind so stderr transport noise can be separated from application failures.

Expected future signal:

- Git progress on stderr carries `kind = "subprocess_stderr"` instead of relying only on free-text messages.
- Failure replays still carry `reemittedFor = "failure"`.

## Verification

Commands run from `.worktrees/log-observability-fixes`:

```bash
node --test --import tsx server/appRuntime.test.ts server/storage.test.ts server/repoWorkspace.test.ts server/babysitter.test.ts --test-name-pattern "watcher lifecycle freshness|watcher runtime freshness|timestamp-only log index|registered worktrees|aggregates failure contexts|successful git stderr|failed git stderr"
npm run check
npm run test
npm run test:all
git diff --check
```

Results:

- Focused regression suite passed: 121 passed, 0 failed.
- TypeScript check passed.
- Full server suite passed: 476 passed, 1 skipped, 0 failed.
- Full TypeScript test surface passed: 541 passed, 1 skipped, 0 failed.
- Whitespace check passed.

## Future Log Review Boundary

For future local-log analysis, treat log rows before this branch lands as pre-fix evidence. Only count these as regressions if they appear after the merge commit for `fix/log-observability-fixes`:

- Runtime watcher health cannot be determined from persisted runtime state.
- Last-24-hour SQLite log scans cannot use a timestamp-only index.
- Repo cache reclone blocks lack structured reason and worktree counts.
- Post-fix CI failure logs lack grouped failure context.
- Subprocess stderr rows cannot be separated from actual warning or error conditions by metadata.
