import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import {
  formatFeedbackStatusLabel,
  isFeedbackCollapsedByDefault,
  countActiveFeedbackStatuses,
} from "./feedbackStatus";

// formatFeedbackStatusLabel
test('formatFeedbackStatusLabel("in_progress") === "IN PROGRESS"', () => {
  assert.equal(formatFeedbackStatusLabel("in_progress"), "IN PROGRESS");
});

test('formatFeedbackStatusLabel("resolved") === "RESOLVED"', () => {
  assert.equal(formatFeedbackStatusLabel("resolved"), "RESOLVED");
});

// isFeedbackCollapsedByDefault
test('isFeedbackCollapsedByDefault("resolved") === true', () => {
  assert.equal(isFeedbackCollapsedByDefault("resolved"), true);
});

test('isFeedbackCollapsedByDefault("rejected") === true', () => {
  assert.equal(isFeedbackCollapsedByDefault("rejected"), true);
});

test('isFeedbackCollapsedByDefault("failed") === false', () => {
  assert.equal(isFeedbackCollapsedByDefault("failed"), false);
});

test('isFeedbackCollapsedByDefault("pending") === false', () => {
  assert.equal(isFeedbackCollapsedByDefault("pending"), false);
});

// countActiveFeedbackStatuses
test("countActiveFeedbackStatuses returns correct queued, inProgress, failed counts", () => {
  const items: Pick<FeedbackItem, "status">[] = [
    { status: "queued" },
    { status: "queued" },
    { status: "in_progress" },
    { status: "failed" },
    { status: "resolved" },
    { status: "pending" },
    { status: "rejected" },
  ];
  const result = countActiveFeedbackStatuses(items as FeedbackItem[]);
  assert.equal(result.queued, 2);
  assert.equal(result.inProgress, 1);
  assert.equal(result.failed, 1);
});
