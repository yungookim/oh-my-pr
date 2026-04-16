import assert from "node:assert/strict";
import test from "node:test";
import type { PR } from "@shared/schema";
import {
  formatFeedbackStatusLabel,
  formatPrRow,
  formatStatusLabel,
  getDisplayWidth,
  getFeedbackActions,
  getLayoutMode,
  getViewportRange,
  middleTruncateText,
  truncateText,
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

test("truncate helpers keep the start or both ends visible", () => {
  assert.equal(truncateText("frontend/src/router/index.ts", 12), "frontend/sr…");
  assert.equal(middleTruncateText("abcdefghijklmnopqrstuvwxyz", 9), "abcd…wxyz");
});

test("truncate helpers honor terminal display width for wide glyphs", () => {
  assert.equal(getDisplayWidth("❯ review"), 8);
  assert.equal(truncateText("❯ review ready", 9), "❯ review…");
  assert.equal(middleTruncateText("frontend/❯/component.ts", 12), "fronte…nt.ts");
});

test("getViewportRange keeps the selected row within the visible window", () => {
  assert.deepEqual(getViewportRange(20, 0, 5), {
    start: 0,
    end: 5,
    hiddenAbove: 0,
    hiddenBelow: 15,
  });
  assert.deepEqual(getViewportRange(20, 10, 5), {
    start: 8,
    end: 13,
    hiddenAbove: 8,
    hiddenBelow: 7,
  });
  assert.deepEqual(getViewportRange(20, 19, 5), {
    start: 15,
    end: 20,
    hiddenAbove: 15,
    hiddenBelow: 0,
  });
});

test("wrapText keeps lines under the requested width", () => {
  const lines = wrapText("one two three four", 7);
  assert.deepEqual(lines, ["one two", "three", "four"]);
});

test("wrapText hard-wraps long unbroken tokens", () => {
  const lines = wrapText("abcdefghijklmnopqrstuvwxyz", 8);
  assert.deepEqual(lines, ["abcdefgh", "ijklmnop", "qrstuvwx", "yz"]);
});

test("wrapText makes progress when width is narrower than a wide glyph", () => {
  // A single wide CJK character has display width 2; requesting width 1 used
  // to loop forever because takeDisplayWidth returned "" each iteration.
  const lines = wrapText("漢字", 1);
  assert.deepEqual(lines, ["漢", "字"]);
});
