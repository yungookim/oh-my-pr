# Product Requirements Document: Safe Updates With Drain Mode And Crash-Resume Agent Runs

**Date:** 2026-03-18  
**Status:** Draft (approved direction: Option 2)  
**Owner:** Code Factory

## Background
Code Factory can run multiple long-lived PR babysitter runs concurrently (one per PR). Today, process restarts or updates can interrupt active runs. We need a safe update lifecycle that:

1. avoids interrupting active work during planned updates, and
2. resumes interrupted agent work after unplanned crashes/restarts with the exact same prompt.

The runtime model is explicitly **single local process**.

## Problem Statement
Without lifecycle coordination, a restart can leave PRs in uncertain state:
- active agent processes are terminated,
- in-flight prompts are lost,
- side effects (pushes, GitHub comments, thread resolution) can be duplicated on replay,
- operators cannot safely trigger app updates while work is in progress.

## Goals
1. Add a **drain mode** that prevents new babysitter runs and allows in-flight runs to finish before update/restart.
2. Persist durable **agent run records** with enough state to replay interrupted runs.
3. On restart, recover interrupted runs and replay using the **exact persisted prompt**.
4. Enforce **at-most-once side effects** for replayed runs (no duplicate push/comment/thread resolution).
5. Keep implementation aligned with current architecture (Express + SQLite + PRBabysitter).

## Non-Goals
1. Multi-process coordination across multiple Code Factory instances.
2. Distributed locks or leader election.
3. Desktop-shell migration (Tauri/Neutralino) in this phase.
4. Full workflow redesign of babysitter logic.

## User Stories
1. As an operator, I can request update mode and wait until active runs finish before restarting.
2. As an operator, after a crash/restart, interrupted runs resume automatically without manual intervention.
3. As a reviewer, I do not see duplicate follow-up comments or duplicate thread resolutions.
4. As a maintainer, I can inspect run phase/history to understand where interruption happened.

## Functional Requirements

### R1: Drain Mode (Planned Update Path)
1. Runtime must expose a persisted drain flag (`drain_mode`).
2. While drain mode is enabled:
   - watcher-triggered runs must not start,
   - manual run triggers must return a conflict response,
   - existing in-flight runs are allowed to continue.
3. API must support enabling drain mode and optionally waiting for idle (`activeRuns == 0`).
4. API must support disabling drain mode after restart/maintenance.

### R2: Durable Agent Run Journal
1. Every babysitter run must write a durable run record:
   - `run_id`, `pr_id`, `status`, `phase`, `preferred_agent`, `resolved_agent`,
   - `prompt` (exact prompt used for agent execution),
   - `initial_head_sha`,
   - timestamps and error fields.
2. Run record status transitions must be persisted at key boundaries:
   - started,
   - prompt prepared,
   - agent running,
   - agent finished,
   - follow-up/reconcile,
   - completed/failed.

### R3: Restart Recovery
1. On server startup, system must query run records with `status=running`.
2. For each interrupted run:
   - if replay data is sufficient (`prompt`, `resolved_agent`, `initial_head_sha`), execute recovery,
   - otherwise mark run failed and schedule normal babysitter reconciliation.
3. Recovery must replay the **persisted prompt exactly** when replay is required.

### R4: At-Most-Once Side Effects During Recovery
1. Before replaying agent prompt, system must compare current PR head SHA vs persisted `initial_head_sha`:
   - if head already moved, skip prompt replay and continue reconciliation only,
   - if head unchanged, replay prompt.
2. GitHub follow-up actions must be idempotent:
   - do not post duplicate audit-trail replies,
   - do not re-resolve already-resolved review threads.
3. Branch update validation must ensure no duplicate/contradictory push behavior.

### R5: Operational Visibility
1. Logs must include drain mode transitions and recovery decisions.
2. Logs must clearly indicate replay vs skip-replay paths.
3. API must expose runtime lifecycle status and active run count.

## Data Model Requirements

### Table: `runtime_state` (singleton)
- `id` (fixed 1)
- `drain_mode` (boolean)
- `drain_requested_at` (timestamp nullable)
- `drain_reason` (text nullable)

### Table: `agent_runs`
- `id` (run id, primary key)
- `pr_id` (foreign key to `prs`)
- `preferred_agent` (`codex|claude`)
- `resolved_agent` (`codex|claude`, nullable)
- `status` (`running|completed|failed`)
- `phase` (string)
- `prompt` (text nullable)
- `initial_head_sha` (text nullable)
- `metadata_json` (nullable)
- `last_error` (text nullable)
- `created_at`, `updated_at`

## Lifecycle/State Machine

### Run Status
- `running` -> `completed`
- `running` -> `failed`

### Key Phases (minimum)
- `run.started`
- `run.sync`
- `run.prompt-prepared`
- `run.agent-running`
- `run.agent-finished`
- `run.reconcile`
- `run.completed`
- `run.failed`

## API Requirements
1. `GET /api/runtime`
   - returns persisted runtime state and active run count.
2. `POST /api/runtime/drain`
   - body: `{ enabled: boolean, reason?: string, waitForIdle?: boolean, timeoutMs?: number }`
   - when `enabled=true`, transitions to drain mode and optionally waits for idle.

## Recovery Algorithm (High Level)
1. Load interrupted runs (`status=running`).
2. For each run in creation order:
   - load PR + fresh pull summary,
   - if head SHA differs from `initial_head_sha`: skip replay, reconcile follow-up state,
   - else: prepare worktree, rerun stored prompt with stored agent, verify git state,
   - run reconciliation pass to complete GitHub audit trail and feedback lifecycle,
   - mark run completed or failed.

## Acceptance Criteria
1. Enabling drain mode prevents new runs from watcher/manual endpoints.
2. `drain+wait` returns idle only after all in-flight runs complete.
3. Crash simulation during `agent-running` results in resumed run replay with identical prompt.
4. If crash occurs after push but before follow-up completion, restart does not replay prompt and does not duplicate push.
5. Replayed/reconciled runs do not produce duplicate audit-trail comments or thread resolutions.
6. Interrupted run records are visible with accurate final status.

## Test Plan Requirements
1. Storage tests:
   - `runtime_state` persistence across restart,
   - `agent_runs` persistence and filtering.
2. Babysitter tests:
   - replay path when head unchanged,
   - skip-replay path when head changed,
   - idempotent follow-up behavior on recovery.
3. Route tests (or integration tests):
   - drain-mode gating for watcher/manual run triggers,
   - drain-and-wait idle behavior.
4. End-to-end manual validation:
   - start run, force process kill, restart, verify resumed prompt and no duplicate side effects.

## Rollout Plan
1. Ship persistence model + no-op runtime endpoints first.
2. Add drain gating.
3. Add startup recovery flow behind feature flag (optional).
4. Enable by default after validation in dogfood.

## Risks
1. Recovery complexity in large monolithic `babysitPR` path.
2. False-positive replay skip if SHA movement comes from unrelated external push.
3. Long-running drain windows may delay updates.

## Future Considerations
Desktop packaging (Tauri/Neutralino) can improve update UX later, but correctness still depends on this run-journaling and recovery model.
