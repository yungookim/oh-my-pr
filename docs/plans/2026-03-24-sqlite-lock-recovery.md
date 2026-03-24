# SQLite Lock Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `SqliteStorage` resilient to concurrent access by preventing most SQLite lock failures and recovering from bounded residual lock errors.

**Architecture:** Harden the shared `state.sqlite` connection in `server/sqliteStorage.ts` with `WAL` mode and a lock timeout, then centralize lock-aware retries around synchronous SQLite calls so callers do not need route-specific recovery logic. Tighten multi-statement write paths with explicit transactions to shorten lock windows and add a two-live-connection regression test in `server/storage.test.ts`.

**Tech Stack:** TypeScript, `node:sqlite`, Node test runner

---

### Task 1: Lock Hardening

**Files:**
- Modify: `server/sqliteStorage.ts`
- Test: `server/storage.test.ts`

**Step 1: Write the failing concurrency test**

Add a test that opens two live `SqliteStorage` instances against the same temp root, forces one connection to hold a write lock, and exercises `getPR()` from the other connection.

**Step 2: Run the targeted storage test to verify the current failure**

Run: `node --test --import tsx server/storage.test.ts`
Expected: the new contention case fails with `ERR_SQLITE_ERROR` / `database is locked`.

**Step 3: Harden database initialization**

Open `DatabaseSync` with a timeout, enable `WAL`, and keep foreign keys enabled.

**Step 4: Re-run the targeted storage test**

Run: `node --test --import tsx server/storage.test.ts`
Expected: the contention case no longer fails on the initial read path.

### Task 2: Recovery and Transaction Scope

**Files:**
- Modify: `server/sqliteStorage.ts`
- Test: `server/storage.test.ts`

**Step 1: Add bounded lock recovery**

Wrap SQLite `prepare().get()/all()/run()` and `exec()` call sites behind helpers that detect `database is locked`, retry with small backoff, and surface a consistent final error if the lock persists.

**Step 2: Tighten multi-statement writes**

Use explicit transactions for `writeConfig`, `addPR`, and `updatePR` so write locks are shorter and the database does not expose intermediate states between related statements.

**Step 3: Re-run the storage test file**

Run: `node --test --import tsx server/storage.test.ts`
Expected: all storage tests pass, including the new recovery/concurrency case.

### Task 3: Verification

**Files:**
- Modify: `server/sqliteStorage.ts`
- Test: `server/storage.test.ts`

**Step 1: Run the targeted server test suite**

Run: `node --test --import tsx server/storage.test.ts server/log-files.test.ts`
Expected: PASS

**Step 2: Run static verification**

Run: `npm run check`
Expected: PASS
