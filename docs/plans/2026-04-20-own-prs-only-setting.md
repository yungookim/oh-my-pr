# Own PRs Only Setting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-watched-repo setting that limits automatic repo syncing to the authenticated user's own PRs, default it to enabled, and ask for that preference in the web onboarding/watch flow.

**Architecture:** Extend the existing `WatchedRepo` settings model with a new boolean flag, persist it through memory and SQLite storage, and update the repo watcher so it filters auto-discovered PRs by author while preserving explicitly tracked PRs. Expose the setting through `/api/repos/settings`, then add a preselected watch preference control in the dashboard and onboarding copy so new repos default to `My PRs only` but can be switched to team-wide tracking.

**Tech Stack:** TypeScript, React, Express, Zod, Node test runner, SQLite

---

### Task 1: Extend the watched repo data model

**Files:**
- Modify: `shared/schema.ts`
- Modify: `shared/models.ts`
- Modify: `server/defaultConfig.ts`

**Step 1: Write the failing test**

Use existing storage and route tests as the first failing coverage so the new schema field is exercised through real call sites instead of standalone type assertions.

**Step 2: Run test to verify it fails**

Run: `node --test --import tsx server/memoryStorage.test.ts server/routes.test.ts`
Expected: FAIL once tests expect `ownPrsOnly` to exist on watched repo settings.

**Step 3: Write minimal implementation**

Add `ownPrsOnly: z.boolean()` to `watchedRepoSchema`, preserve it in `applyWatchedRepoUpdate`, and make new watched repos default to `true`.

**Step 4: Run test to verify it passes**

Run: `node --test --import tsx server/memoryStorage.test.ts server/routes.test.ts`
Expected: PASS for the schema-backed watched repo expectations.

**Step 5: Commit**

```bash
git add shared/schema.ts shared/models.ts server/defaultConfig.ts server/memoryStorage.test.ts server/routes.test.ts
git commit -m "feat: add own-prs-only repo setting"
```

### Task 2: Persist the setting through storage and routes

**Files:**
- Modify: `server/memoryStorage.ts`
- Modify: `server/sqliteStorage.ts`
- Modify: `server/storage.test.ts`
- Modify: `server/routes.ts`
- Modify: `server/appRuntime.ts`
- Test: `server/memoryStorage.test.ts`
- Test: `server/routes.test.ts`

**Step 1: Write the failing test**

Extend repo settings tests to assert:
- watched repos default `ownPrsOnly` to `true`
- `PATCH /api/repos/settings` can flip only `ownPrsOnly`
- SQLite round-trips preserve the field for fresh and updated rows

**Step 2: Run test to verify it fails**

Run: `node --test --import tsx server/memoryStorage.test.ts server/routes.test.ts server/storage.test.ts`
Expected: FAIL because the new field is missing from memory storage, SQLite parsing, and route patch handling.

**Step 3: Write minimal implementation**

Update both storage backends and the route parser so repo settings default and persist `ownPrsOnly`, using a SQLite column migration plus `CREATE TABLE` update to keep fresh DBs aligned with migrated DBs.

**Step 4: Run test to verify it passes**

Run: `node --test --import tsx server/memoryStorage.test.ts server/routes.test.ts server/storage.test.ts`
Expected: PASS with the new repo setting persisted end-to-end.

**Step 5: Commit**

```bash
git add server/memoryStorage.ts server/sqliteStorage.ts server/storage.test.ts server/routes.ts server/appRuntime.ts server/memoryStorage.test.ts server/routes.test.ts
git commit -m "feat: persist own-prs-only repo settings"
```

### Task 3: Filter watcher auto-discovery to the user's PRs

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/babysitter.test.ts`

**Step 1: Write the failing test**

Add watcher tests that prove:
- watched repos with `ownPrsOnly: true` auto-add only PRs authored by the authenticated user
- watched repos with `ownPrsOnly: false` still auto-add teammate PRs
- already tracked teammate PRs are not archived just because the repo is filtered to own PRs

**Step 2: Run test to verify it fails**

Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL because the watcher currently auto-discovers every open PR in a watched repo.

**Step 3: Write minimal implementation**

Fetch the authenticated GitHub login once per sync cycle, build a filtered set only for new PR discovery, and continue using the full open PR list for archival decisions so manual or previously tracked teammate PRs remain stable.

**Step 4: Run test to verify it passes**

Run: `node --test --import tsx server/babysitter.test.ts`
Expected: PASS with own-only discovery behavior and unchanged archival semantics.

**Step 5: Commit**

```bash
git add server/babysitter.ts server/babysitter.test.ts
git commit -m "feat: filter watched repos to own PRs by default"
```

### Task 4: Add the web onboarding and dashboard controls

**Files:**
- Modify: `client/src/pages/dashboard.tsx`
- Modify: `client/src/components/OnboardingPanel.tsx`

**Step 1: Write the failing test**

There is no existing client test harness here, so verification for this task is integration-driven:
- confirm the watch form renders the new choice UI
- confirm it defaults to `My PRs only`
- confirm switching to team-wide tracking results in a follow-up repo settings update

**Step 2: Run verification target before the implementation**

Run: `npm run check`
Expected: PASS before the UI changes, giving a clean baseline for the client edits.

**Step 3: Write minimal implementation**

Add a small watch-scope choice near the repo input, default it to own-only, and keep onboarding copy explicit about the choice. When the user watches a repo with `My PRs + teammates`, call `PATCH /api/repos/settings` after a successful add to set `ownPrsOnly: false`. Show the persisted setting in tracked repo rows so users can change it later.

**Step 4: Run verification after the implementation**

Run: `npm run check`
Expected: PASS with the new watched repo UI and updated onboarding copy.

**Step 5: Commit**

```bash
git add client/src/pages/dashboard.tsx client/src/components/OnboardingPanel.tsx
git commit -m "feat: add own-prs-only onboarding controls"
```

### Task 5: Run the focused regression suite

**Files:**
- Test: `server/memoryStorage.test.ts`
- Test: `server/routes.test.ts`
- Test: `server/storage.test.ts`
- Test: `server/babysitter.test.ts`
- Verify: `client/src/pages/dashboard.tsx`
- Verify: `client/src/components/OnboardingPanel.tsx`

**Step 1: Run focused backend tests**

Run: `node --test --import tsx server/memoryStorage.test.ts server/routes.test.ts server/storage.test.ts server/babysitter.test.ts`
Expected: PASS

**Step 2: Run typecheck**

Run: `npm run check`
Expected: PASS

**Step 3: Inspect the final diff**

Run: `git diff --stat`
Expected: only the planned files change, with no unrelated edits.

**Step 4: Commit**

```bash
git add docs/plans/2026-04-20-own-prs-only-setting.md
git commit -m "docs: add own-prs-only implementation plan"
```
