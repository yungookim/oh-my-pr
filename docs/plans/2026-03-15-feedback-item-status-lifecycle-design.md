# Feedback Item Status Lifecycle Design

**Date:** 2026-03-15
**Status:** Approved

## Goal

Replace the comment feed's visible decision badge with one persisted lifecycle status per feedback item, so operators can see which comments are pending, queued, actively being fixed, resolved, failed, rejected, or flagged. Resolved and rejected comments should collapse by default to reduce visual noise while keeping their headers scannable.

## Requirements

- Persist one lifecycle status per feedback item across app restarts and GitHub sync refreshes.
- Track both autonomous babysitter activity and manual operator actions in that lifecycle.
- Keep one visible status label in the feed instead of the current separate decision tag.
- Preserve enough internal metadata to distinguish actionable comments from rejected or flagged comments during babysitter runs.
- Collapse feedback rows by default when their lifecycle status is `resolved` or `rejected`.
- Keep `failed`, `flagged`, `queued`, and `in_progress` comments expanded by default so active work stays visible.
- Ensure only comments actually claimed by a babysitter run move into `in_progress`, `resolved`, or `failed`.
- Preserve comment lifecycle state when GitHub sync rehydrates feedback items.

## Lifecycle Model

Each feedback item gets a persisted `status` and optional `statusReason`.

- `pending`
  Newly synced comment with no triage or operator action yet.
- `queued`
  Accepted for remediation and waiting for an autonomous run.
- `in_progress`
  Claimed by the coding agent for the current run.
- `resolved`
  The run completed successfully and GitHub audit-trail verification passed.
- `failed`
  The run claimed the comment but did not finish cleanly.
- `rejected`
  Explicitly judged non-actionable.
- `flagged`
  Needs manual review or special attention.

## State Transitions

- GitHub sync creates new comments as `pending`.
- Auto-triage or manual accept changes the comment to `queued`.
- Manual reject changes the comment to `rejected`.
- Manual flag changes the comment to `flagged`.
- When the babysitter prepares a fix run, only the accepted comments selected for that run move to `in_progress`.
- After successful code verification and GitHub audit-trail verification, claimed comments move to `resolved`.
- If the run fails after claiming comments, only those claimed comments move to `failed`.
- Manual accept from `failed`, `flagged`, `rejected`, or `resolved` sends the comment back to `queued`.

This keeps manual operator intent and autonomous remediation progress in one user-visible label without losing the ability to requeue prior comments.

## Data Model

`FeedbackItem` gains:

- `status`
  Enum of `pending | queued | in_progress | resolved | failed | rejected | flagged`.
- `statusReason`
  Short operator-facing explanation for the current status.

The existing `decision`, `decisionReason`, and `action` fields remain for now as internal compatibility fields. They already drive accepted-comment selection in the babysitter flow, and keeping them in this pass avoids a larger server rewrite. The UI should stop rendering `decision` directly and instead render the new lifecycle status.

## Persistence And Sync

The SQLite `feedback_items` table should add:

- `status TEXT NOT NULL DEFAULT 'pending'`
- `status_reason TEXT`

The existing bootstrap migration path in `SqliteStorage.ensureColumn(...)` is sufficient for adding these columns without rebuilding the table. Feedback item loading and replacement should read and write the new fields, and `shared/schema.ts` should expose them through the shared `FeedbackItem` type.

`mergeFeedbackItems(...)` in `server/babysitter.ts` must preserve `status` and `statusReason` from existing stored items when GitHub refresh returns the same comment again. Historical comments that remain in storage after disappearing from the GitHub API should also keep their latest lifecycle state, matching the current behavior for decision preservation.

## Server Behavior

### GitHub Ingestion

When GitHub feedback is first normalized in `server/github.ts`, new items should be created with:

- `status: "pending"`
- `statusReason: null`

### Manual Overrides

The existing `PATCH /api/prs/:id/feedback/:feedbackId` override endpoint should continue to accept `accept`, `reject`, and `flag`, but it should also update lifecycle state:

- `accept` -> `decision="accept"`, `status="queued"`
- `reject` -> `decision="reject"`, `status="rejected"`
- `flag` -> `decision="flag"`, `status="flagged"`

`statusReason` should describe the manual action, for example `Manual override`.

### Automatic Triage

The legacy triage path should map its existing decisions into lifecycle state:

- actionable comment -> `queued`
- acknowledgement/non-actionable comment -> `rejected`
- ambiguous comment -> `flagged`

That keeps older routes behaviorally correct even if the primary flow is the autonomous babysitter.

### Babysitter Run Flow

The babysitter remains the owner of autonomous lifecycle transitions:

1. Evaluate pending comments and set accepted comments to `queued`, rejected comments to `rejected`, with explanatory `statusReason`.
2. Immediately before launching the coding agent, move only the selected comment tasks to `in_progress`.
3. If the run completes, the branch verification passes, and GitHub audit-trail verification passes, move those claimed comments to `resolved`.
4. If the run fails after claiming comments, move only those claimed comments to `failed` and store the failure summary in `statusReason`.
5. Comments not selected for the run must keep their prior lifecycle state.

This avoids smearing one run failure across unrelated comments and makes the feed trustworthy.

## UI Design

The dashboard should render one status badge per feedback item instead of the current decision tag. Suggested labels:

- `PENDING`
- `QUEUED`
- `IN PROGRESS`
- `RESOLVED`
- `FAILED`
- `REJECTED`
- `FLAGGED`

The badge treatment should make `in_progress` visually active and `failed` clearly prominent. The current body, metadata row, and manual action buttons remain, but the visible explanation line should prefer `statusReason`.

Each feedback row should become a collapsible item:

- default collapsed when `status` is `resolved` or `rejected`
- default expanded for every other status

The collapsed header still shows:

- author
- file and line, if present
- comment type
- timestamp
- lifecycle status badge

Expanding the row reveals the markdown body and any explanatory reason text. This keeps finished or dismissed comments scanable without letting them dominate the feed.

## PR Summary Changes

The PR list row and selected PR header should stop emphasizing the legacy accepted/rejected/flagged counters as the primary visible summary. Instead, they should surface active lifecycle counts, especially:

- queued
- in progress
- failed

The internal counters can remain for compatibility during this pass, but the operator-facing summary should reflect the lifecycle model they now see in the comment feed.

## Testing Strategy

Add focused coverage for:

- shared schema parsing of feedback item lifecycle fields
- SQLite persistence and reload of `status` and `statusReason`
- merge preservation of lifecycle fields across GitHub sync
- manual override transitions to `queued`, `rejected`, and `flagged`
- babysitter transitions from `pending -> queued -> in_progress -> resolved`
- babysitter failure transitions from `in_progress -> failed`
- partial-run behavior where only claimed comments are updated
- dashboard rendering of the lifecycle badge
- default collapsed rendering for `resolved` and `rejected`
- default expanded rendering for active statuses

## Risks And Constraints

- Keeping `decision` and `status` in parallel introduces temporary duplication, so transition rules must stay consistent.
- Old stored rows need safe defaults so the UI does not break when loading pre-migration state.
- The dashboard should avoid collapsing comments in a way that hides actionable failures or active work.
- The worktree currently contains unrelated merge conflicts, so this design can be documented safely but should not assume a clean commit path until those conflicts are resolved.
