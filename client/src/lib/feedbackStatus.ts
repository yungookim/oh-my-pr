import type { FeedbackItem, FeedbackStatus } from "@shared/schema";

export function formatFeedbackStatusLabel(status: FeedbackStatus): string {
  return status.replace("_", " ").toUpperCase();
}

export function getFeedbackStatusBadgeClass(status: FeedbackStatus): string {
  if (status === "in_progress") return "border-foreground text-foreground animate-pulse";
  if (status === "failed") return "border-destructive text-destructive";
  if (status === "warning") return "border-yellow-500 text-yellow-500";
  if (status === "resolved") return "border-foreground/20 text-muted-foreground";
  if (status === "rejected") return "border-foreground/20 text-muted-foreground line-through";
  if (status === "flagged") return "border-foreground/40 text-foreground/60";
  if (status === "queued") return "border-foreground text-foreground";
  return "border-foreground/30 text-foreground/60"; // pending
}

export function isFeedbackCollapsedByDefault(status: FeedbackStatus): boolean {
  return status === "resolved" || status === "rejected" || status === "warning";
}

export function countActiveFeedbackStatuses(items: FeedbackItem[]): {
  queued: number;
  inProgress: number;
  failed: number;
  warning: number;
} {
  return items.reduce(
    (counts, item) => {
      if (item.status === "queued") counts.queued += 1;
      else if (item.status === "in_progress") counts.inProgress += 1;
      else if (item.status === "failed") counts.failed += 1;
      else if (item.status === "warning") counts.warning += 1;
      return counts;
    },
    {
      queued: 0,
      inProgress: 0,
      failed: 0,
      warning: 0,
    },
  );
}
