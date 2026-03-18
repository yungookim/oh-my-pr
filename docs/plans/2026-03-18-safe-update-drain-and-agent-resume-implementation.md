# Safe Update Drain And Agent Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persisted drain-mode lifecycle control plus crash-resume for in-flight agent runs with replay of the exact saved prompt and at-most-once side effects.

**Architecture:** Extend storage with durable runtime/run tables, teach `PRBabysitter` to persist run phases and recover interrupted runs, and gate watcher/manual triggers when drain mode is enabled. Recovery reuses existing babysitter reconciliation, with replay skipped if PR head already moved.

**Tech Stack:** TypeScript, Express, SQLite (`node:sqlite`), Node test runner (`node --test --import tsx`).

---

### Task 1: Add Shared Runtime And Agent Run Schemas

**Files:**
- Modify: `shared/schema.ts`

**Step 1: Write failing type usage check in plan review**
Expect compile references to `AgentRun`/`RuntimeState` to fail before schema types exist.

**Step 2: Run typecheck to confirm baseline**
Run: `npm run check`
Expected: PASS baseline before edits.

**Step 3: Add minimal shared schemas/types**
Add:
- `agentRunStatusEnum`
- `agentRunSchema`
- `runtimeStateSchema`
- exported types for each.

**Step 4: Run typecheck**
Run: `npm run check`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: add runtime and agent-run shared schemas"`

### Task 2: Extend Storage Interface And Memory Storage

**Files:**
- Modify: `server/storage.ts`
- Modify: `server/memoryStorage.ts`

**Step 1: Write failing storage tests (in Task 4) that require new methods**
Expected failure: missing storage methods.

**Step 2: Add storage interface methods**
Add methods for:
- runtime state get/update
- agent run get/list/upsert.

**Step 3: Implement `MemStorage` runtime/run support**
Add in-memory backing maps and deterministic sorting/filtering for run listing.

**Step 4: Run targeted tests**
Run: `node --test --import tsx server/storage.test.ts`
Expected: still failing until SQLite implementation is complete.

**Step 5: Commit**
`git commit -m "feat: extend storage contract for runtime and agent runs"`

### Task 3: Implement SQLite Runtime/Run Persistence

**Files:**
- Modify: `server/sqliteStorage.ts`

**Step 1: Add failing persistence assertions in `server/storage.test.ts`**
Cover reload of `runtime_state` and `agent_runs`.

**Step 2: Run test to confirm failure**
Run: `node --test --import tsx server/storage.test.ts`
Expected: FAIL due missing tables/methods.

**Step 3: Implement schema + methods**
Add:
- tables `runtime_state` and `agent_runs`
- bootstrap defaults
- row parsers
- get/update runtime state
- get/list/upsert agent runs.

**Step 4: Re-run storage tests**
Run: `node --test --import tsx server/storage.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: persist runtime lifecycle and agent run journal in sqlite"`

### Task 4: Add Babysitter Drain Gating And Run Journaling

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/babysitter.test.ts`

**Step 1: Add failing babysitter tests**
Add tests for:
- skip runs during drain mode
- run record persisted with prompt and final status.

**Step 2: Run tests to confirm failure**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL.

**Step 3: Implement journaling + drain behavior**
Implement:
- run phase/status persistence (`running/completed/failed`)
- persisted prompt and initial head SHA before agent execution
- drain gate in `syncAndBabysitTrackedRepos` and `babysitPR`
- helpers: active run count + wait-for-idle.

**Step 4: Re-run babysitter tests**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: add babysitter drain gating and durable run journaling"`

### Task 5: Implement Startup Recovery And Replay/Skip Logic

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/routes.ts`
- Modify: `server/babysitter.test.ts`

**Step 1: Add failing recovery tests**
Add tests for:
- replay with saved prompt when head unchanged
- skip replay when head moved and continue reconciliation.

**Step 2: Run tests to confirm failure**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL.

**Step 3: Implement recovery flow**
Add:
- `resumeInterruptedRuns()` in babysitter
- startup trigger from `registerRoutes`
- replay using persisted prompt/agent context
- replay skip on head-sha mismatch.

**Step 4: Re-run tests**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: recover interrupted runs with replay-safe semantics"`

### Task 6: Add Runtime Lifecycle API Endpoints

**Files:**
- Modify: `server/routes.ts`

**Step 1: Add failing API behavior checks (lightweight via existing tests or manual validation)**
Expected: endpoints unavailable before implementation.

**Step 2: Implement endpoints**
Add:
- `GET /api/runtime`
- `POST /api/runtime/drain` with `enabled/reason/waitForIdle/timeoutMs`.

**Step 3: Add manual verification script**
Use API calls while run is active and confirm drain wait semantics.

**Step 4: Run targeted test suite**
Run: `node --test --import tsx server/storage.test.ts server/babysitter.test.ts server/watcherScheduler.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: expose runtime drain lifecycle endpoints"`

### Task 7: Final Verification Sweep

**Files:**
- Modify: only files above as needed

**Step 1: Run full targeted backend tests**
Run: `node --test --import tsx server/*.test.ts`
Expected: PASS.

**Step 2: Run strict typecheck**
Run: `npm run check`
Expected: PASS.

**Step 3: Summarize behavior diff**
Document:
- pre-change interruption risk,
- post-change drain/recovery guarantees,
- known caveats.

**Step 4: Commit final fixes**
`git commit -m "test: verify safe update drain and crash-resume flow"`
