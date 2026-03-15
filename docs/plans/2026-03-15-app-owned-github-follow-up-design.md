# App-Owned GitHub Follow-Up Design

**Date:** 2026-03-15
**Status:** Approved

## Goal

Move PR feedback replies and review-thread resolution out of the coding agent and into the app so babysitter runs no longer fail when sandboxed agent-side `gh api` calls cannot reach GitHub.

## Problem

The current babysitter contract tells the coding agent to:

- push code changes,
- post GitHub replies for addressed feedback,
- resolve review threads.

That design is brittle in this environment for two reasons:

1. The agent runs inside a more constrained sandbox than the app runtime. Logs from 2026-03-15 show the agent could push code and post a top-level PR comment with `gh pr comment`, but could not perform the review-thread `gh api` calls required for inline replies and thread resolution.
2. The app still treats unresolved review threads as a hard verification failure, so successful code changes are discarded as run failures when GitHub follow-up is incomplete.

There is also a metadata weakness: `fetchReviewThreadLookup` only loads the first 100 comments per review thread, so long threads can leave `threadId` unset for later inline comments.

## Requirements

- Keep the agent focused on repository work: inspect, edit, test, commit, push.
- Move GitHub follow-up into app-owned code that already uses Octokit and the app’s GitHub auth path.
- Post one short, per-item follow-up for every accepted feedback item, with the exact audit token.
- Resolve each addressed `review_thread` item after posting its in-thread reply.
- Keep support for `review`, `review_thread`, and `general_comment` reply targets.
- Fix review-thread lookup so inline comments in long threads still map to the correct `threadId`.
- Preserve the existing post-run verification contract: a run only succeeds if the audit trail exists and review threads are actually resolved.

## Recommended Approach

Implement GitHub follow-up inside `server/github.ts` and orchestrate it from `PRBabysitter` after the agent finishes and branch movement is verified.

### Why this approach

- It uses the app’s existing Octokit/auth integration instead of depending on shelling out from a sandboxed agent.
- It keeps deterministic operational behavior in the app and judgment-heavy code changes in the agent.
- It lets verification assert against actions the app itself performed, reducing false failures.

## Rejected Alternatives

### 1. Keep GitHub follow-up in the agent

This preserves the original boundary but keeps the most failure-prone part in the least reliable execution context. The logs already show that `gh api` connectivity differs from what the app runtime can do.

### 2. Relax verification and accept unresolved threads

This would make runs appear successful while leaving stale review threads open. That directly conflicts with the intended babysitter behavior.

## Architecture

### Agent responsibilities

- Make targeted code changes for accepted feedback and failing statuses.
- Run verification.
- Commit and push to the PR head branch.
- Summarize the changes in stdout/stderr so the app logs remain useful.

The agent no longer owns GitHub replies or thread resolution.

### App responsibilities

- Prepare the isolated worktree.
- Launch the agent with GitHub auth if useful for repo operations.
- Verify clean worktree and pushed branch state.
- Post GitHub follow-up comments/replies for accepted feedback items.
- Resolve review threads after successful in-thread replies.
- Re-sync GitHub feedback and verify the audit trail.

## GitHub Follow-Up API Surface

Add explicit helpers in `server/github.ts`:

- `replyToReviewThread(...)`
- `replyToReview(...)`
- `replyToIssueComment(...)`
- `resolveReviewThread(...)`
- `postFollowUpForFeedbackItem(...)`

`postFollowUpForFeedbackItem(...)` should switch on `replyKind`:

- `review_thread`: reply in-thread using the thread id, then resolve the thread
- `review`: post a PR review comment/body-level follow-up
- `general_comment`: post a normal issue comment on the PR

Each helper should use Octokit REST or GraphQL directly and route errors through the existing GitHub integration error wrapper.

## Review Thread Lookup Fix

The existing review-thread lookup must page nested thread comments, not just top-level thread pages. The cleanest shape is:

- keep the current `reviewThreads(first: 100, after: $cursor)` pagination,
- include `comments.pageInfo`,
- for any thread with more nested comments, page that thread’s comments through a dedicated `node(id: $threadId)` query,
- add every `databaseId` to the lookup map with `threadId` and `threadResolved`.

This ensures the babysitter always has a usable thread id before it tries to reply or resolve.

## Babysitter Flow Changes

After the agent exits successfully and the branch state is verified:

1. Build or reuse the app-owned Octokit client.
2. For each accepted comment task, generate a short follow-up body containing:
   - what was addressed or why it could not be safely applied,
   - the exact audit token.
3. Post the follow-up using the appropriate GitHub helper.
4. Resolve the review thread when the item is `review_thread`.
5. Re-sync feedback from GitHub.
6. Verify the audit trail and resolved state.

If app-owned follow-up fails for any item, fail the run and keep the PR in `error`.

## Testing Strategy

Add or extend tests for:

- long-thread lookup pagination in `server/github.test.ts`,
- reply/resolve helper request shapes in `server/github.test.ts`,
- successful app-owned follow-up after an agent run in `server/babysitter.test.ts`,
- failure propagation when GitHub follow-up fails in `server/babysitter.test.ts`.

## Risks

- GitHub GraphQL reply/resolve mutations need exact input ids and response parsing; the tests should pin the request shape tightly.
- The app must not double-post replies on reruns. The audit-trail verification should stay token-based and the post-follow-up step should only run for accepted tasks in the current run window.
- Reply text should remain short and deterministic; this is operational output, not a second agent reasoning surface.
