import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import { MemStorage } from "./storage";
import { GitHubIntegrationError } from "./github";
import { applyManualFeedbackDecision } from "./manualFeedback";

function makeFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "gh-review-comment-1",
    author: "alice",
    body: "Please fix this",
    bodyHtml: "<p>Please fix this</p>",
    replyKind: "review_thread",
    sourceId: "1",
    sourceNodeId: null,
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r1",
    threadId: "PRRT_kwDO_example",
    threadResolved: false,
    auditToken: "codefactory-feedback:gh-review-comment-1",
    file: "server/example.ts",
    line: 10,
    type: "review_comment",
    createdAt: "2026-04-01T10:00:00Z",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
    ...overrides,
  };
}

async function addPRWithFeedback(storage: MemStorage, feedbackItems: FeedbackItem[]) {
  return storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems,
    accepted: feedbackItems.filter((item) => item.decision === "accept").length,
    rejected: feedbackItems.filter((item) => item.decision === "reject").length,
    flagged: feedbackItems.filter((item) => item.decision === "flag").length,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
}

test("applyManualFeedbackDecision resolves GitHub review threads when feedback is rejected", async () => {
  const storage = new MemStorage();
  const item = makeFeedbackItem();
  const pr = await addPRWithFeedback(storage, [item]);
  const resolvedThreads: string[] = [];

  const updated = await applyManualFeedbackDecision({
    storage,
    pr,
    feedbackId: item.id,
    decision: "reject",
    github: {
      buildOctokit: async () => ({}) as never,
      resolveReviewThread: async (_octokit, parsed, threadId) => {
        assert.deepEqual(parsed, { owner: "octo", repo: "example", number: 42 });
        resolvedThreads.push(threadId);
      },
    },
  });

  const updatedItem = updated?.feedbackItems.find((candidate) => candidate.id === item.id);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
  assert.equal(updatedItem?.decision, "reject");
  assert.equal(updatedItem?.status, "rejected");
  assert.equal(updatedItem?.threadResolved, true);
  assert.equal(updated?.rejected, 1);
});

test("applyManualFeedbackDecision still rejects locally when the review thread ID is unavailable", async () => {
  const storage = new MemStorage();
  const item = makeFeedbackItem({ threadId: null, threadResolved: null });
  const pr = await addPRWithFeedback(storage, [item]);
  let buildCalled = false;
  let resolveCalled = false;

  const updated = await applyManualFeedbackDecision({
    storage,
    pr,
    feedbackId: item.id,
    decision: "reject",
    github: {
      buildOctokit: async () => {
        buildCalled = true;
        return {} as never;
      },
      resolveReviewThread: async () => {
        resolveCalled = true;
      },
    },
  });

  const updatedItem = updated?.feedbackItems.find((candidate) => candidate.id === item.id);
  assert.equal(buildCalled, false);
  assert.equal(resolveCalled, false);
  assert.equal(updatedItem?.status, "rejected");
  assert.equal(updatedItem?.threadResolved, null);
});

test("applyManualFeedbackDecision does not persist thread resolution when GitHub resolution fails", async () => {
  const storage = new MemStorage();
  const item = makeFeedbackItem();
  const pr = await addPRWithFeedback(storage, [item]);

  await assert.rejects(
    () => applyManualFeedbackDecision({
      storage,
      pr,
      feedbackId: item.id,
      decision: "reject",
      github: {
        buildOctokit: async () => ({}) as never,
        resolveReviewThread: async () => {
          throw new GitHubIntegrationError("GitHub review thread resolution failed", 502);
        },
      },
    }),
    /GitHub review thread resolution failed/,
  );

  const reloaded = await storage.getPR(pr.id);
  const reloadedItem = reloaded?.feedbackItems.find((candidate) => candidate.id === item.id);
  assert.equal(reloadedItem?.decision, null);
  assert.equal(reloadedItem?.status, "pending");
  assert.equal(reloadedItem?.threadResolved, false);
  assert.equal(reloaded?.rejected, 0);
});
