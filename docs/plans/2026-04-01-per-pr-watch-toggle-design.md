# Per-PR Watch Toggle Design

**Date:** 2026-04-01
**Status:** Approved

## Goal

Let users turn background watch off for individual tracked pull requests so stale or low-priority PRs stop receiving automatic sync and babysitter runs without disappearing from the active dashboard or losing manual run access.

## Requirements

- Add a per-PR background-watch toggle with a default of enabled.
- Keep paused PRs visible in the active PR list and detail pane.
- Preserve manual `Run now` behavior when background watch is disabled.
- Keep repo-level watch and PR discovery behavior unchanged.
- Continue archiving PRs automatically when they close on GitHub, even if background watch is disabled.
- Persist the toggle across restarts in both memory and SQLite storage.
- Do not overload `status` with watch-enabled semantics.
- Make the paused state visible in the dashboard row and detail surfaces.
- Write explicit activity logs when background watch is paused or resumed.
- Resuming watch should trigger an immediate background sync instead of waiting for the next poll interval.

## Architecture

Add a dedicated boolean field, `watchEnabled`, to the shared PR model. This field represents whether the background watcher may automatically sync and babysit that PR. The existing `status` field remains responsible for lifecycle state such as `watching`, `processing`, `done`, `error`, and `archived`.

The repository watcher should keep its current repo-driven discovery loop. It should still list open PRs for watched repositories, auto-register newly discovered PRs, and archive PRs that are no longer open. For open PRs that already exist locally, it should branch on `watchEnabled`: enabled PRs continue through the normal babysitter flow, while disabled PRs are skipped for automatic sync and remediation.

Manual babysitter execution remains available regardless of `watchEnabled`. This keeps the feature scoped to background automation control rather than becoming a second PR lifecycle.

## Data Model

### PR State

Add `watchEnabled: boolean` to `prSchema` and default it to `true` when a PR is created.

Persist the field through:

- `shared/schema.ts`
- `shared/models.ts`
- `server/memoryStorage.ts`
- `server/sqliteStorage.ts`

### SQLite Persistence

Add a `watch_enabled` column to the `prs` table with `INTEGER NOT NULL DEFAULT 1`. Include it in both the canonical `CREATE TABLE` definition and the `ensureColumn` migration so fresh and migrated databases share the same schema.

## API

Add a dedicated route:

- `PATCH /api/prs/:id/watch`

Request body:

```json
{ "enabled": true }
```

Behavior:

- validate the payload with Zod;
- update the PR's `watchEnabled` field;
- append an activity log stating whether background watch was paused or resumed;
- return the updated PR;
- if watch is resumed, trigger `runWatcher()` asynchronously so the PR is refreshed immediately.

This route should not block or reject manual babysitter actions. If a PR is already `processing`, changing `watchEnabled` only affects future background cycles.

## Watcher Behavior

Inside `syncAndBabysitTrackedRepos()`:

1. Keep building the repo candidate set from `config.watchedRepos` plus tracked PR repos.
2. Keep listing all open PRs per repo.
3. Keep archiving tracked PRs that are no longer open.
4. Keep auto-registering newly discovered open PRs with `watchEnabled: true`.
5. Before queueing an automatic babysitter run for an open PR, check `watchEnabled`.
6. If `watchEnabled` is `false`, skip automatic babysitting for that PR and leave its existing state intact.

This means repo watch remains the mechanism for discovery, while per-PR watch controls ongoing automation.

## Dashboard UX

Add the primary control in the selected PR header next to `Run now`:

- `Pause watch` when `watchEnabled` is `true`
- `Resume watch` when `watchEnabled` is `false`

Show passive paused-state indicators in two places:

- a small label in the PR row so users can scan paused PRs quickly;
- a metadata label in the detail pane.

Update the detail copy:

- watched PR: background watcher syncs GitHub feedback and pushes approved fixes automatically;
- paused PR: background watch is paused for this PR; manual runs still work.

Do not create a separate paused tab or reuse the archived view.

## Error Handling

- If the watch-toggle route receives an invalid body, return `400`.
- If the PR does not exist, return `404`.
- If a resume-triggered watcher run later fails, the route still succeeds; the failure is surfaced through existing logs and watcher error handling.
- Pausing a currently running PR does not cancel the in-flight run.

## Testing Strategy

Add targeted coverage for:

- shared schema and model defaults for `watchEnabled`;
- SQLite and memory-storage persistence for `watchEnabled`;
- the watch-toggle route updating PR state and logging pause/resume events;
- the watcher skipping automatic babysits for paused PRs;
- the watcher resuming automatic babysits after `watchEnabled` is turned back on;
- paused PRs still being archived when GitHub reports them closed;
- dashboard type safety and build compatibility after the new UI control is added.

## Risks And Constraints

- Repo watch still discovers all open PRs in a watched repo. Turning off watch for one PR does not stop new PRs from that repo from being auto-registered.
- Skipping automatic babysits must not accidentally suppress archival detection, release evaluation for merged PRs, or other repo-level discovery logic.
- A dedicated boolean is intentionally simpler than introducing a new paused status; it minimizes impact across the existing lifecycle codepaths.
