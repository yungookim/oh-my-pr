import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import {
  applyManualDecision,
  applyEvaluationDecision,
  applyFlagDecision,
  isFeedbackClosedStatus,
  markReviewConversationResolved,
  markInProgress,
  markResolved,
  markFailed,
  markWarning,
  markRetry,
  shouldResolveReviewConversation,
} from "./feedbackLifecycle";

function applyLegacyTriage(item: FeedbackItem): FeedbackItem {
  const body = item.body.toLowerCase();
  if (body.includes("lgtm") || body.includes("looks good")) {
    return applyEvaluationDecision(item, false, "Acknowledgement, no code change requested");
  }
  if (body.includes("please") || body.includes("should") || body.includes("fix") || body.includes("error") || body.includes("fail")) {
    return applyEvaluationDecision(item, true, "Likely actionable request");
  }
  return applyFlagDecision(item, "Unclear actionability, flagged for manual review");
}

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "gh-review-comment-1",
    author: "alice",
    body: "Please fix this",
    bodyHtml: "<p>Please fix this</p>",
    replyKind: "review_thread",
    sourceId: "1",
    sourceNodeId: null,
    sourceUrl: null,
    threadId: null,
    threadResolved: null,
    auditToken: "codefactory-feedback:gh-review-comment-1",
    file: null,
    line: null,
    type: "review_comment",
    createdAt: "2026-03-15T10:00:00Z",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
    ...overrides,
  };
}

test("new synced feedback defaults to pending", () => {
  const item = makeItem();
  assert.equal(item.status, "pending");
  assert.equal(item.statusReason, null);
});

test("applyManualDecision accept maps to queued", () => {
  const item = makeItem();
  const result = applyManualDecision(item, "accept");
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "queued");
  assert.equal(result.statusReason, "Manual override");
});

test("applyManualDecision reject maps to rejected", () => {
  const item = makeItem();
  const result = applyManualDecision(item, "reject");
  assert.equal(result.decision, "reject");
  assert.equal(result.status, "rejected");
  assert.equal(result.statusReason, "Manual override");
});

test("applyManualDecision flag maps to flagged", () => {
  const item = makeItem();
  const result = applyManualDecision(item, "flag");
  assert.equal(result.decision, "flag");
  assert.equal(result.status, "flagged");
  assert.equal(result.statusReason, "Manual override");
});

test("applyEvaluationDecision needsFix=true maps to queued", () => {
  const item = makeItem();
  const result = applyEvaluationDecision(item, true, "Needs code change");
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "queued");
  assert.equal(result.statusReason, "Needs code change");
});

test("applyEvaluationDecision needsFix=false maps to rejected", () => {
  const item = makeItem();
  const result = applyEvaluationDecision(item, false, "Non-actionable comment");
  assert.equal(result.decision, "reject");
  assert.equal(result.status, "rejected");
  assert.equal(result.statusReason, "Non-actionable comment");
});

test("markInProgress maps to in_progress", () => {
  const item = makeItem({ status: "queued" });
  const result = markInProgress(item);
  assert.equal(result.status, "in_progress");
});

test("markResolved maps to resolved", () => {
  const item = makeItem({ status: "in_progress" });
  const result = markResolved(item);
  assert.equal(result.status, "resolved");
});

test("isFeedbackClosedStatus only treats rejected and resolved as closed", () => {
  assert.equal(isFeedbackClosedStatus("rejected"), true);
  assert.equal(isFeedbackClosedStatus("resolved"), true);
  assert.equal(isFeedbackClosedStatus("queued"), false);
});

test("shouldResolveReviewConversation closes unresolved review threads for terminal states", () => {
  assert.equal(
    shouldResolveReviewConversation(makeItem({ status: "rejected", threadId: "PRRT_kwDO_example", threadResolved: false })),
    true,
  );
  assert.equal(
    shouldResolveReviewConversation(makeItem({ status: "resolved", threadId: "PRRT_kwDO_example", threadResolved: false })),
    true,
  );
  assert.equal(
    shouldResolveReviewConversation(makeItem({ status: "queued", threadId: "PRRT_kwDO_example", threadResolved: false })),
    false,
  );
  assert.equal(
    shouldResolveReviewConversation(makeItem({
      replyKind: "general_comment",
      type: "general_comment",
      status: "resolved",
      threadResolved: false,
    })),
    false,
  );
});

test("markReviewConversationResolved sets threadResolved for review threads only", () => {
  const reviewThread = makeItem({ threadResolved: false });
  const resolvedThread = markReviewConversationResolved(reviewThread);
  assert.equal(resolvedThread.threadResolved, true);

  const generalComment = makeItem({
    replyKind: "general_comment",
    type: "general_comment",
    threadResolved: null,
  });
  const untouchedComment = markReviewConversationResolved(generalComment);
  assert.equal(untouchedComment.threadResolved, null);
});

test("markFailed maps to failed with reason", () => {
  const item = makeItem({ status: "in_progress" });
  const result = markFailed(item, "Agent timed out");
  assert.equal(result.status, "failed");
  assert.equal(result.statusReason, "Agent timed out");
});

test("helpers return full FeedbackItem with unchanged fields preserved", () => {
  const item = makeItem({ author: "bob", body: "Check this" });
  const result = applyManualDecision(item, "accept");
  assert.equal(result.author, "bob");
  assert.equal(result.body, "Check this");
  assert.equal(result.id, item.id);
});

test("applyFlagDecision maps to flagged with reason", () => {
  const item = makeItem();
  const result = applyFlagDecision(item, "Unclear actionability");
  assert.equal(result.decision, "flag");
  assert.equal(result.status, "flagged");
  assert.equal(result.statusReason, "Unclear actionability");
});

test("applyLegacyTriage lgtm phrase maps to rejected", () => {
  const item = makeItem({ body: "LGTM, looks good to me!" });
  const result = applyLegacyTriage(item);
  assert.equal(result.decision, "reject");
  assert.equal(result.status, "rejected");
  assert.equal(result.statusReason, "Acknowledgement, no code change requested");
});

test("applyLegacyTriage looks good phrase maps to rejected", () => {
  const item = makeItem({ body: "Looks good overall" });
  const result = applyLegacyTriage(item);
  assert.equal(result.decision, "reject");
  assert.equal(result.status, "rejected");
});

test("applyLegacyTriage actionable phrase maps to queued", () => {
  const item = makeItem({ body: "Please fix the null check here" });
  const result = applyLegacyTriage(item);
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "queued");
  assert.equal(result.statusReason, "Likely actionable request");
});

test("applyLegacyTriage should phrase maps to queued", () => {
  const item = makeItem({ body: "This should be refactored" });
  const result = applyLegacyTriage(item);
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "queued");
});

test("applyLegacyTriage ambiguous phrase maps to flagged", () => {
  const item = makeItem({ body: "Interesting approach here" });
  const result = applyLegacyTriage(item);
  assert.equal(result.decision, "flag");
  assert.equal(result.status, "flagged");
  assert.equal(result.statusReason, "Unclear actionability, flagged for manual review");
});

test("markWarning sets status to warning with reason", () => {
  const item = makeItem({ status: "in_progress" });
  const result = markWarning(item, "Rate limit approaching");
  assert.equal(result.status, "warning");
  assert.equal(result.statusReason, "Rate limit approaching");
});

test("markWarning preserves other fields", () => {
  const item = makeItem({ author: "carol", decision: "accept", status: "queued" });
  const result = markWarning(item, "Partial failure");
  assert.equal(result.author, "carol");
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "warning");
  assert.equal(result.statusReason, "Partial failure");
});

test("markRetry sets status to queued with retry reason", () => {
  const item = makeItem({ status: "failed", statusReason: "Agent timed out" });
  const result = markRetry(item);
  assert.equal(result.status, "queued");
  assert.equal(result.statusReason, "Queued for retry");
});

test("markRetry preserves other fields", () => {
  const item = makeItem({ author: "dave", decision: "accept", status: "failed" });
  const result = markRetry(item);
  assert.equal(result.author, "dave");
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "queued");
});

test("re-applying applyManualDecision reject on a previously accepted item overrides decision", () => {
  const item = makeItem({ decision: "accept", status: "queued", statusReason: "Manual override" });
  const result = applyManualDecision(item, "reject");
  assert.equal(result.decision, "reject");
  assert.equal(result.status, "rejected");
  assert.equal(result.statusReason, "Manual override");
});

test("re-applying applyManualDecision accept on a previously rejected item overrides decision", () => {
  const item = makeItem({ decision: "reject", status: "rejected", statusReason: "Manual override" });
  const result = applyManualDecision(item, "accept");
  assert.equal(result.decision, "accept");
  assert.equal(result.status, "queued");
  assert.equal(result.statusReason, "Manual override");
});

test("re-applying applyManualDecision flag on a previously accepted item overrides decision", () => {
  const item = makeItem({ decision: "accept", status: "queued", statusReason: "Manual override" });
  const result = applyManualDecision(item, "flag");
  assert.equal(result.decision, "flag");
  assert.equal(result.status, "flagged");
  assert.equal(result.statusReason, "Manual override");
});

test("status transitions do not mutate the original item", () => {
  const original = makeItem({ status: "pending", statusReason: null, decision: null });
  const afterDecision = applyManualDecision(original, "accept");
  const afterInProgress = markInProgress(afterDecision);
  const afterWarning = markWarning(afterInProgress, "Something odd");
  const afterFailed = markFailed(afterWarning, "Crashed");
  const afterRetry = markRetry(afterFailed);
  const afterResolved = markResolved(markInProgress(afterRetry));

  // Original item must be completely unchanged
  assert.equal(original.status, "pending");
  assert.equal(original.statusReason, null);
  assert.equal(original.decision, null);

  // Each intermediate must retain its own values
  assert.equal(afterDecision.status, "queued");
  assert.equal(afterInProgress.status, "in_progress");
  assert.equal(afterWarning.status, "warning");
  assert.equal(afterFailed.status, "failed");
  assert.equal(afterRetry.status, "queued");
  assert.equal(afterResolved.status, "resolved");
});
