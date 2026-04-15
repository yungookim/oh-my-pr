import assert from "node:assert/strict";
import test from "node:test";
import type { PR } from "@shared/schema";
import {
  formatFeedbackStatusLabel,
  formatPrRow,
  formatStatusLabel,
  getFeedbackActions,
  getLayoutMode,
  wrapText,
} from "./tui/viewModel";

function createPr(overrides: Partial<PR> = {}): PR {
  return {
    id: "pr-1",
    number: 42,
    title: "feat: add widget",
    repo: "acme/widgets",
    branch: "feat/widget",
    author: "alice",
    url: "https://github.com/acme/widgets/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    watchEnabled: true,
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("getLayoutMode selects full, stacked, and compact layouts", () => {
  assert.equal(getLayoutMode(160), "full");
  assert.equal(getLayoutMode(120), "stacked");
  assert.equal(getLayoutMode(90), "compact-warning");
});

test("formatStatusLabel maps PR statuses to operator-facing labels", () => {
  assert.equal(formatStatusLabel("watching"), "watching");
  assert.equal(formatStatusLabel("processing"), "running");
  assert.equal(formatStatusLabel("done"), "done");
  assert.equal(formatStatusLabel("error"), "needs attention");
});

test("formatPrRow includes watch state and work summary", () => {
  const pr = createPr({
    watchEnabled: false,
    feedbackItems: [
      {
        id: "f1",
        author: "bob",
        body: "Please fix this",
        bodyHtml: "<p>Please fix this</p>",
        replyKind: "review_thread",
        sourceId: "1",
        sourceNodeId: null,
        sourceUrl: null,
        threadId: null,
        threadResolved: null,
        auditToken: "token-1",
        file: "src/app.ts",
        line: 10,
        type: "review_comment",
        createdAt: new Date().toISOString(),
        decision: "accept",
        decisionReason: null,
        action: null,
        status: "queued",
        statusReason: null,
      },
    ],
  });

  assert.match(formatPrRow(pr), /watch paused/);
  assert.match(formatPrRow(pr), /1q/);
});

test("getFeedbackActions includes retry only for failed and warning rows", () => {
  const base = {
    id: "f1",
    author: "bob",
    body: "Please fix this",
    bodyHtml: "<p>Please fix this</p>",
    replyKind: "review_thread" as const,
    sourceId: "1",
    sourceNodeId: null,
    sourceUrl: null,
    threadId: null,
    threadResolved: null,
    auditToken: "token-1",
    file: "src/app.ts",
    line: 10,
    type: "review_comment" as const,
    createdAt: new Date().toISOString(),
    decision: "accept" as const,
    decisionReason: null,
    action: null,
    statusReason: null,
  };

  assert.deepEqual(getFeedbackActions({ ...base, status: "failed" }), ["Accept", "Reject", "Flag", "Retry"]);
  assert.deepEqual(getFeedbackActions({ ...base, status: "warning" }), ["Accept", "Reject", "Flag", "Retry"]);
  assert.deepEqual(getFeedbackActions({ ...base, status: "queued" }), ["Accept", "Reject", "Flag"]);
});

test("formatFeedbackStatusLabel normalizes underscores", () => {
  assert.equal(formatFeedbackStatusLabel("in_progress"), "IN PROGRESS");
});

test("wrapText keeps lines under the requested width", () => {
  const lines = wrapText("one two three four", 7);
  assert.deepEqual(lines, ["one two", "three", "four"]);
});
