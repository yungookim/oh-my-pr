import type { FeedbackItem } from "@shared/schema";

export function applyManualDecision(
  item: FeedbackItem,
  decision: "accept" | "reject" | "flag",
): FeedbackItem {
  const statusMap = {
    accept: "queued",
    reject: "rejected",
    flag: "flagged",
  } as const;

  return {
    ...item,
    decision,
    status: statusMap[decision],
    statusReason: "Manual override",
  };
}

export function applyEvaluationDecision(
  item: FeedbackItem,
  needsFix: boolean,
  reason: string,
): FeedbackItem {
  if (needsFix) {
    return {
      ...item,
      decision: "accept",
      status: "queued",
      statusReason: reason,
    };
  }

  return {
    ...item,
    decision: "reject",
    status: "rejected",
    statusReason: reason,
  };
}

export function applyFlagDecision(item: FeedbackItem, reason: string): FeedbackItem {
  return { ...item, decision: "flag", status: "flagged", statusReason: reason };
}

export function markInProgress(item: FeedbackItem): FeedbackItem {
  return {
    ...item,
    status: "in_progress",
  };
}

export function markResolved(item: FeedbackItem): FeedbackItem {
  return {
    ...item,
    status: "resolved",
  };
}

export function markFailed(item: FeedbackItem, reason: string): FeedbackItem {
  return {
    ...item,
    status: "failed",
    statusReason: reason,
  };
}

export function markWarning(item: FeedbackItem, reason: string): FeedbackItem {
  return {
    ...item,
    status: "warning",
    statusReason: reason,
  };
}

export function markRetry(item: FeedbackItem): FeedbackItem {
  return {
    ...item,
    status: "queued",
    statusReason: "Queued for retry",
  };
}
