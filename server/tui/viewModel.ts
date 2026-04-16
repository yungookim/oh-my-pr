import type { FeedbackItem, FeedbackStatus, PR } from "@shared/schema";
import stringWidth from "string-width";

export type LayoutMode = "full" | "stacked" | "compact-warning";
export type ViewportRange = {
  start: number;
  end: number;
  hiddenAbove: number;
  hiddenBelow: number;
};

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

export function getDisplayWidth(input: string): number {
  return stringWidth(input);
}

function takeDisplayWidth(input: string, max: number): string {
  if (max <= 0 || !input) {
    return "";
  }

  let output = "";
  let width = 0;

  for (const char of input) {
    const charWidth = getDisplayWidth(char);
    if (width + charWidth > max) {
      break;
    }

    output += char;
    width += charWidth;
  }

  return output;
}

function takeDisplayWidthFromEnd(input: string, max: number): string {
  if (max <= 0 || !input) {
    return "";
  }

  const chars = Array.from(input);
  let output = "";
  let width = 0;

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const charWidth = getDisplayWidth(char);
    if (width + charWidth > max) {
      break;
    }

    output = `${char}${output}`;
    width += charWidth;
  }

  return output;
}

export function truncateText(input: string, max: number): string {
  if (max <= 0) {
    return "";
  }

  if (max === 1) {
    return takeDisplayWidth(input, 1);
  }

  if (getDisplayWidth(input) <= max) {
    return input;
  }

  const head = takeDisplayWidth(input, Math.max(1, max - 1));
  return `${head}…`;
}

export function middleTruncateText(input: string, max: number): string {
  if (max <= 0) {
    return "";
  }

  if (max === 1) {
    return "…";
  }

  if (getDisplayWidth(input) <= max) {
    return input;
  }

  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${takeDisplayWidth(input, head)}…${takeDisplayWidthFromEnd(input, tail)}`;
}

export function padDisplayText(input: string, width: number): string {
  const fitted = truncateText(input, width);
  return `${fitted}${" ".repeat(Math.max(0, width - getDisplayWidth(fitted)))}`;
}

export function getViewportRange(count: number, selectedIndex: number, visibleCount: number): ViewportRange {
  if (count <= 0 || visibleCount <= 0) {
    return {
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    };
  }

  const clampedVisibleCount = Math.min(count, visibleCount);
  const clampedSelectedIndex = Math.max(0, Math.min(selectedIndex, count - 1));
  const half = Math.floor(clampedVisibleCount / 2);
  let start = Math.max(0, clampedSelectedIndex - half);
  const maxStart = Math.max(0, count - clampedVisibleCount);

  if (start > maxStart) {
    start = maxStart;
  }

  const end = Math.min(count, start + clampedVisibleCount);
  return {
    start,
    end,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, count - end),
  };
}

export function wrapText(input: string, width: number): string[] {
  if (width < 1) {
    return input ? [input] : [""];
  }

  const normalized = input.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  const lines: string[] = [];

  for (const rawLine of rawLines) {
    const collapsed = rawLine.replace(/\s+/g, " ").trim();
    if (!collapsed) {
      lines.push("");
      continue;
    }

    const words = collapsed.split(" ");
    let current = "";

    const pushWord = (word: string) => {
      if (getDisplayWidth(word) <= width) {
        return [word];
      }

      const chunks: string[] = [];
      let remaining = word;
      while (remaining) {
        let chunk = takeDisplayWidth(remaining, width);
        if (!chunk) {
          // Width is too small to fit the first grapheme; consume it anyway
          // so the loop always makes progress.
          chunk = Array.from(remaining)[0]!;
        }
        chunks.push(chunk);
        remaining = remaining.slice(chunk.length);
      }

      return chunks;
    };

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (getDisplayWidth(candidate) <= width) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
      }

      const chunks = pushWord(word);
      for (let index = 0; index < chunks.length - 1; index += 1) {
        lines.push(chunks[index]!);
      }
      current = chunks[chunks.length - 1] ?? "";
    }

    if (current) {
      lines.push(current);
    }
  }

  if (lines.length === 0) {
    return [""];
  }

  return lines;
}

export function formatFooterHints(contextMode: "logs" | "ask" | "repos" | "settings"): string {
  return `Tab pane • arrows move • Enter select • r run • w watch • l logs • a ask • o repos • s settings • q quit • pane=${contextMode}`;
}

export type FooterHint = { key: string; label: string };

export function getFooterHints(): FooterHint[] {
  return [
    { key: "Tab", label: "pane" },
    { key: "↑↓", label: "move" },
    { key: "⏎", label: "select" },
    { key: "r", label: "run" },
    { key: "w", label: "watch" },
    { key: "l", label: "logs" },
    { key: "a", label: "ask" },
    { key: "o", label: "repos" },
    { key: "s", label: "settings" },
    { key: "q", label: "quit" },
  ];
}
