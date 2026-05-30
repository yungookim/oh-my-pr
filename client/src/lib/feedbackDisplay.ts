import type { FeedbackItem, FeedbackStatus } from "@shared/schema";

export type FeedbackGroupKey = "attention" | "running" | "done";

export type FeedbackGroupSection = {
  key: FeedbackGroupKey;
  label: string;
  summary: string;
  defaultOpen: boolean;
  items: FeedbackItem[];
};

const STATUS_ORDER: FeedbackStatus[] = [
  "failed",
  "warning",
  "pending",
  "flagged",
  "in_progress",
  "queued",
  "resolved",
  "rejected",
];

const STATUS_LABELS: Record<FeedbackStatus, { singular: string; plural?: string }> = {
  pending: { singular: "pending", plural: "pending" },
  queued: { singular: "queued", plural: "queued" },
  in_progress: { singular: "running", plural: "running" },
  resolved: { singular: "resolved", plural: "resolved" },
  failed: { singular: "failed", plural: "failed" },
  warning: { singular: "warning" },
  rejected: { singular: "rejected", plural: "rejected" },
  flagged: { singular: "flagged", plural: "flagged" },
};

const GENERIC_REVIEW_LINES = new Set([
  "code review",
  "high",
  "medium",
  "low",
]);

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countByStatus(items: FeedbackItem[]): Record<FeedbackStatus, number> {
  return items.reduce((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, {
    pending: 0,
    queued: 0,
    in_progress: 0,
    resolved: 0,
    failed: 0,
    warning: 0,
    rejected: 0,
    flagged: 0,
  } satisfies Record<FeedbackStatus, number>);
}

function formatStatusParts(items: FeedbackItem[]): string {
  const counts = countByStatus(items);
  const parts = STATUS_ORDER
    .filter((status) => counts[status] > 0)
    .map((status) => {
      const label = STATUS_LABELS[status];
      return pluralize(counts[status], label.singular, label.plural);
    });

  return parts.join(" · ");
}

function cleanPreviewLine(line: string): string {
  return line
    .replace(/<img\b[^>]*\balt=(["'])(.*?)\1[^>]*>/gi, " $2 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#]/g, "")
    .replace(/^\s*[-+*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getFeedbackPreview(item: Pick<FeedbackItem, "body">, maxLength = 150): string {
  const source = item.body
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+/)
    .map(cleanPreviewLine)
    .find((line) => line.length > 0 && !GENERIC_REVIEW_LINES.has(line.toLowerCase()));

  if (!source) {
    return "No comment body";
  }

  if (source.length <= maxLength) {
    return source;
  }

  return `${source.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function feedbackGroupForStatus(status: FeedbackStatus): FeedbackGroupKey {
  if (status === "queued" || status === "in_progress") {
    return "running";
  }

  if (status === "resolved" || status === "rejected") {
    return "done";
  }

  return "attention";
}

export function getFeedbackGroupSections(items: FeedbackItem[]): FeedbackGroupSection[] {
  const grouped: Record<FeedbackGroupKey, FeedbackItem[]> = {
    attention: [],
    running: [],
    done: [],
  };

  for (const item of items) {
    grouped[feedbackGroupForStatus(item.status)].push(item);
  }

  return [
    {
      key: "attention" as const,
      label: "Needs attention",
      summary: formatStatusParts(grouped.attention),
      defaultOpen: true,
      items: grouped.attention,
    },
    {
      key: "running" as const,
      label: "Running",
      summary: formatStatusParts(grouped.running),
      defaultOpen: true,
      items: grouped.running,
    },
    {
      key: "done" as const,
      label: "Done",
      summary: formatStatusParts(grouped.done),
      defaultOpen: false,
      items: grouped.done,
    },
  ].filter((section) => section.items.length > 0);
}

export function formatFeedbackOverview(items: FeedbackItem[]): string {
  if (items.length === 0) {
    return "no feedback";
  }

  const sections = getFeedbackGroupSections(items);
  const parts = sections.map((section) => {
    if (section.key === "attention") {
      return section.summary || pluralize(section.items.length, "attention item");
    }

    if (section.key === "running") {
      return pluralize(section.items.length, "running", "running");
    }

    return pluralize(section.items.length, "done", "done");
  });

  return parts.join(" · ");
}
