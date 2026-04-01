# Autonomous CI Healing State Machine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a durable CI-healing workflow that detects failing PR checks, classifies whether they are healable in-branch, runs bounded repair attempts in isolated worktrees, verifies convergence on new SHAs, and exposes operator-visible state and controls.

**Architecture:** Introduce first-class healing workflow entities in shared schema and storage, then layer on GitHub check ingestion, failure fingerprinting, a healing session manager, and a bounded repair/verification loop. Integrate that workflow into the existing watcher and dashboard incrementally, keeping irreversible decisions and retry policy in the app while reusing the current worktree and agent-runner primitives.

**Tech Stack:** TypeScript, Express, React, TanStack Query, SQLite, Zod, Octokit, Node test runner, tsx

---

### Task 1: Add shared CI-healing types and config

**Files:**
- Modify: `shared/schema.ts`
- Modify: `shared/models.ts`
- Modify: `server/defaultConfig.ts`
- Modify: `server/defaultConfig.test.ts`

**Step 1: Write the failing test**

Add schema/default-config coverage for:

- `autoHealCI`
- `maxHealingAttemptsPerSession`
- `maxHealingAttemptsPerFingerprint`
- `maxConcurrentHealingRuns`
- `healingCooldownMs`
- `HealingSession`
- `HealingAttempt`
- `CheckSnapshot`
- `FailureFingerprint`

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/defaultConfig.test.ts server/storage.test.ts`
Expected: FAIL because the new config fields and shared workflow types do not exist yet.

**Step 3: Write minimal implementation**

- Add new config fields to `configSchema`
- Add healing enums and schemas to `shared/schema.ts`
- Add model helpers to `shared/models.ts` for create/update paths
- Add defaults for the new config fields in `server/defaultConfig.ts`

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/defaultConfig.test.ts server/storage.test.ts`
Expected: PASS for schema/default coverage.

**Step 5: Commit**

```bash
git add shared/schema.ts shared/models.ts server/defaultConfig.ts server/defaultConfig.test.ts server/storage.test.ts
git commit -m "feat: add ci healing schemas"
```

### Task 2: Persist CI-healing entities in storage

**Files:**
- Modify: `server/storage.ts`
- Modify: `server/memoryStorage.ts`
- Modify: `server/sqliteStorage.ts`
- Modify: `server/storage.test.ts`
- Modify: `server/memoryStorage.test.ts`

**Step 1: Write the failing test**

Add storage tests for:

- create/get/list/update `HealingSession`
- create/list/update `HealingAttempt`
- store/list `CheckSnapshot`
- store/list `FailureFingerprint`
- config round-trip for new CI-healing settings

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/storage.test.ts server/memoryStorage.test.ts`
Expected: FAIL because storage methods and SQLite tables do not exist.

**Step 3: Write minimal implementation**

- Extend the storage interface with healing workflow CRUD methods
- Add in-memory collections and query/update helpers
- Add SQLite tables, indexes, row parsers, and migrations
- Keep schema creation and migration paths aligned for fresh and existing databases

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/storage.test.ts server/memoryStorage.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/storage.ts server/memoryStorage.ts server/sqliteStorage.ts server/storage.test.ts server/memoryStorage.test.ts
git commit -m "feat: persist ci healing workflow state"
```

### Task 3: Add GitHub check ingestion primitives

**Files:**
- Create: `server/ciCheckIngestor.ts`
- Create: `server/ciCheckIngestor.test.ts`
- Modify: `server/github.ts`
- Modify: `server/github.test.ts`

**Step 1: Write the failing test**

Add tests for:

- normalizing commit statuses and check runs into a common `CheckSnapshot` shape
- selecting only failing or pending checks for a SHA
- extracting stable metadata such as provider, context, conclusion, description, and target URL
- fetching enough data to support later log selection without yet building the classifier

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/github.test.ts server/ciCheckIngestor.test.ts`
Expected: FAIL because the ingestor and normalization helpers do not exist.

**Step 3: Write minimal implementation**

- Keep low-level GitHub API access in `server/github.ts`
- Build a small ingestor that turns GitHub check/status payloads into normalized snapshots
- Make the ingestor store-ready so the session manager can persist observations without re-shaping data

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/github.test.ts server/ciCheckIngestor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/github.ts server/github.test.ts server/ciCheckIngestor.ts server/ciCheckIngestor.test.ts
git commit -m "feat: add ci check ingestion"
```

### Task 4: Add failure fingerprinting and classification

**Files:**
- Create: `server/ciFailureClassifier.ts`
- Create: `server/ciFailureClassifier.test.ts`

**Step 1: Write the failing test**

Add classifier tests for:

- TypeScript compile failure -> `healable_in_branch`
- lockfile mismatch -> `healable_in_branch`
- missing secret or permission failure -> `blocked_external`
- flaky timeout -> `flaky_or_ambiguous`
- unknown failure with weak evidence -> `unknown`
- grouping repeated check names into stable fingerprints

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/ciFailureClassifier.test.ts`
Expected: FAIL because the classifier does not exist.

**Step 3: Write minimal implementation**

- Add fingerprint derivation helpers
- Add classification buckets and reasons
- Keep the output deterministic so retry logic can compare before/after results cleanly

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/ciFailureClassifier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ciFailureClassifier.ts server/ciFailureClassifier.test.ts
git commit -m "feat: add ci failure classifier"
```

### Task 5: Add the healing session manager state machine

**Files:**
- Create: `server/ciHealingManager.ts`
- Create: `server/ciHealingManager.test.ts`
- Modify: `server/storage.ts`

**Step 1: Write the failing test**

Add state-machine tests for:

- `idle -> triaging`
- `triaging -> blocked`
- `triaging -> awaiting_repair_slot`
- `repairing -> awaiting_ci`
- `awaiting_ci -> verifying`
- `verifying -> healed`
- `verifying -> escalated`
- `* -> superseded` when the PR head SHA changes
- retry budget exhaustion and cooldown entry

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/ciHealingManager.test.ts`
Expected: FAIL because the healing manager does not exist.

**Step 3: Write minimal implementation**

- Add a manager that owns legal transitions and concurrency checks
- Reconcile sessions by PR ID and head SHA
- Calculate improvement score inputs but do not yet call the coding agent
- Keep policy in one place rather than scattering state logic across `babysitPR`

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/ciHealingManager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ciHealingManager.ts server/ciHealingManager.test.ts server/storage.ts
git commit -m "feat: add ci healing state machine"
```

### Task 6: Add repair-attempt orchestration and verification

**Files:**
- Create: `server/ciHealingAgent.ts`
- Create: `server/ciHealingAgent.test.ts`
- Modify: `server/agentRunner.ts`
- Modify: `server/agentRunner.test.ts`
- Modify: `server/repoWorkspace.ts`
- Modify: `server/repoWorkspace.test.ts`

**Step 1: Write the failing test**

Add tests for:

- building a bounded repair prompt from classified fingerprints and selected evidence
- rejecting attempts that do not push a new SHA
- capturing attempt summaries and verification metadata
- verifying before/after SHA comparison and improvement scoring inputs

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/ciHealingAgent.test.ts server/agentRunner.test.ts server/repoWorkspace.test.ts`
Expected: FAIL because the CI-healing repair coordinator does not exist.

**Step 3: Write minimal implementation**

- Add a CI-healing-specific prompt builder and repair coordinator
- Reuse the existing isolated worktree lifecycle instead of inventing a second git workspace path
- Keep repair execution separate from session-state decisions
- Return structured attempt results that the manager can verify

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/ciHealingAgent.test.ts server/agentRunner.test.ts server/repoWorkspace.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ciHealingAgent.ts server/ciHealingAgent.test.ts server/agentRunner.ts server/agentRunner.test.ts server/repoWorkspace.ts server/repoWorkspace.test.ts
git commit -m "feat: add ci healing repair coordinator"
```

### Task 7: Integrate the watcher and babysitter with healing sessions

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/babysitter.test.ts`
- Modify: `server/watcherScheduler.ts`
- Modify: `server/routes.ts`
- Create: `server/routes.test.ts`

**Step 1: Write the failing test**

Add integration tests for:

- failing checks on a watched PR create or advance a healing session
- external failures become `blocked` without running the agent
- a healed retry advances to `awaiting_ci` then `healed`
- unchanged failures escalate instead of looping forever
- a new PR head SHA supersedes the old session
- healing-session list/detail routes

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/babysitter.test.ts server/routes.test.ts`
Expected: FAIL because the watcher and routes do not know about healing sessions.

**Step 3: Write minimal implementation**

- Wire the manager into the watcher path
- Replace the current one-shot post-push CI branch in `babysitPR` with the manager-driven flow
- Expose healing session APIs and explicit retry/pause/cancel controls
- Use Node's built-in HTTP server and `fetch` in `server/routes.test.ts` rather than adding a new route-test dependency

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/babysitter.test.ts server/routes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/babysitter.ts server/babysitter.test.ts server/watcherScheduler.ts server/routes.ts server/routes.test.ts
git commit -m "feat: wire ci healing into watcher"
```

### Task 8: Add settings and dashboard visibility

**Files:**
- Create: `client/src/lib/ciHealing.ts`
- Create: `client/src/lib/ciHealing.test.ts`
- Modify: `client/src/pages/settings.tsx`
- Modify: `client/src/pages/dashboard.tsx`
- Modify: `client/src/lib/queryClient.ts`

**Step 1: Write the failing test**

Add helper tests for:

- formatting healing-session states for the UI
- deriving badge tone / operator action availability from state
- summarizing attempt progress for compact dashboard display

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test client/src/lib/ciHealing.test.ts`
Expected: FAIL because the helper module and state formatting rules do not exist.

**Step 3: Write minimal implementation**

- Add explicit CI-healing config controls in settings
- Add a healing panel to the dashboard PR detail view
- Surface session state, attempt count, latest reason, and operator actions
- Keep UI logic thin by pushing state formatting into `client/src/lib/ciHealing.ts`

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test client/src/lib/ciHealing.test.ts && npm run check`
Expected: PASS and a clean typecheck.

**Step 5: Commit**

```bash
git add client/src/lib/ciHealing.ts client/src/lib/ciHealing.test.ts client/src/pages/settings.tsx client/src/pages/dashboard.tsx client/src/lib/queryClient.ts
git commit -m "feat: add ci healing dashboard controls"
```

### Task 9: Final regression, migration, and manual verification

**Files:**
- Modify: `docs/plans/2026-04-01-autonomous-ci-healing-state-machine-design.md` only if rollout notes need tightening after implementation reality
- Modify: `tasks/lessons.md` only if implementation uncovers a user-corrected mistake

**Step 1: Run targeted regression suites**

Run:

- `./node_modules/.bin/tsx --test server/storage.test.ts server/memoryStorage.test.ts`
- `./node_modules/.bin/tsx --test server/github.test.ts server/ciCheckIngestor.test.ts server/ciFailureClassifier.test.ts`
- `./node_modules/.bin/tsx --test server/ciHealingManager.test.ts server/ciHealingAgent.test.ts`
- `./node_modules/.bin/tsx --test server/babysitter.test.ts server/routes.test.ts`
- `./node_modules/.bin/tsx --test client/src/lib/ciHealing.test.ts`

Expected: PASS

**Step 2: Run full project verification**

Run:

- `npm test`
- `npm run check`

Expected: PASS

**Step 3: Manual verification**

- Start the app with `npm run dev`
- Open a tracked PR with a known failing CI check
- Confirm a healing session appears with `triaging` then `awaiting_repair_slot`
- Confirm a blocked external failure does not launch a repair attempt
- Confirm a repair attempt moves to `awaiting_ci` only after a branch push
- Confirm unchanged failures escalate with a visible reason
- Confirm a force-push supersedes the previous session

**Step 4: Commit**

```bash
git add .
git commit -m "feat: finish autonomous ci healing flow"
```
