import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Collapsible from "@radix-ui/react-collapsible";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getRepoHref } from "@/lib/repoHref";
import type { Config, FeedbackItem, LogEntry, PR } from "@shared/schema";
import { toast } from "@/hooks/use-toast";
import {
  formatFeedbackStatusLabel,
  getFeedbackStatusBadgeClass,
  isFeedbackCollapsedByDefault,
  countActiveFeedbackStatuses,
} from "@/lib/feedbackStatus";

function formatClock(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

function formatStatusLabel(status: PR["status"]): string {
  if (status === "processing") {
    return "autonomous run active";
  }

  if (status === "done") {
    return "completed";
  }

  if (status === "error") {
    return "attention needed";
  }

  if (status === "archived") {
    return "archived";
  }

  return "watching";
}

function formatPollInterval(pollIntervalMs?: number): string {
  const seconds = Math.max(1, Math.round((pollIntervalMs ?? 120000) / 1000));
  return `${seconds}s`;
}

function StatusDot({ status }: { status: PR["status"] }) {
  const cls =
    status === "watching" ? "bg-foreground/30" :
    status === "processing" ? "bg-foreground animate-pulse" :
    status === "done" ? "bg-foreground" :
    status === "archived" ? "bg-foreground/15" :
    "bg-destructive";
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 ${cls}`} />;
}

function FeedbackStatusTag({ status }: { status: FeedbackItem["status"] }) {
  const cls = getFeedbackStatusBadgeClass(status);
  return (
    <span className={`inline-block border px-1.5 py-0 text-[11px] uppercase tracking-wide ${cls}`}>
      {formatFeedbackStatusLabel(status)}
    </span>
  );
}

function PRRow({ pr, isSelected, onSelect }: { pr: PR; isSelected: boolean; onSelect: () => void }) {
  const checkedAt = formatClock(pr.lastChecked);

  return (
    <div
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      data-testid={`pr-row-${pr.id}`}
      className={`w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        isSelected ? "bg-muted" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <StatusDot status={pr.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-muted-foreground">#{pr.number}</span>
            <span className="truncate">{pr.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.75rem] text-[11px] text-muted-foreground">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
            >
              {pr.repo}
            </a>
            <span>{formatStatusLabel(pr.status)}</span>
            {pr.feedbackItems.length > 0 && (() => {
              const counts = countActiveFeedbackStatuses(pr.feedbackItems);
              const parts: string[] = [];
              if (counts.queued > 0) parts.push(`${counts.queued}q`);
              if (counts.inProgress > 0) parts.push(`${counts.inProgress} active`);
              if (counts.failed > 0) parts.push(`${counts.failed} failed`);
              if (parts.length === 0) return <span>{pr.feedbackItems.length} items</span>;
              return <span>{parts.join(" · ")}</span>;
            })()}
            {checkedAt && <span>checked {checkedAt}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedbackRow({
  item,
  prId,
  readOnly,
}: {
  item: FeedbackItem;
  prId: string;
  readOnly?: boolean;
}) {
  const overrideMutation = useMutation({
    mutationFn: async (decision: string) => {
      const res = await apiRequest("PATCH", `/api/prs/${prId}/feedback/${item.id}`, { decision });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId] });
    },
  });

  const createdAt = formatClock(item.createdAt);
  const collapsedByDefault = isFeedbackCollapsedByDefault(item.status);

  return (
    <Collapsible.Root defaultOpen={!collapsedByDefault} className="border-b border-border">
      <div className="px-4 py-3">
        {/* Header row - always visible */}
        <div className="flex items-start gap-3">
          <div className="shrink-0 pt-0.5">
            <FeedbackStatusTag status={item.status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.author}</span>
              {item.file && (
                <span className="text-[11px] text-muted-foreground">
                  {item.file}{item.line ? `:${item.line}` : ""}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">{item.type.replace("_", " ")}</span>
              {createdAt && <span className="text-[11px] text-muted-foreground">{createdAt}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Collapsible.Trigger asChild>
              <button
                data-testid={`toggle-${item.id}`}
                className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background border border-border"
              >
                ↕
              </button>
            </Collapsible.Trigger>
            {!readOnly && ["accept", "reject", "flag"].map((decision) => (
              <button
                key={decision}
                onClick={() => overrideMutation.mutate(decision)}
                data-testid={`override-${decision}-${item.id}`}
                className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background ${
                  item.decision === decision ? "bg-foreground text-background" : "border border-border text-muted-foreground"
                }`}
              >
                {decision.charAt(0)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Collapsible.Content>
        <div className="px-4 pb-3">
          {item.bodyHtml ? (
            <div
              className="feedback-markdown text-[12px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: item.bodyHtml }}
            />
          ) : (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/80">{item.body}</p>
          )}
          {(item.statusReason || item.decisionReason) && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {item.statusReason || item.decisionReason}
            </p>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function LogPanel({ prId }: { prId: string | null }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { data: logs = [] } = useQuery<LogEntry[]>({
    queryKey: ["/api/logs", prId ?? "all"],
    queryFn: async () => {
      const url = prId ? `/api/logs?prId=${encodeURIComponent(prId)}` : "/api/logs";
      const res = await apiRequest("GET", url);
      return res.json();
    },
    refetchInterval: 1500,
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = scroller.scrollHeight;
  }, [logs.length, prId]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Activity
      </div>
      <div ref={scrollerRef} className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed">
        {logs.length === 0 ? (
          <span className="text-muted-foreground">No log entries.</span>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="border-b border-border/60 py-2 last:border-b-0" data-testid={`log-${log.id}`}>
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <span>{formatClock(log.timestamp)}</span>
                <span className={
                  log.level === "error" ? "text-destructive" :
                  log.level === "warn" ? "text-foreground/80" :
                  "text-foreground/55"
                }>
                  {log.level}
                </span>
                {log.phase && <span className="border border-border px-1 py-0">{log.phase}</span>}
                {log.runId && <span className="normal-case text-foreground/45">run {log.runId.slice(0, 8)}</span>}
              </div>
              <div className="mt-1 break-words text-foreground/75">{log.message}</div>
              {log.metadata && Object.keys(log.metadata).length > 0 && (
                <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                  {JSON.stringify(log.metadata, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const raw = error.message.replace(/^\d+:\s*/, "").trim();
  if (!raw) {
    return "Request failed";
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Keep the original message when the server did not return JSON.
  }

  return raw;
}

function showMutationError(title: string, error: unknown) {
  toast({
    variant: "destructive",
    title,
    description: getErrorMessage(error),
  });
}

export default function Dashboard() {
  const [selectedPRId, setSelectedPRId] = useState<string | null>(null);
  const [addUrl, setAddUrl] = useState("");
  const [addRepo, setAddRepo] = useState("");
  const [viewMode, setViewMode] = useState<"active" | "archived">("active");

  const { data: prs = [], isLoading } = useQuery<PR[]>({
    queryKey: ["/api/prs"],
    refetchInterval: 3000,
  });

  const { data: archivedPRs = [], isLoading: isLoadingArchived } = useQuery<PR[]>({
    queryKey: ["/api/prs/archived"],
    refetchInterval: 10000,
  });

  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
    refetchInterval: 5000,
  });

  const { data: repos = [] } = useQuery<string[]>({
    queryKey: ["/api/repos"],
    refetchInterval: 5000,
  });

  const displayedPRs = viewMode === "active" ? prs : archivedPRs;
  const isArchived = viewMode === "archived";

  useEffect(() => {
    if (displayedPRs.length === 0) {
      if (selectedPRId !== null) {
        setSelectedPRId(null);
      }
      return;
    }

    if (!selectedPRId || !displayedPRs.some((pr) => pr.id === selectedPRId)) {
      setSelectedPRId(displayedPRs[0].id);
    }
  }, [displayedPRs, selectedPRId]);

  const selectedPR = displayedPRs.find((pr) => pr.id === selectedPRId) ?? null;

  const addMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/prs", { url });
      return res.json();
    },
    onSuccess: (data: PR) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      setAddUrl("");
      setSelectedPRId(data.id);
    },
    onError: (error) => {
      showMutationError("Could not add PR", error);
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/prs/${id}/apply`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not run babysitter", error);
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
    },
    onError: (error) => {
      showMutationError("Could not update settings", error);
    },
  });

  const syncReposMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/repos/sync");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos"] });
    },
    onError: (error) => {
      showMutationError("Could not sync repositories", error);
    },
  });

  const addRepoMutation = useMutation({
    mutationFn: async (repo: string) => {
      const res = await apiRequest("POST", "/api/repos", { repo });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      setAddRepo("");
    },
    onError: (error) => {
      showMutationError("Could not watch repository", error);
    },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="PR Feedback Agent">
            <rect x="1" y="1" width="14" height="14" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 5h8M4 8h5M4 11h6" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span className="text-sm font-medium tracking-tight">code factory</span>
          <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            autonomous
          </span>
          <span className="text-[11px] text-muted-foreground">
            poll {formatPollInterval(config?.pollIntervalMs)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {prs.length} PR{prs.length !== 1 ? "s" : ""} in {repos.length} repo{repos.length !== 1 ? "s" : ""}
          </span>
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Agent</label>
          <select
            value={config?.codingAgent ?? "codex"}
            onChange={(e) =>
              updateConfigMutation.mutate({
                codingAgent: e.target.value as Config["codingAgent"],
              })
            }
            disabled={updateConfigMutation.isPending}
            data-testid="select-coding-agent"
            className="border border-border bg-transparent px-2 py-0.5 text-[11px] focus:border-foreground focus:outline-none disabled:opacity-50"
          >
            <option value="codex">codex</option>
            <option value="claude">claude</option>
          </select>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-80 shrink-0 flex-col border-r border-border">
          <div className="flex border-b border-border">
            <button
              onClick={() => setViewMode("active")}
              data-testid="tab-active"
              className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${
                viewMode === "active"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Active ({prs.length})
            </button>
            <button
              onClick={() => setViewMode("archived")}
              data-testid="tab-archived"
              className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${
                viewMode === "archived"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Archived ({archivedPRs.length})
            </button>
          </div>
          {!isArchived && (
            <>
              <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
                Add a PR or watch a repo. Sync and babysit start automatically.
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (addUrl.trim()) addMutation.mutate(addUrl.trim());
                }}
                className="border-b border-border p-3"
              >
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    placeholder="github.com/owner/repo/pull/123"
                    data-testid="input-add-pr"
                    className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-foreground focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={addMutation.isPending || !addUrl.trim()}
                    data-testid="button-add-pr"
                    className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
                  >
                    Add
                  </button>
                </div>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (addRepo.trim()) addRepoMutation.mutate(addRepo.trim());
                }}
                className="border-b border-border p-3"
              >
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={addRepo}
                    onChange={(e) => setAddRepo(e.target.value)}
                    placeholder="owner/repo"
                    data-testid="input-add-repo"
                    className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-foreground focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={addRepoMutation.isPending || !addRepo.trim()}
                    data-testid="button-add-repo"
                    className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
                  >
                    Watch
                  </button>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Tracked repositories
                    </span>
                    <button
                      type="button"
                      onClick={() => syncReposMutation.mutate()}
                      disabled={syncReposMutation.isPending}
                      data-testid="button-sync-repos"
                      className="border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
                    >
                      {syncReposMutation.isPending ? "Fetching…" : "Fetch"}
                    </button>
                  </div>
                  {repos.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground">No repositories being watched yet.</div>
                  ) : (
                    <div className="space-y-1 text-[12px]">
                      {repos.map((repo) => (
                        <a
                          key={repo}
                          href={getRepoHref(repo)}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`tracked-repo-${repo.replace("/", "-")}`}
                          className="block break-all text-foreground/75 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                        >
                          {repo}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </form>
            </>
          )}
          <div className="flex-1 overflow-y-auto">
            {(isArchived ? isLoadingArchived : isLoading) ? (
              <div className="p-4 text-[12px] text-muted-foreground">Loading...</div>
            ) : displayedPRs.length === 0 ? (
              <div className="p-4 text-[12px] text-muted-foreground">
                {isArchived
                  ? "No archived PRs. Closed PRs are archived automatically."
                  : "No PRs tracked yet. Add a repository to watch or add a PR URL."}
              </div>
            ) : (
              displayedPRs.map((pr) => (
                <PRRow
                  key={pr.id}
                  pr={pr}
                  isSelected={pr.id === selectedPRId}
                  onSelect={() => setSelectedPRId(pr.id)}
                />
              ))
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedPR ? (
            <>
              <div className="shrink-0 border-b border-border px-4 py-3">
                <div className="mb-1 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot status={selectedPR.status} />
                      <span className="truncate font-medium">{selectedPR.title}</span>
                      <a
                        href={selectedPR.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                      >
                        {selectedPR.repo}#{selectedPR.number}
                      </a>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>status: {formatStatusLabel(selectedPR.status)}</span>
                      <span>{selectedPR.feedbackItems.length} items</span>
                      {selectedPR.feedbackItems.length > 0 && (() => {
                        const counts = countActiveFeedbackStatuses(selectedPR.feedbackItems);
                        return (
                          <>
                            {counts.queued > 0 && <span>{counts.queued} queued</span>}
                            {counts.inProgress > 0 && <span>{counts.inProgress} in progress</span>}
                            {counts.failed > 0 && <span>{counts.failed} failed</span>}
                          </>
                        );
                      })()}
                      {selectedPR.testsPassed !== null && (
                        <span>tests: {selectedPR.testsPassed ? "pass" : "fail"}</span>
                      )}
                      {selectedPR.lintPassed !== null && (
                        <span>lint: {selectedPR.lintPassed ? "pass" : "fail"}</span>
                      )}
                      {selectedPR.lastChecked && <span>checked {formatClock(selectedPR.lastChecked)}</span>}
                    </div>
                  </div>
                  {!isArchived && (
                    <button
                      onClick={() => applyMutation.mutate(selectedPR.id)}
                      disabled={applyMutation.isPending || selectedPR.status === "processing"}
                      data-testid="button-apply"
                      className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
                    >
                      {selectedPR.status === "processing" ? "Running" : "Run now"}
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Background watcher syncs GitHub feedback and pushes approved fixes automatically.
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {selectedPR.feedbackItems.length === 0 ? (
                  <div className="p-4 text-[12px] text-muted-foreground">
                    No feedback yet. The watcher will sync GitHub comments automatically.
                  </div>
                ) : (
                  selectedPR.feedbackItems.map((item) => (
                    <FeedbackRow key={item.id} item={item} prId={selectedPR.id} readOnly={isArchived} />
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Select a PR from the left panel.
            </div>
          )}
        </div>

        <div className="w-80 shrink-0 border-l border-border">
          <LogPanel prId={selectedPRId} />
        </div>
      </div>
    </div>
  );
}
