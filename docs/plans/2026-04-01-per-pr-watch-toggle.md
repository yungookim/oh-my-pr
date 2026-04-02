# Per-PR Watch Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users pause background monitoring for individual tracked PRs while keeping those PRs visible and manually runnable.

**Architecture:** Add a dedicated `watchEnabled` boolean to the shared PR model and persist it in both storage backends. Keep repo-level PR discovery and archival unchanged, but gate automatic babysitter runs on the per-PR flag. Expose the toggle through a small PR-specific API route and a dashboard control in the selected PR header.

**Tech Stack:** TypeScript, Express, React, SQLite (`node:sqlite`), Node test runner (`node --test --import tsx`).

---

### Task 1: Add The Shared PR Watch Flag

**Files:**
- Modify: `shared/schema.ts`
- Modify: `shared/models.ts`
- Modify: `server/defaultConfig.test.ts` only if fixtures require it
- Modify: `server/github.test.ts` only if config fixtures require it

**Step 1: Write the failing schema-adjacent tests**
Add or update targeted assertions so test fixtures constructing a `PR` must include the new `watchEnabled` field or rely on a default that is explicitly asserted.

**Step 2: Run the targeted tests**
Run: `node --test --import tsx server/defaultConfig.test.ts server/github.test.ts`
Expected: FAIL if shared schema changes require fixture updates.

**Step 3: Write minimal shared-model implementation**
Implement:
- `watchEnabled: z.boolean().default(true)` on `prSchema`
- preservation of `watchEnabled` through `createPR(...)`
- preservation of `watchEnabled` through `applyPRUpdate(...)`

**Step 4: Re-run the targeted tests**
Run: `node --test --import tsx server/defaultConfig.test.ts server/github.test.ts`
Expected: PASS.

**Step 5: Commit**
`git add shared/schema.ts shared/models.ts server/defaultConfig.test.ts server/github.test.ts`
`git commit -m "feat: add per-pr watch flag to shared model"`

### Task 2: Persist The Watch Flag In Storage

**Files:**
- Modify: `server/sqliteStorage.ts`
- Modify: `server/memoryStorage.ts`
- Modify: `server/storage.test.ts`
- Modify: `server/memoryStorage.test.ts`

**Step 1: Write the failing storage tests**
Add coverage for:
- new PRs defaulting `watchEnabled` to `true`,
- SQLite round-tripping `watchEnabled`,
- memory storage round-tripping `watchEnabled`,
- migrated SQLite databases seeing `watch_enabled = 1` by default.

**Step 2: Run the targeted storage tests**
Run: `node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts`
Expected: FAIL.

**Step 3: Write minimal persistence implementation**
Implement:
- `watch_enabled` in the SQLite `prs` table definition,
- matching `ensureColumn("prs", "watch_enabled", "INTEGER NOT NULL DEFAULT 1")`,
- row parsing and writes for `watchEnabled`,
- memory-storage preservation of the same field.

**Step 4: Re-run the targeted storage tests**
Run: `node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts`
Expected: PASS.

**Step 5: Commit**
`git add server/sqliteStorage.ts server/memoryStorage.ts server/storage.test.ts server/memoryStorage.test.ts`
`git commit -m "feat: persist per-pr watch state"`

### Task 3: Add The Per-PR Watch API

**Files:**
- Modify: `server/routes.ts`
- Modify: `server/babysitter.test.ts` if route coverage reuses babysitter behavior stubs
- Create or Modify: route test file if one already exists for API behavior

**Step 1: Write the failing route tests**
Add coverage for:
- `PATCH /api/prs/:id/watch` returning `404` for missing PRs,
- disabling watch updating the PR and logging a pause message,
- enabling watch updating the PR and triggering a watcher run,
- invalid payload returning `400`.

**Step 2: Run the targeted route tests**
Run the smallest relevant API test command for the chosen file(s).
Expected: FAIL.

**Step 3: Write minimal route implementation**
Implement:
- Zod request parsing with `{ enabled: z.boolean() }`,
- `storage.updatePR(...)` for `watchEnabled`,
- `storage.addLog(...)` for pause/resume messages,
- async `runWatcher()` call on resume only.

**Step 4: Re-run the targeted route tests**
Run the same targeted API test command.
Expected: PASS.

**Step 5: Commit**
`git add server/routes.ts <route-test-files>`
`git commit -m "feat: add per-pr watch toggle api"`

### Task 4: Gate Background Babysits On The Watch Flag

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/babysitter.test.ts`

**Step 1: Write the failing watcher tests**
Add coverage for:
- open PRs with `watchEnabled: false` being discovered but not babysat,
- the same PR being babysat after `watchEnabled` is set back to `true`,
- paused PRs still being archived when they close on GitHub.

**Step 2: Run the babysitter tests**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL.

**Step 3: Write minimal watcher implementation**
Implement:
- auto-registered PRs with `watchEnabled: true`,
- an early watch-flag branch before logging/queueing automatic babysitter runs,
- no change to archival and release-trigger logic.

**Step 4: Re-run the babysitter tests**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: PASS.

**Step 5: Commit**
`git add server/babysitter.ts server/babysitter.test.ts`
`git commit -m "feat: respect per-pr watch state in watcher"`

### Task 5: Add The Dashboard Pause And Resume Control

**Files:**
- Modify: `client/src/pages/dashboard.tsx`

**Step 1: Add the UI state and control**
Implement:
- a mutation for `PATCH /api/prs/:id/watch`,
- a `Pause watch` / `Resume watch` button in the selected PR header,
- a passive paused label in each PR row,
- a paused-state message in the PR detail pane.

**Step 2: Run strict typecheck**
Run: `npm run check`
Expected: PASS.

**Step 3: Run the production build**
Run: `npm run build`
Expected: PASS.

**Step 4: Manual smoke check**
Start the app, pause a PR, confirm the label updates after refetch, refresh the page, and confirm the paused state persists. Resume the PR and confirm it returns to the normal watched state.

**Step 5: Commit**
`git add client/src/pages/dashboard.tsx`
`git commit -m "feat: add dashboard control for per-pr watch state"`

### Task 6: Final Verification Sweep

**Files:**
- Modify: only files above as needed

**Step 1: Run targeted backend tests**
Run: `node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts server/babysitter.test.ts`
Expected: PASS.

**Step 2: Run the full server test suite**
Run: `node --test --import tsx server/*.test.ts`
Expected: PASS.

**Step 3: Run strict typecheck**
Run: `npm run check`
Expected: PASS.

**Step 4: Run the production build**
Run: `npm run build`
Expected: PASS.

**Step 5: Commit final verification fixes**
`git add <changed-files>`
`git commit -m "test: verify per-pr watch toggle flow"`
