import type { CheckSnapshot, HealingClassification } from "@shared/schema";

export type ClassifiedCIFailure = {
  fingerprint: string;
  category: string;
  classification: HealingClassification;
  summary: string;
  selectedEvidence: string[];
};

const HEALABLE_KEYWORDS = [
  { category: "typescript", fingerprint: "typescript", pattern: /\b(tsc|typescript|type[- ]?check|typecheck)\b/i },
  { category: "lint", fingerprint: "lint", pattern: /\b(eslint|lint|prettier|format(?:ting)?)\b/i },
  { category: "tests", fingerprint: "tests", pattern: /\b(test(?:s)?|jest|vitest|mocha|ava|pytest|unit[- ]?tests?|integration[- ]?tests?)\b/i },
  { category: "build", fingerprint: "build", pattern: /\b(build|bundle|bundling|vite|webpack|rollup|esbuild)\b/i },
  { category: "npm-ci", fingerprint: "npm-ci", pattern: /\b(npm ci|package[- ]?lock|lockfile|yarn\.lock|pnpm-lock)\b/i },
  { category: "generated-artifacts", fingerprint: "generated-artifacts", pattern: /\b(generate(?:d|ion)?|codegen|artifact(?:s)?)\b/i },
];

const BLOCKED_KEYWORDS = [
  { category: "missing-secret", fingerprint: "missing-secret", pattern: /\b(secret|token|credential|auth|authorization|unauthorized|forbidden|permission|access denied)\b/i },
  { category: "external-outage", fingerprint: "external-outage", pattern: /\b(outage|unavailable|service unavailable|502|503|504|network error|dns|connection refused|rate limit|quota|api error)\b/i },
];

const FLAKY_KEYWORDS = [
  { category: "timeout", fingerprint: "timeout", pattern: /\b(timeout|timed[- ]?out|deadline[- ]?exceeded)\b/i },
  { category: "cancelled", fingerprint: "cancelled", pattern: /\b(cancelled|canceled|aborted)\b/i },
  { category: "flaky", fingerprint: "flaky", pattern: /\b(flaky|intermittent|transient|rerun|retry)\b/i },
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-");
}

function collapseFingerprintParts(parts: string[]): string {
  return parts
    .map((part) => normalizeText(part))
    .filter((part) => part.length > 0)
    .join(":");
}

function extractEvidence(snapshot: CheckSnapshot): string[] {
  const evidence = [snapshot.context, snapshot.description];
  if (snapshot.targetUrl) {
    evidence.push(snapshot.targetUrl);
  }
  return evidence.filter((value, index, array) => value.trim().length > 0 && array.indexOf(value) === index);
}

function pickMatch(text: string): { category: string; fingerprint: string } | null {
  for (const candidate of BLOCKED_KEYWORDS) {
    if (candidate.pattern.test(text)) {
      return { category: candidate.category, fingerprint: candidate.fingerprint };
    }
  }

  for (const candidate of FLAKY_KEYWORDS) {
    if (candidate.pattern.test(text)) {
      return { category: candidate.category, fingerprint: candidate.fingerprint };
    }
  }

  for (const candidate of HEALABLE_KEYWORDS) {
    if (candidate.pattern.test(text)) {
      return { category: candidate.category, fingerprint: candidate.fingerprint };
    }
  }

  return null;
}

function summarize(snapshot: CheckSnapshot, classification: HealingClassification): string {
  const headline = `${snapshot.context}: ${snapshot.description}`.trim();
  if (classification === "blocked_external") {
    return `External CI failure likely not fixable in-branch: ${headline}`;
  }

  if (classification === "flaky_or_ambiguous") {
    return `Flaky or ambiguous CI failure: ${headline}`;
  }

  if (classification === "healable_in_branch") {
    return `In-branch fix likely available: ${headline}`;
  }

  return `Unclassified CI failure: ${headline}`;
}

export function classifyCIFailure(snapshot: CheckSnapshot): ClassifiedCIFailure {
  const searchableText = normalizeText([
    snapshot.provider,
    snapshot.context,
    snapshot.status,
    snapshot.conclusion || "",
    snapshot.description,
    snapshot.targetUrl || "",
  ].join(" "));

  const match = pickMatch(searchableText);
  const classification: HealingClassification = match
    ? (
        HEALABLE_KEYWORDS.some((candidate) => candidate.fingerprint === match.fingerprint)
          ? "healable_in_branch"
          : BLOCKED_KEYWORDS.some((candidate) => candidate.fingerprint === match.fingerprint)
            ? "blocked_external"
            : "flaky_or_ambiguous"
      )
    : "unknown";

  const fingerprint = match
    ? collapseFingerprintParts([
        snapshot.provider,
        match.fingerprint,
        snapshot.context,
      ])
    : collapseFingerprintParts([
        snapshot.provider,
        "unknown",
        snapshot.context,
        snapshot.conclusion || snapshot.status,
      ]);

  const category = match?.category || "unknown";

  return {
    fingerprint,
    category,
    classification,
    summary: summarize(snapshot, classification),
    selectedEvidence: extractEvidence(snapshot),
  };
}

export function classifyCIFailures(snapshots: CheckSnapshot[]): ClassifiedCIFailure[] {
  const grouped = new Map<string, ClassifiedCIFailure>();

  for (const snapshot of snapshots) {
    const classified = classifyCIFailure(snapshot);
    const existing = grouped.get(classified.fingerprint);

    if (!existing) {
      grouped.set(classified.fingerprint, {
        ...classified,
        selectedEvidence: [...classified.selectedEvidence],
      });
      continue;
    }

    const mergedEvidence = new Set([...existing.selectedEvidence, ...classified.selectedEvidence]);
    const priority = (classification: HealingClassification): number => {
      if (classification === "healable_in_branch") return 3;
      if (classification === "blocked_external") return 2;
      if (classification === "flaky_or_ambiguous") return 1;
      return 0;
    };

    const winning = priority(classified.classification) > priority(existing.classification) ? classified : existing;
    grouped.set(classified.fingerprint, {
      ...winning,
      selectedEvidence: Array.from(mergedEvidence),
    });
  }

  return Array.from(grouped.values());
}
