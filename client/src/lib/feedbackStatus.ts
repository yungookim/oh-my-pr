import type { FeedbackItem, FeedbackStatus } from "@shared/schema";

export function formatFeedbackStatusLabel(status: FeedbackStatus): string {
  return status.replace("_", " ").toUpperCase();
}

export function getFeedbackStatusBadgeClass(status: FeedbackStatus): string {
  if (status === "in_progress") return "border-foreground text-foreground animate-pulse";
  if (status === "failed") return "border-destructive text-destructive";
  if (status === "resolved") return "border-foreground/20 text-muted-foreground";
  if (status === "rejected") return "border-foreground/20 text-muted-foreground line-through";
  if (status === "flagged") return "border-foreground/40 text-foreground/60";
  if (status === "queued") return "border-foreground text-foreground";
  return "border-foreground/30 text-foreground/60"; // pending
}

export function isFeedbackCollapsedByDefault(status: FeedbackStatus): boolean {
  return status === "resolved" || status === "rejected";
}

export function countActiveFeedbackStatuses(items: FeedbackItem[]): {
  queued: number;
  inProgress: number;
  failed: number;
} {
  return {
    queued: items.filter((i) => i.status === "queued").length,
    inProgress: items.filter((i) => i.status === "in_progress").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}
