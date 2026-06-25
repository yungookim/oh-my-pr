# Log Scan Observability Fix Baseline - 2026-06-25

## Boundary
- Prepared at: 2026-06-25T11:25:52Z
- Branch: main
- Base commit before patch: e4ef93ae1d9232360e78df3f02387870b47bb295
- Trigger: daily local log scan found repeated transient Codex health-check timeouts, watcher heartbeat gaps without warning logs, and completed retry jobs with empty `lastError`.

## Changes to Evaluate Next Run
- Watcher sync/no-op observation should continue even when the selected coding agent has a transient health-check timeout. Health checks now run only when a babysitter run is actually about to be queued.
- Completed background jobs that needed retry should retain the last retry error in `lastError` instead of erasing the reason on completion.
- Watcher heartbeat gaps greater than two poll intervals should emit `Repository watcher heartbeat delayed` with `delayMs` and `pollIntervalMs`.

## Expected Runtime Signals
- A transient `codex health check failed: Command timed out after 30000ms` should not prevent GitHub polling or no-op suppression logs for unchanged PR heads.
- If a `sync_watched_repos` job completes with `attempt_count > 1`, its `last_error` should show the transient failure that caused the retry.
- Future heartbeat gaps like the 18.5-minute gap ending `2026-06-24T02:35:43Z` should have a paired runtime warning.

## Verification
- `npx tsx --test server/babysitter.test.ts`
- `npx tsx --test server/backgroundJobDispatcher.test.ts`
- `npx tsx --test server/appRuntime.test.ts`
- `npm run check`
- `npm run test`
