# Delete Watched Repository Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a non-destructive way to unwatch a repository from the dashboard.

**Architecture:** Add a repo-scoped `DELETE /api/repos` runtime path that removes the canonical repo from `config.watchedRepos`; existing storage config writes prune persisted repo settings. Treat repo discovery as driven by explicit watched repos so old PR records do not keep an unwatched repo polling for new PRs.

**Tech Stack:** Express routes, `AppRuntime`, `MemStorage`/`SqliteStorage` config persistence, React Query dashboard mutation, Node test runner.

---

### Task 1: Server Behavior

**Files:**
- Modify: `server/routes.test.ts`
- Modify: `server/babysitter.test.ts`
- Modify: `server/appRuntime.ts`
- Modify: `server/routes.ts`
- Modify: `server/babysitter.ts`

**Steps:**
1. Add a failing route test for `DELETE /api/repos` that removes a watched repo from `/api/repos/settings` while preserving existing PR records.
2. Add a failing watcher test proving a repo that is no longer in `watchedRepos` does not auto-register newly discovered PRs just because an old PR exists.
3. Implement `AppRuntime.removeRepo(repoInput)` by canonicalizing input, removing it from `watchedRepos`, invalidating onboarding, notifying subscribers, and returning `{ repo }`.
4. Add `DELETE /api/repos` to `server/routes.ts`.
5. Change watcher repo discovery to use explicit watched repos.
6. Run the focused server tests and confirm they pass.

### Task 2: Dashboard UI

**Files:**
- Modify: `client/src/pages/dashboard.tsx`
- Modify: `client/src/lib/fullAppQaSurface.test.ts`

**Steps:**
1. Add a failing client surface test for the unwatch button test id and `DELETE /api/repos` mutation.
2. Add a React Query mutation for unwatching a repo.
3. Add a compact row-level `Unwatch` button in the tracked repositories action cluster.
4. Invalidate repo settings, PRs, config, and onboarding status on success; show mutation errors through the existing toast helper.
5. Run the client surface test and confirm it passes.

### Task 3: Verification

**Commands:**
- `npx tsx --test server/routes.test.ts server/babysitter.test.ts client/src/lib/fullAppQaSurface.test.ts`
- `npm run check`
