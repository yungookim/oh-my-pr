import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import type { ReleaseRun } from "@shared/schema";

type ReleaseRunStatus = ReleaseRun["status"];

const ACTIVE_RELEASE_STATUSES = new Set<ReleaseRun["status"]>([
  "detected",
  "evaluating",
  "proposed",
  "publishing",
]);

function isActiveStatus(status: ReleaseRunStatus): boolean {
  return ACTIVE_RELEASE_STATUSES.has(status);
}

function isTerminalStatus(status: ReleaseRunStatus): boolean {
  return status === "published" || status === "skipped" || status === "error";
}

function hasReleaseRunStatus(value: unknown): value is { status: ReleaseRunStatus } {
  return typeof value === "object" && value !== null && "status" in value && typeof value.status === "string";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "n/a";
  return sha.slice(0, 7);
}

function StatusBadge({ status }: { status: ReleaseRunStatus }) {
  const cls = status === "published"
    ? "border-foreground/40 text-foreground"
    : status === "skipped"
      ? "border-border text-muted-foreground"
      : status === "error"
        ? "border-destructive/40 text-destructive"
        : isActiveStatus(status)
          ? "border-border text-muted-foreground animate-pulse"
          : "border-border text-muted-foreground";

  return (
    <span className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Clipboard write failed";
      toast({ variant: "destructive", description: `Failed to copy: ${message}` });
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="border border-border px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:border-foreground hover:text-foreground"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function ReleaseRunCard({
  run,
  onRetry,
  retryPending,
}: {
  run: ReleaseRun;
  onRetry: (id: string) => void;
  retryPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    Boolean(run.decisionReason) ||
    Boolean(run.releaseTitle) ||
    Boolean(run.releaseNotes) ||
    Boolean(run.error) ||
    Boolean(run.githubReleaseUrl) ||
    run.includedPrs.length > 0;
  const shouldShowEmptyDetails =
    !hasDetails
    && isTerminalStatus(run.status);

  return (
    <div className="border border-border">
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex min-w-0 items-center gap-3">
          <StatusBadge status={run.status} />
          <span className="truncate text-sm font-medium">{run.repo}</span>
          <span className="text-[11px] text-muted-foreground">#{run.triggerPrNumber}</span>
          {run.proposedVersion && (
            <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
              {run.proposedVersion}
            </span>
          )}
          {!run.proposedVersion && run.recommendedBump && (
            <span className="text-[11px] text-muted-foreground">
              bump {run.recommendedBump}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{formatDateTime(run.createdAt)}</span>
          <span>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="mb-3 text-[12px] text-muted-foreground">
            Trigger PR:{" "}
            <a href={run.triggerPrUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              #{run.triggerPrNumber} {run.triggerPrTitle}
            </a>
          </div>

          {run.decisionReason && (
            <p className="mb-3 text-[12px] leading-relaxed">{run.decisionReason}</p>
          )}

          {run.releaseTitle && (
            <p className="mb-3 text-[12px]">
              <span className="text-muted-foreground">Release title:</span>{" "}
              <span>{run.releaseTitle}</span>
            </p>
          )}

          <div className="mb-3 grid grid-cols-1 gap-2 text-[12px] text-muted-foreground md:grid-cols-2">
            <div>Base branch: {run.baseBranch || "n/a"}</div>
            <div>Trigger SHA: {shortSha(run.triggerMergeSha)}</div>
            <div>Merged at: {formatDateTime(run.triggerMergedAt)}</div>
            <div>Updated: {formatDateTime(run.updatedAt)}</div>
          </div>

          {run.includedPrs.length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                Included PRs ({run.includedPrs.length})
              </div>
              <div className="space-y-1 border border-border p-3 text-[12px]">
                {run.includedPrs.map((pr) => (
                  <div key={`${pr.mergeSha}-${pr.number}`} className="flex items-center justify-between gap-3">
                    <span className="truncate">
                      #{pr.number} {pr.title}
                    </span>
                    <a href={pr.url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-foreground">
                      open
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {run.releaseNotes && (
            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Release Notes</span>
                <CopyButton text={run.releaseNotes} />
              </div>
              <pre className="whitespace-pre-wrap border border-border bg-background p-3 text-[12px] leading-relaxed font-mono">
                {run.releaseNotes}
              </pre>
            </div>
          )}

          {run.error && (
            <div className="mb-3 border border-destructive/40 bg-destructive/5 p-3 text-[12px] text-destructive">
              {run.error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {run.githubReleaseUrl && (
              <a
                href={run.githubReleaseUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                open release
              </a>
            )}
            {run.status === "error" && (
              <button
                onClick={() => onRetry(run.id)}
                disabled={retryPending}
                className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                retry
              </button>
            )}
          </div>

          {shouldShowEmptyDetails && (
            <p className="mt-2 text-[12px] text-muted-foreground">No details available yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Releases() {
  const { data: releases = [], isLoading } = useQuery<ReleaseRun[]>({
    queryKey: ["/api/releases"],
    refetchInterval: (query) => {
      const data = query.state.data;
      return Array.isArray(data) && data.some((run) => hasReleaseRunStatus(run) && isActiveStatus(run.status))
        ? 5000
        : false;
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/releases/${id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/releases"] });
      toast({ description: "Retry queued." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Retry failed: ${error.message}` });
    },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <UpdateBanner />
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Release Management">
            <rect x="1" y="1" width="14" height="14" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 6h8M4 9h8M4 12h5" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span className="text-sm font-medium tracking-tight">code factory</span>
          <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            releases
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="text-[11px] text-muted-foreground hover:text-foreground focus:outline-none"
          >
            settings
          </Link>
          <Link
            href="/"
            className="text-[11px] text-muted-foreground hover:text-foreground focus:outline-none"
          >
            ← back to dashboard
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-5">
            <h1 className="text-base font-medium">Release Management</h1>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Every merged PR can trigger agent evaluation. This page shows release decisions, version bumps, notes, and publishing outcomes.
            </p>
          </div>

          {isLoading && (
            <div className="border border-border px-4 py-6 text-center">
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            </div>
          )}

          {!isLoading && releases.length === 0 && (
            <div className="border border-border px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">No release runs yet.</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Runs appear after merged PRs are evaluated for release-worthiness.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {releases.map((run) => (
              <ReleaseRunCard
                key={run.id}
                run={run}
                onRetry={(id) => retryMutation.mutate(id)}
                retryPending={retryMutation.isPending}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
