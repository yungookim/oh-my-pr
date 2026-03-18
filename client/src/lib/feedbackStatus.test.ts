import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import {
  formatFeedbackStatusLabel,
  isFeedbackCollapsedByDefault,
  countActiveFeedbackStatuses,
  isPRReadyToMerge,
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

// isPRReadyToMerge
test("isPRReadyToMerge returns false for empty items", () => {
  assert.equal(isPRReadyToMerge([]), false);
});

test("isPRReadyToMerge returns true when all resolved or rejected", () => {
  const items: Pick<FeedbackItem, "status">[] = [
    { status: "resolved" },
    { status: "rejected" },
    { status: "resolved" },
  ];
  assert.equal(isPRReadyToMerge(items as FeedbackItem[]), true);
});

test("isPRReadyToMerge returns false when any item is pending", () => {
  const items: Pick<FeedbackItem, "status">[] = [
    { status: "resolved" },
    { status: "pending" },
  ];
  assert.equal(isPRReadyToMerge(items as FeedbackItem[]), false);
});

test("isPRReadyToMerge returns false when any item is in_progress", () => {
  const items: Pick<FeedbackItem, "status">[] = [
    { status: "resolved" },
    { status: "in_progress" },
  ];
  assert.equal(isPRReadyToMerge(items as FeedbackItem[]), false);
});

test("isPRReadyToMerge returns false when any item is failed", () => {
  const items: Pick<FeedbackItem, "status">[] = [
    { status: "resolved" },
    { status: "failed" },
  ];
  assert.equal(isPRReadyToMerge(items as FeedbackItem[]), false);
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
