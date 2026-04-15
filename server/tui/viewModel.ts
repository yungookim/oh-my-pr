import type { FeedbackItem, FeedbackStatus, PR } from "@shared/schema";

export type LayoutMode = "full" | "stacked" | "compact-warning";

export function formatStatusLabel(status: PR["status"]): string {
  if (status === "processing") {
    return "running";
  }

  if (status === "done") {
    return "done";
  }

  if (status === "error") {
    return "needs attention";
  }

  if (status === "archived") {
    return "archived";
  }

  return "watching";
}

export function formatFeedbackStatusLabel(status: FeedbackStatus): string {
  return status.replace("_", " ").toUpperCase();
}

export function countActiveFeedbackStatuses(items: FeedbackItem[]): {
  queued: number;
  inProgress: number;
  failed: number;
  warning: number;
} {
  return items.reduce(
    (counts, item) => {
      if (item.status === "queued") {
        counts.queued += 1;
      } else if (item.status === "in_progress") {
        counts.inProgress += 1;
      } else if (item.status === "failed") {
        counts.failed += 1;
      } else if (item.status === "warning") {
        counts.warning += 1;
      }

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

export function isTerminalFeedbackStatus(status: FeedbackStatus): boolean {
  return status === "resolved" || status === "rejected";
}

export function isPRReadyToMerge(items: FeedbackItem[]): boolean {
  if (items.length === 0) {
    return false;
  }

  return items.every((item) => isTerminalFeedbackStatus(item.status));
}

export function getLayoutMode(width: number): LayoutMode {
  if (width >= 150) {
    return "full";
  }

  if (width >= 110) {
    return "stacked";
  }

  return "compact-warning";
}

export function formatPrRow(pr: PR): string {
  const parts = [
    `#${pr.number}`,
    pr.title,
    formatStatusLabel(pr.status),
  ];

  if (!pr.watchEnabled) {
    parts.push("watch paused");
  }

  const counts = countActiveFeedbackStatuses(pr.feedbackItems);
  if (counts.queued > 0) {
    parts.push(`${counts.queued}q`);
  }
  if (counts.inProgress > 0) {
    parts.push(`${counts.inProgress} active`);
  }
  if (counts.failed > 0) {
    parts.push(`${counts.failed} failed`);
  }
  if (counts.warning > 0) {
    parts.push(`${counts.warning} warn`);
  }

  if (isPRReadyToMerge(pr.feedbackItems) && pr.status !== "processing") {
    parts.push("ready");
  }

  return parts.join(" · ");
}

export function getFeedbackActions(item: FeedbackItem): string[] {
  const actions = ["Accept", "Reject", "Flag"];

  if (item.status === "failed" || item.status === "warning") {
    actions.push("Retry");
  }

  return actions;
}

export function wrapText(input: string, width: number): string[] {
  if (width <= 4) {
    return [input];
  }

  const words = input.replace(/\s+/g, " ").trim().split(" ");
  if (words.length === 1 && words[0] === "") {
    return [""];
  }

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

export function formatFooterHints(contextMode: "logs" | "ask" | "repos" | "settings"): string {
  return `Tab pane • arrows move • Enter select • r run • w watch • l logs • a ask • o repos • s settings • q quit • pane=${contextMode}`;
}
