# Feedback Item Status Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist a single lifecycle status for every feedback item and show that status in the dashboard feed, with resolved and rejected comments collapsed by default.

**Architecture:** Extend the shared feedback-item model with `status` and `statusReason`, persist those fields in SQLite, and preserve them during GitHub sync. Keep the existing `decision` fields temporarily for babysitter compatibility, but move lifecycle transition rules into a small server-side helper and move feed-label/collapse logic into a small client-side helper so both sides stay testable and consistent.

**Tech Stack:** Node.js, TypeScript, Express, React, Radix Collapsible, local SQLite via `node:sqlite`, Node test runner via `node --test --import tsx`, typecheck via `npm run check`

**Precondition:** Start from a clean worktree. As of 2026-03-15 this checkout contains unresolved merge markers in `server/github.ts` and `server/github.test.ts`, which already make `node --test --import tsx server/babysitter.test.ts` fail before this feature work begins.

---

### Task 1: Persist Lifecycle Fields In Shared Schema And SQLite

**Files:**
- Modify: `shared/schema.ts`
- Modify: `server/sqliteStorage.ts`
- Test: `server/storage.test.ts`

**Step 1: Add the failing storage assertions**

- Extend the existing `server/storage.test.ts` fixture so the stored feedback item includes:

```ts
status: "resolved",
statusReason: "GitHub audit trail verified"
```

- Add a second assertion block that reloads the PR and verifies those two fields survive the SQLite round trip.

**Step 2: Run the targeted storage test**

Run: `node --test --import tsx server/storage.test.ts`
Expected: FAIL because `FeedbackItem` and SQLite persistence do not yet include `status` or `statusReason`.

**Step 3: Implement the minimal schema and storage support**

- In `shared/schema.ts`, add:

```ts
export const feedbackStatusEnum = z.enum([
  "pending",
  "queued",
  "in_progress",
  "resolved",
  "failed",
  "rejected",
  "flagged",
]);
```

- Extend `feedbackItemSchema` with:

```ts
status: feedbackStatusEnum,
statusReason: z.string().nullable(),
```

- In `server/sqliteStorage.ts`:
  - add `status` and `status_reason` to `FeedbackItemRow`
  - `ensureColumn("feedback_items", "status", "TEXT NOT NULL DEFAULT 'pending'")`
  - `ensureColumn("feedback_items", "status_reason", "TEXT")`
  - read the new columns in `getFeedbackItemsForPRIds(...)`
  - write the new columns in `replaceFeedbackItems(...)`
  - default missing loaded values to `"pending"` and `null` so old rows stay valid

**Step 4: Re-run the targeted storage test**

Run: `node --test --import tsx server/storage.test.ts`
Expected: PASS with the lifecycle fields preserved after reload.

**Step 5: Commit**

```bash
git add shared/schema.ts server/sqliteStorage.ts server/storage.test.ts
git commit -m "feat: persist feedback item lifecycle state"
```

### Task 2: Centralize Server-Side Lifecycle Rules And GitHub Defaults

**Files:**
- Create: `server/feedbackLifecycle.ts`
- Create: `server/feedbackLifecycle.test.ts`
- Modify: `server/github.ts`
- Modify: `server/github.test.ts`
- Modify: `server/babysitter.ts`

**Step 1: Add failing lifecycle helper tests**

- Create `server/feedbackLifecycle.test.ts` with pure-function coverage for:
  - new synced feedback defaulting to `pending`
  - manual accept mapping to `queued`
  - manual reject mapping to `rejected`
  - manual flag mapping to `flagged`
  - successful run mapping to `resolved`
  - failed claimed task mapping to `failed`

**Step 2: Add failing GitHub normalization expectations**

- Extend `server/github.test.ts` so every normalized feedback item now expects:

```ts
status: "pending",
statusReason: null,
```

- Add a focused assertion that a synced item carries those defaults even when review-thread metadata is present.

**Step 3: Run the targeted tests**

Run: `node --test --import tsx server/feedbackLifecycle.test.ts server/github.test.ts`
Expected: FAIL on missing lifecycle helpers and missing `status` fields.
If the pre-existing merge markers in `server/github.ts` or `server/github.test.ts` are still present, stop and clean the branch before continuing.

**Step 4: Implement the lifecycle helper and GitHub defaults**

- In `server/feedbackLifecycle.ts`, add small pure helpers such as:

```ts
export function applyManualDecision(...)
export function applyEvaluationDecision(...)
export function markInProgress(...)
export function markResolved(...)
export function markFailed(...)
```

- Keep the helper return type as a full `FeedbackItem` so callers do not repeat status-string logic.
- In `server/github.ts`, initialize every new feedback item with `status: "pending"` and `statusReason: null`.
- In `server/babysitter.ts`, update `mergeFeedbackItems(...)` to preserve `status` and `statusReason` from the previously stored item, just like it already preserves decision fields.

**Step 5: Re-run the targeted tests**

Run: `node --test --import tsx server/feedbackLifecycle.test.ts server/github.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add server/feedbackLifecycle.ts server/feedbackLifecycle.test.ts server/github.ts server/github.test.ts server/babysitter.ts
git commit -m "feat: add feedback lifecycle defaults and helpers"
```

### Task 3: Drive Manual Override And Legacy Triage Through Lifecycle State

**Files:**
- Modify: `server/routes.ts`
- Modify: `server/feedbackLifecycle.ts`
- Test: `server/feedbackLifecycle.test.ts`

**Step 1: Add failing helper tests for route-driven transitions**

- Add cases that prove:
  - `accept` returns `decision="accept"`, `status="queued"`, `statusReason="Manual override"`
  - `reject` returns `decision="reject"`, `status="rejected"`
  - `flag` returns `decision="flag"`, `status="flagged"`
  - legacy triage phrases map to `queued`, `rejected`, and `flagged`

**Step 2: Run the targeted helper test**

Run: `node --test --import tsx server/feedbackLifecycle.test.ts`
Expected: FAIL on the new manual-override and triage assertions.

**Step 3: Refactor `server/routes.ts` to use the helper**

- Replace the inline status-string mapping in:
  - `POST /api/prs/:id/triage`
  - `PATCH /api/prs/:id/feedback/:feedbackId`
- Call the lifecycle helper so the route only decides which transition to apply.
- Preserve existing `accepted`, `rejected`, and `flagged` PR counters for now.

**Step 4: Re-run the helper test and storage smoke test**

Run: `node --test --import tsx server/feedbackLifecycle.test.ts server/storage.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/routes.ts server/feedbackLifecycle.ts server/feedbackLifecycle.test.ts
git commit -m "feat: map manual feedback actions to lifecycle state"
```

### Task 4: Update Babysitter Runs To Claim, Resolve, And Fail Individual Comments

**Files:**
- Modify: `server/babysitter.ts`
- Test: `server/babysitter.test.ts`
- Test if needed: `server/feedbackLifecycle.test.ts`

**Step 1: Add failing babysitter tests for per-comment lifecycle transitions**

- Extend `server/babysitter.test.ts` with:
  - accepted pending comment becomes `queued`
  - selected comment task becomes `in_progress` before the agent runs
  - successful run marks only claimed comment tasks as `resolved`
  - failed run marks only claimed comment tasks as `failed`
  - rejected or already resolved comments are not pulled back into `in_progress`

**Step 2: Run the targeted babysitter test**

Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL on the new lifecycle assertions.
If the branch still contains the pre-existing `server/github.ts` conflict markers, stop and clean that up first because this test cannot run until those files parse again.

**Step 3: Implement the minimal babysitter transition logic**

- Split comment handling into two phases:
  - evaluation candidates: `status === "pending"`
  - execution candidates: `status === "queued"` and `decision === "accept"`
- After evaluation, persist the updated queued/rejected statuses.
- Right before `applyFixesWithAgent(...)`, mark `commentTasks` as `in_progress`.
- After successful verify + GitHub audit checks, mark those same claimed comments as `resolved`.
- In the `catch` path, if any claimed comments exist, mark only those comments as `failed` and set `statusReason` to the surfaced error summary.

**Step 4: Re-run the targeted tests**

Run: `node --test --import tsx server/babysitter.test.ts server/feedbackLifecycle.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/babysitter.ts server/babysitter.test.ts server/feedbackLifecycle.test.ts
git commit -m "feat: track babysitter progress per feedback item"
```

### Task 5: Add Client Helpers And Refresh The Dashboard Feed

**Files:**
- Create: `client/src/lib/feedbackStatus.ts`
- Create: `client/src/lib/feedbackStatus.test.ts`
- Modify: `client/src/pages/dashboard.tsx`
- Modify if needed: `client/src/index.css`

**Step 1: Add failing client helper tests**

- In `client/src/lib/feedbackStatus.test.ts`, cover:
  - `formatFeedbackStatusLabel("in_progress") === "IN PROGRESS"`
  - `isFeedbackCollapsedByDefault("resolved") === true`
  - `isFeedbackCollapsedByDefault("rejected") === true`
  - `isFeedbackCollapsedByDefault("failed") === false`
  - `countActiveFeedbackStatuses(items)` returns the right `queued`, `inProgress`, and `failed` counts

**Step 2: Run the targeted client helper test**

Run: `node --test --import tsx client/src/lib/feedbackStatus.test.ts`
Expected: FAIL because the helper module does not exist yet.

**Step 3: Implement the client helper and dashboard updates**

- In `client/src/lib/feedbackStatus.ts`, add pure helpers for:
  - status label formatting
  - badge class selection
  - default collapsed state
  - active-summary counting from `feedbackItems`
- In `client/src/pages/dashboard.tsx`:
  - replace `DecisionTag` with a `FeedbackStatusTag`
  - use the Radix `Collapsible` primitive for each feedback row
  - default `resolved` and `rejected` rows to collapsed
  - keep the header metadata visible even when collapsed
  - switch the PR summary from `accepted/rejected/flagged` emphasis to active counts derived from `feedbackItems`
  - prefer `item.statusReason` over `item.decisionReason` in the explanatory text

**Step 4: Run the helper test and full typecheck**

Run: `node --test --import tsx client/src/lib/feedbackStatus.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS with the new shared feedback status types wired through server and client code.

**Step 5: Commit**

```bash
git add client/src/lib/feedbackStatus.ts client/src/lib/feedbackStatus.test.ts client/src/pages/dashboard.tsx client/src/index.css
git commit -m "feat: show feedback lifecycle status in dashboard"
```

### Task 6: Final Verification And Manual Feed Smoke Check

**Files:**
- Modify if needed: `tasks/lessons.md`

**Step 1: Run the impacted automated checks**

Run: `node --test --import tsx server/storage.test.ts server/feedbackLifecycle.test.ts server/github.test.ts server/babysitter.test.ts client/src/lib/feedbackStatus.test.ts`
Expected: PASS once the pre-existing merge conflicts are gone and the feature is complete.

Run: `npm run check`
Expected: PASS.

**Step 2: Do a manual dashboard smoke test**

Run: `npm run dev`
Expected:
- comments start as `PENDING`
- manual accept changes the badge to `QUEUED`
- active run changes claimed comments to `IN PROGRESS`
- resolved and rejected comments render collapsed by default
- failed comments stay expanded and visible

**Step 3: Review the diff against the approved design**

- Confirm one visible status label per comment
- Confirm lifecycle survives refresh
- Confirm only resolved and rejected are auto-collapsed
- Confirm PR summaries emphasize active work, not legacy counters

**Step 4: Commit**

```bash
git add tasks/lessons.md
git commit -m "docs: record feedback lifecycle implementation lesson"
```
