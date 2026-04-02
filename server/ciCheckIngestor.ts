import type { CheckSnapshot } from "@shared/schema";
import { createCheckSnapshot } from "@shared/models";

export type GitHubCommitStatus = {
  context?: string | null;
  description?: string | null;
  state?: string | null;
  target_url?: string | null;
  updated_at?: string | null;
};

export type GitHubCheckRun = {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
  } | null;
};

function pickObservedAt(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) {
      return candidate;
    }
  }

  return new Date().toISOString();
}

function normalizeDescription(description: string | null | undefined, fallback: string): string {
  const trimmed = description?.trim();
  return trimmed || fallback;
}

export function normalizeCommitStatusSnapshot(params: {
  prId: string;
  sha: string;
  status: GitHubCommitStatus;
}): CheckSnapshot {
  const { prId, sha, status } = params;
  return createCheckSnapshot({
    prId,
    sha,
    provider: "github.commit_status",
    context: status.context?.trim() || "status-check",
    status: status.state?.trim() || "unknown",
    conclusion: null,
    description: normalizeDescription(status.description, "Commit status"),
    targetUrl: status.target_url?.trim() || null,
    observedAt: pickObservedAt(status.updated_at),
  });
}

export function normalizeCheckRunSnapshot(params: {
  prId: string;
  sha: string;
  run: GitHubCheckRun;
}): CheckSnapshot {
  const { prId, sha, run } = params;
  const conclusion = run.conclusion?.trim() || null;
  const status = run.status?.trim() || "unknown";
  return createCheckSnapshot({
    prId,
    sha,
    provider: "github.check_run",
    context: run.name?.trim() || "check-run",
    status,
    conclusion,
    description: normalizeDescription(
      run.output?.summary ?? run.output?.title,
      conclusion ? `Check run ${conclusion}` : "Check run",
    ),
    targetUrl: run.html_url?.trim() || null,
    observedAt: pickObservedAt(run.updated_at, run.completed_at, run.started_at),
  });
}

export function normalizeCheckSnapshotsFromRef(params: {
  prId: string;
  sha: string;
  statuses: GitHubCommitStatus[];
  checkRuns: GitHubCheckRun[];
}): CheckSnapshot[] {
  const { prId, sha, statuses, checkRuns } = params;
  return [
    ...statuses.map((status) => normalizeCommitStatusSnapshot({ prId, sha, status })),
    ...checkRuns.map((run) => normalizeCheckRunSnapshot({ prId, sha, run })),
  ];
}

export function isFailingCheckSnapshot(snapshot: CheckSnapshot): boolean {
  if (snapshot.provider === "github.commit_status") {
    return snapshot.status === "failure" || snapshot.status === "error";
  }

  if (snapshot.provider === "github.check_run") {
    return snapshot.status === "completed"
      && (snapshot.conclusion === "failure" || snapshot.conclusion === "timed_out" || snapshot.conclusion === "cancelled");
  }

  return false;
}
