# Autonomous CI Healing State Machine Design

**Date:** 2026-04-01

## Goal

Turn CI healing into a first-class autonomous workflow that detects failing PR checks, classifies whether they are fixable in-branch, runs bounded repair attempts in isolated worktrees, verifies convergence on new commits, and stops with explicit escalation reasons when autonomy should end.

## Decision Summary

- Replace the current one-shot CI follow-up behavior with a durable healing session state machine per PR head SHA.
- Persist check snapshots, normalized failure fingerprints, healing sessions, and healing attempts as first-class records.
- Keep irreversible and policy-heavy decisions in the app:
  - state transitions
  - retry budgets
  - convergence scoring
  - escalation and blocking rules
  - PR/session reconciliation when the head SHA moves
- Narrow the coding agent's role to targeted repair work against classified failures.
- Make CI healing an explicit product surface with dedicated config, APIs, history, and operator controls.
- Roll out in phases: observe first, then assist, then allow one bounded repair, then enable the full retry loop.

## Existing Constraints

- The watcher currently polls watched repositories and queues `babysitPR` for every open PR.
- Failing checks are read transiently during a babysitter run and are not stored as durable workflow entities.
- After an agent push, the server polls GitHub checks for the new commit and posts an alert if failures remain, but it does not run a bounded second repair attempt.
- The codebase already has:
  - durable PR state in storage
  - isolated PR worktree preparation
  - agent orchestration for code changes
  - logs and background-run records
- The current UI only surfaces coarse CI outcome indicators such as `testsPassed` and `lintPassed`.

## Proposed Architecture

### 1. HealingSession as a first-class entity

Add a durable `HealingSession` record keyed to a PR and the head SHA that triggered the session.

Suggested fields:

- `id`
- `prId`
- `repo`
- `prNumber`
- `initialHeadSha`
- `currentHeadSha`
- `state`
- `startedAt`
- `updatedAt`
- `endedAt`
- `blockedReason`
- `escalationReason`
- `latestFingerprint`
- `attemptCount`
- `lastImprovementScore`

Suggested states:

- `idle`
- `triaging`
- `awaiting_repair_slot`
- `repairing`
- `awaiting_ci`
- `verifying`
- `healed`
- `cooldown`
- `blocked`
- `escalated`
- `superseded`

One active healing session may exist for a given PR head SHA. If the PR head moves, the existing session becomes `superseded` and a new session may begin for the new SHA.

### 2. CheckSnapshot and FailureFingerprint persistence

Persist CI observations instead of treating them as temporary values inside a single babysitter pass.

Suggested records:

- `CheckSnapshot`
  - `id`
  - `prId`
  - `sha`
  - `provider`
  - `context`
  - `status`
  - `conclusion`
  - `description`
  - `targetUrl`
  - `observedAt`
- `FailureFingerprint`
  - `id`
  - `sessionId`
  - `sha`
  - `fingerprint`
  - `category`
  - `classification`
  - `summary`
  - `selectedEvidence`
  - `createdAt`

Example fingerprint categories:

- `typescript`
- `eslint`
- `unit-tests`
- `integration-tests`
- `build`
- `npm-ci-lockfile`
- `generated-artifacts`
- `deploy-permissions`
- `missing-secret`
- `external-outage`

The fingerprint layer is what makes bounded retries and convergence checks possible.

### 3. HealingAttempt records

Each repair attempt should be durable and auditable.

Suggested fields:

- `id`
- `sessionId`
- `attemptNumber`
- `inputSha`
- `outputSha`
- `status`
- `startedAt`
- `endedAt`
- `agent`
- `promptDigest`
- `targetFingerprints`
- `summary`
- `improvementScore`
- `error`

Suggested statuses:

- `queued`
- `running`
- `awaiting_ci`
- `verified`
- `failed`
- `canceled`

### 4. Service boundaries

Split responsibilities so CI healing is not buried in one large babysitter method.

- `CheckIngestor`
  - fetches GitHub commit statuses and check runs
  - stores normalized check snapshots
- `FailureClassifier`
  - groups raw failures into fingerprints
  - classifies each as:
    - `healable_in_branch`
    - `blocked_external`
    - `flaky_or_ambiguous`
    - `unknown`
- `HealingSessionManager`
  - owns state transitions
  - enforces retry budgets and cooldowns
  - supersedes sessions on head movement
- `RepairCoordinator`
  - prepares the worktree
  - builds the repair prompt
  - invokes the coding agent
- `VerificationCoordinator`
  - waits for checks on the new SHA
  - compares before/after fingerprints
  - calculates improvement score
- `EscalationManager`
  - posts concise blocked/escalated summaries
  - exposes operator-visible reasons and next actions

The watcher should detect PR activity and feed the state machine, but it should not directly own the CI healing lifecycle.

### 5. State machine lifecycle

Core transitions:

- `idle -> triaging` when a failing check is observed on the current PR head SHA
- `triaging -> blocked` when all failures are external, secret-based, permission-based, or otherwise not healable in-branch
- `triaging -> awaiting_repair_slot` when at least one failure is classified `healable_in_branch`
- `awaiting_repair_slot -> repairing` when concurrency limits allow a repair run
- `repairing -> awaiting_ci` only after the app verifies that the PR branch moved to a new SHA
- `awaiting_ci -> verifying` when checks for the new SHA have settled
- `verifying -> healed` when all targeted healable fingerprints disappear
- `verifying -> awaiting_repair_slot` when there is measurable improvement but unresolved healable failures remain
- `verifying -> cooldown` when the outcome appears flaky or ambiguous
- `verifying -> escalated` when the fingerprint is unchanged, worsens, or retry budget is exhausted
- `* -> superseded` whenever the PR head SHA changes

This turns CI healing into a closed-loop controller instead of a single post-push observation step.

### 6. Agent boundary

The coding agent should not own session state. It should only attempt narrowly scoped repairs.

The repair prompt should include:

- repo and PR identity
- input head SHA
- exact target fingerprints for this attempt
- selected log excerpts for those fingerprints
- changed files in the PR
- repository instructions
- explicit scope limits

Required output:

- summary of what changed
- verification run performed locally
- explicit note if a targeted fingerprint could not be fixed

The app, not the agent, decides whether the attempt improved the session.

### 7. Verification and convergence scoring

After a repair push, the app waits for checks to settle on the new SHA and compares the result to the prior fingerprint set.

Suggested improvement score:

- `+2` for each targeted fingerprint removed
- `+1` for each targeted fingerprint downgraded to flaky or ambiguous
- `-2` for each targeted fingerprint left unchanged
- `-3` for each new unrelated failure introduced

Suggested rules:

- retry only when score is positive and retry budget remains
- escalate immediately when score is zero or negative
- block immediately for external, permission, or secret failures
- supersede immediately when the author pushes a new head SHA

### 8. Retry, cooldown, and stop policy

Suggested defaults:

- maximum 3 healing attempts per session
- maximum 2 attempts for the same unchanged fingerprint
- one active repair run per PR
- cooldown before retry for flaky outcomes
- no retries for clearly external failures

The autonomous system should stop for understandable reasons:

- `blocked`: not healable in-branch
- `escalated`: no improvement, regression, or retry budget exhausted
- `superseded`: author push invalidated the current diagnosis

### 9. API and configuration

Make CI healing explicit in config and APIs.

Suggested config:

- `autoHealCI`
- `maxHealingAttemptsPerSession`
- `maxHealingAttemptsPerFingerprint`
- `maxConcurrentHealingRuns`
- `healingCooldownMs`
- `allowPartialLogUploadToAgent`
- `autoEscalateOnExternalFailures`

Suggested APIs:

- `GET /api/healing-sessions`
- `GET /api/healing-sessions/:id`
- `GET /api/prs/:id/checks`
- `GET /api/prs/:id/healing-history`
- `POST /api/healing-sessions/:id/pause`
- `POST /api/healing-sessions/:id/resume`
- `POST /api/healing-sessions/:id/cancel`
- `POST /api/healing-sessions/:id/retry`

### 10. UI

Add CI healing as a dedicated operator-visible surface in the dashboard and settings.

Per-PR healing details should include:

- current session state
- active attempt number
- before/after SHAs
- targeted fingerprints
- classifier reason
- latest agent summary
- blocked/escalated reason
- operator actions:
  - pause
  - resume
  - retry
  - cancel
  - mark external

The goal is visibility, not hidden automation. A human operator should be able to answer "what is the bot doing and why?" from one screen.

## Rollout Plan

### Phase 1: Observation

- add persistence for check snapshots, fingerprints, sessions, and attempts
- keep CI healing read-only
- record proposed transitions without taking action

Goal: validate fingerprinting and classification on real PR traffic.

### Phase 2: Assisted healing

- open sessions and classify failures
- surface proposed repair actions
- do not yet perform autonomous retries

Goal: validate operator UX and blocked-vs-healable classification quality.

### Phase 3: Single bounded repair

- allow one autonomous repair attempt for `healable_in_branch` failures
- reuse the existing isolated worktree and agent runner
- verify convergence on the new SHA

Goal: prove safe repair execution and post-push verification.

### Phase 4: Full bounded loop

- enable retries, cooldowns, supersede-on-head-move, and escalation reasons
- split CI healing from review-comment remediation, docs updates, and conflict handling into separate task types

Goal: complete the durable autonomous healing model without letting unrelated babysitter tasks share retry semantics.

## Error Handling

- If check ingestion fails, keep the session in `triaging` with a visible error and retry later.
- If logs cannot be fetched, classify with reduced confidence or move to `unknown`.
- If the agent does not push a new SHA, mark the attempt failed and escalate if budgets are exhausted.
- If the new SHA never receives settled checks, move to `cooldown` or `escalated` based on policy.
- If the PR head moves during repair or verification, supersede the session.
- If persistence or migration fails, keep the current babysitter behavior available behind the old code path until repaired.

## Testing Strategy

- Schema/model tests for `HealingSession`, `HealingAttempt`, `CheckSnapshot`, and `FailureFingerprint`
- Storage tests for create/update/list/reconciliation behavior and migrations
- Classifier tests for:
  - lockfile drift
  - missing secret
  - permission failure
  - flaky timeout
  - unknown failure
- State machine tests for every legal transition, especially:
  - `blocked`
  - `cooldown`
  - `escalated`
  - `superseded`
- Convergence tests for:
  - full improvement
  - partial improvement
  - unchanged fingerprint
  - worsened failure set
  - new unrelated failures
- Worktree and reconciliation tests for author force-push during a healing session
- Route tests for healing APIs
- UI smoke tests for healing-session state rendering and operator controls

## Success Metrics

- heal rate for failures classified `healable_in_branch`
- false-positive repair rate
- average attempts per healed session
- escalation rate by reason
- median time from first failed check to healed or escalated
- duplicate-session rate for the same PR head SHA

## Out of Scope for V1

- webhook-driven orchestration replacing polling entirely
- deployment-environment introspection beyond GitHub checks attached to a PR commit
- multi-repo policy customization
- human approval queues before each repair attempt
- auto-merging healed PRs
- generalized workflow orchestration for every babysitter task type
