import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import {
  formatFeedbackOverview,
  getFeedbackGroupSections,
  getFeedbackPreview,
} from "./feedbackDisplay";

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "gh-review-comment-1",
    author: "reviewer",
    body: "Please rename this variable.",
    bodyHtml: "<p>Please rename this variable.</p>",
    replyKind: "review_thread",
    sourceId: "1",
    sourceNodeId: "PRRC_kwDO_example",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r1",
    threadId: "PRRT_kwDO_example",
    threadResolved: false,
    auditToken: "codefactory-feedback:gh-review-comment-1",
    file: "src/example.ts",
    line: 12,
    type: "review_comment",
    createdAt: "2026-03-15T10:00:00.000Z",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
    ...overrides,
  };
}

test("getFeedbackPreview skips generic review headings and strips markdown noise", () => {
  const item = makeItem({
    body: [
      "## Code Review",
      "",
      "**Medium**",
      "",
      "This returns `Element | null`; use an explicit cast before passing it to Tauri.",
    ].join("\n"),
  });

  assert.equal(
    getFeedbackPreview(item),
    "This returns Element | null; use an explicit cast before passing it to Tauri.",
  );
});

test("getFeedbackPreview strips inline HTML badges from bot comments", () => {
  const item = makeItem({
    body: '<a href=""><img alt="P2" src="https://example.com/p2.svg" align="top"></a> Silent failure swallows broken link open errors.',
  });

  assert.equal(
    getFeedbackPreview(item),
    "P2 Silent failure swallows broken link open errors.",
  );
});

test("getFeedbackGroupSections groups attention, running, and done feedback in priority order", () => {
  const sections = getFeedbackGroupSections([
    makeItem({ id: "resolved", status: "resolved" }),
    makeItem({ id: "running", status: "in_progress" }),
    makeItem({ id: "failed", status: "failed" }),
    makeItem({ id: "rejected", status: "rejected" }),
  ]);

  assert.deepEqual(
    sections.map((section) => [section.key, section.items.map((item) => item.id)]),
    [
      ["attention", ["failed"]],
      ["running", ["running"]],
      ["done", ["resolved", "rejected"]],
    ],
  );
});

test("formatFeedbackOverview foregrounds the most important PR state", () => {
  assert.equal(
    formatFeedbackOverview([
      makeItem({ id: "failed", status: "failed" }),
      makeItem({ id: "running", status: "in_progress" }),
      makeItem({ id: "rejected", status: "rejected" }),
    ]),
    "1 failed · 1 running · 1 done",
  );
});

test("formatFeedbackOverview keeps running and done labels readable for plural counts", () => {
  assert.equal(
    formatFeedbackOverview([
      makeItem({ id: "running-1", status: "in_progress" }),
      makeItem({ id: "running-2", status: "queued" }),
      makeItem({ id: "resolved", status: "resolved" }),
      makeItem({ id: "rejected", status: "rejected" }),
    ]),
    "2 running · 2 done",
  );
});
