import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import {
  applyManualDecision,
  applyEvaluationDecision,
  markInProgress,
  markResolved,
  markFailed,
} from "./feedbackLifecycle";

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

test("markResolved maps to resolved", () => {
  const item = makeItem({ status: "in_progress" });
  const result = markResolved(item);
  assert.equal(result.status, "resolved");
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
