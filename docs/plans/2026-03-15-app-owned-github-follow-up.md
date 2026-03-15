# App-Owned GitHub Follow-Up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the app, not the coding agent, post PR feedback follow-up replies and resolve review threads after a successful fix run.

**Architecture:** Extend `server/github.ts` with explicit GitHub follow-up helpers plus robust review-thread lookup pagination, then refactor `PRBabysitter` to call those helpers after branch verification and before audit-trail verification. Keep the agent focused on code changes, tests, commit, and push.

**Tech Stack:** Node.js, TypeScript, Octokit REST/GraphQL, existing babysitter/storage/github modules, Node test runner via `node --test --import tsx`

---

### Task 1: Document And Lock The Reply/Resolve Surface

**Files:**
- Modify: `server/github.ts`
- Test: `server/github.test.ts`

**Step 1: Add failing tests for review-thread pagination**

- Simulate a review thread whose nested comments span multiple GraphQL pages.
- Assert that the returned review comment item gets the correct `threadId` and `threadResolved`.

**Step 2: Add failing tests for follow-up helpers**

- Assert the correct request shape for:
  - review-thread reply
  - review-thread resolve
  - review/body follow-up
  - general PR comment follow-up

**Step 3: Implement minimal GitHub helpers**

- Add dedicated helper functions for reply and resolve operations.
- Keep all errors wrapped in `GitHubIntegrationError`.

**Step 4: Run targeted tests**

Run: `node --test --import tsx server/github.test.ts`

**Step 5: Commit**

```bash
git add server/github.ts server/github.test.ts
git commit -m "feat: add app-owned github follow-up helpers"
```

### Task 2: Move Follow-Up Orchestration Into `PRBabysitter`

**Files:**
- Modify: `server/babysitter.ts`
- Test: `server/babysitter.test.ts`

**Step 1: Add failing tests for app-owned follow-up**

- Success case: agent only changes code; babysitter posts follow-up itself and run ends in `watching`.
- Failure case: GitHub reply/resolve helper throws; babysitter marks the PR run as `error`.

**Step 2: Refactor the agent contract**

- Remove instructions that make the agent responsible for replying/resolving comments.
- Keep audit-token context in the prompt so the app can produce deterministic follow-up text.

**Step 3: Implement babysitter-side follow-up**

- After agent success and branch verification, post replies for accepted comment tasks.
- Resolve review threads for `review_thread` items.
- Re-sync feedback and keep the existing audit-trail verification.

**Step 4: Run targeted tests**

Run: `node --test --import tsx server/babysitter.test.ts`

**Step 5: Commit**

```bash
git add server/babysitter.ts server/babysitter.test.ts
git commit -m "feat: move pr feedback follow-up into babysitter"
```

### Task 3: End-To-End Verification

**Files:**
- Modify if needed: `tasks/lessons.md`

**Step 1: Run the focused backend test suite**

Run: `node --test --import tsx server/github.test.ts server/babysitter.test.ts`

**Step 2: Run any directly impacted supporting tests**

Run: `node --test --import tsx server/storage.test.ts`

**Step 3: Review diffs and summarize operational behavior**

- Confirm the app now owns GitHub follow-up.
- Confirm review-thread metadata is present for long threads.
- Confirm verification still fails if GitHub follow-up cannot be completed.

**Step 4: Commit**

```bash
git add tasks/lessons.md
git commit -m "docs: record babysitter github follow-up lesson"
```
