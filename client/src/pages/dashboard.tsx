import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Collapsible from "@radix-ui/react-collapsible";
import { queryClient, apiRequest, fetchJson } from "@/lib/queryClient";
import { getRepoHref } from "@/lib/repoHref";
import type { Config, FeedbackItem, HealingSession, LogEntry, PR, PRQuestion, WatchedRepo } from "@shared/schema";
import { OnboardingPanel } from "@/components/OnboardingPanel";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import {
  formatFeedbackStatusLabel,
  getFeedbackStatusBadgeClass,
  isFeedbackCollapsedByDefault,
  countActiveFeedbackStatuses,
  isPRReadyToMerge,
} from "@/lib/feedbackStatus";
import {
  getHealingSessionView,
  selectRelevantHealingSession,
} from "@/lib/ciHealing";

function formatClock(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

function isPRWatchEnabled(pr: PR): boolean {
  return pr.watchEnabled;
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

const HEALING_TONE_CLASSES: Record<"neutral" | "info" | "warning" | "success" | "danger", string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-foreground text-foreground",
  warning: "border-yellow-600 text-yellow-600",
  success: "border-green-600 text-green-600",
  danger: "border-destructive text-destructive",
};

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

function WatchPausedIndicator() {
  return (
    <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
      watch paused
    </span>
  );
}

function ReadyToMergeIndicator({
  href,
  testId,
  label,
  hint,
  className,
  dotClassName,
  hintClassName,
  onClick,
}: {
  href: string;
  testId: string;
  label: string;
  hint?: string;
  className: string;
  dotClassName: string;
  hintClassName?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center border border-green-600 bg-green-600/10 font-medium uppercase text-green-500 transition-colors hover:bg-green-600/20 ${className}`}
    >
      <span className={`inline-block rounded-full bg-green-500 ${dotClassName}`} />
      {label}
      {hint && <span className={hintClassName}>{hint}</span>}
    </a>
  );
}

function AgentIndicator({ pr }: { pr: PR }) {
  const agentCount = countActiveFeedbackStatuses(pr.feedbackItems).inProgress;
  const isProcessing = pr.status === "processing";

  if (!isProcessing && agentCount === 0) {
    return null;
  }

  const label = agentCount > 0
    ? `${agentCount} agent${agentCount !== 1 ? "s" : ""} running on this PR`
    : "Agent run active on this PR";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-default items-center gap-0.5 text-[12px]"
          data-testid={`agent-indicator-${pr.id}`}
        >
          <span className="animate-pulse">🤖</span>
          {agentCount > 0 && (
            <span className="text-[10px] text-muted-foreground">{agentCount}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function PRRow({ pr, isSelected, onSelect }: { pr: PR; isSelected: boolean; onSelect: () => void }) {
  const checkedAt = formatClock(pr.lastChecked);
  const watchEnabled = isPRWatchEnabled(pr);
  const agentActive = pr.status === "processing" || countActiveFeedbackStatuses(pr.feedbackItems).inProgress > 0;
  const readyToMerge = !agentActive && isPRReadyToMerge(pr.feedbackItems);

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
            <AgentIndicator pr={pr} />
          </div>
          {readyToMerge && (
            <ReadyToMergeIndicator
              href={pr.url}
              testId={`ready-to-merge-${pr.id}`}
              label="Ready to merge"
              hint="— click to open PR"
              onClick={(event) => event.stopPropagation()}
              className="mt-1.5 ml-[3.75rem] gap-1.5 px-2 py-0.5 text-[11px] tracking-wider"
              dotClassName="h-1.5 w-1.5"
              hintClassName="text-[10px] normal-case tracking-normal text-green-500/70"
            />
          )}
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
            {!watchEnabled && <WatchPausedIndicator />}
            {pr.feedbackItems.length > 0 && (() => {
              const counts = countActiveFeedbackStatuses(pr.feedbackItems);
              const parts: string[] = [];
              if (counts.queued > 0) parts.push(`${counts.queued}q`);
              if (counts.inProgress > 0) parts.push(`${counts.inProgress} active`);
              if (counts.failed > 0) parts.push(`${counts.failed} failed`);
              if (counts.warning > 0) parts.push(`${counts.warning} warn`);
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

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prs/${prId}/feedback/${item.id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not retry feedback item", error);
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
            {!readOnly && (item.status === "failed" || item.status === "warning") && (
              <button
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
                data-testid={`retry-${item.id}`}
                className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background border border-border text-muted-foreground disabled:opacity-30"
              >
                R
              </button>
            )}
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

function HealingPanel({
  pr,
  config,
  healingSessions,
}: {
  pr: PR;
  config: Config | undefined;
  healingSessions: HealingSession[];
}) {
  const session = selectRelevantHealingSession(healingSessions, pr.id);
  const view = session ? getHealingSessionView(session, config) : null;
  const toneClass = view ? HEALING_TONE_CLASSES[view.tone] : HEALING_TONE_CLASSES.neutral;

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="panel-ci-healing"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">CI healing</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {view ? (
              <>
                <span className={`inline-flex border px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${toneClass}`}>
                  {view.stateLabel}
                </span>
                <span className="text-[11px] text-muted-foreground">{view.attemptSummary}</span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {config?.autoHealCI === false
                  ? "Automatic CI healing is disabled in settings."
                  : "No healing session yet for this PR."}
              </span>
            )}
          </div>
        </div>
        {session && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            head {session.currentHeadSha.slice(0, 7)}
          </span>
        )}
      </div>

      {view ? (
        <>
          <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
            {view.reasonSummary && <div>Reason: {view.reasonSummary}</div>}
            <div>{view.statusHint}</div>
            <div>
              Attempts: {view.attemptSummary}
              {session?.latestFingerprint ? ` · fingerprint ${session.latestFingerprint}` : ""}
            </div>
          </div>
          {view.actions.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {view.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    disabled
                    title={action.hint}
                    className={`border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                      action.available
                        ? "border-border text-foreground/70 hover:bg-muted"
                        : "border-border text-muted-foreground/60"
                    } disabled:opacity-100`}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Operator controls are read-only until healing action endpoints are added.
              </div>
            </>
          )}
        </>
      ) : (
        config?.autoHealCI !== false && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            The watcher will create a healing session when a failing check is classified as healable.
          </div>
        )
      )}
    </div>
  );
}

function RightPanel({ prId }: { prId: string | null }) {
  const [tab, setTab] = useState<"activity" | "ask">("ask");

  return (
    <div className="w-80 shrink-0 border-l border-border flex flex-col">
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab("ask")}
          data-testid="tab-ask"
          className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${
            tab === "ask"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Ask Agent
        </button>
        <button
          onClick={() => setTab("activity")}
          data-testid="tab-activity"
          className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${
            tab === "activity"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Activity
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === "activity" ? (
          <LogPanel prId={prId} />
        ) : prId ? (
          <QAPanel prId={prId} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            Select a PR to ask questions.
          </div>
        )}
      </div>
    </div>
  );
}

function QAPanel({ prId }: { prId: string }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: questions = [] } = useQuery<PRQuestion[]>({
    queryKey: ["/api/prs", prId, "questions"],
    refetchInterval: 2000,
  });

  const askMutation = useMutation({
    mutationFn: (question: string) =>
      apiRequest("POST", `/api/prs/${prId}/questions`, { question }).then((res) => res.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId, "questions"] });
      setInput("");
    },
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [questions.length, questions[questions.length - 1]?.status]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Ask Agent
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {questions.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">
            Ask questions about this PR — the agent will read activity logs, feedback, and status to answer.
          </span>
        ) : (
          questions.map((q) => (
            <div key={q.id} className="space-y-1.5" data-testid={`question-${q.id}`}>
              <div className="text-[12px]">
                <span className="font-medium text-foreground/90">Q: </span>
                <span className="text-foreground/80">{q.question}</span>
              </div>
              {q.status === "pending" || q.status === "answering" ? (
                <div className="text-[11px] text-muted-foreground animate-pulse">
                  Agent is thinking...
                </div>
              ) : q.status === "error" ? (
                <div className="text-[11px] text-destructive">
                  Error: {q.error || "Unknown error"}
                </div>
              ) : (
                <div className="text-[12px] leading-relaxed text-foreground/75 whitespace-pre-wrap border-l-2 border-border pl-3">
                  {q.answer}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground">
                {formatClock(q.createdAt)}
                {q.answeredAt && ` — answered ${formatClock(q.answeredAt)}`}
              </div>
            </div>
          ))
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !askMutation.isPending) askMutation.mutate(input.trim());
        }}
        className="border-t border-border p-3"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Was the review done? Why did this fail?"
            data-testid="input-question"
            className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-foreground focus:outline-none"
          />
          <button
            type="submit"
            disabled={askMutation.isPending || !input.trim()}
            data-testid="button-ask"
            className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
          >
            {askMutation.isPending ? "..." : "Ask"}
          </button>
        </div>
        {askMutation.isError && (
          <div className="mt-1 text-[11px] text-destructive">
            {getErrorMessage(askMutation.error)}
          </div>
        )}
      </form>
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

  const { data: healingSessions = [] } = useQuery<HealingSession[]>({
    queryKey: ["/api/healing-sessions"],
    queryFn: async () => fetchJson<HealingSession[]>("/api/healing-sessions"),
    refetchInterval: 5000,
  });

  const { data: repos = [] } = useQuery<WatchedRepo[]>({
    queryKey: ["/api/repos/settings"],
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
  const selectedPRWatchEnabled = selectedPR ? isPRWatchEnabled(selectedPR) : true;

  const addMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/prs", { url });
      return res.json();
    },
    onSuccess: (data: PR) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
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

  const watchMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/prs/${id}/watch`, { enabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not update PR watch state", error);
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setAddRepo("");
    },
    onError: (error) => {
      showMutationError("Could not watch repository", error);
    },
  });

  const updateRepoSettingsMutation = useMutation({
    mutationFn: async ({
      repo,
      autoCreateReleases,
    }: {
      repo: string;
      autoCreateReleases: boolean;
    }) => {
      const res = await apiRequest("PATCH", "/api/repos/settings", {
        repo,
        autoCreateReleases,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
    },
    onError: (error) => {
      showMutationError("Could not update repository settings", error);
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
          <Link
            href="/changelogs"
            className="text-[11px] text-muted-foreground hover:text-foreground focus:outline-none"
          >
            changelogs
          </Link>
          <Link
            href="/releases"
            className="text-[11px] text-muted-foreground hover:text-foreground focus:outline-none"
          >
            releases
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {prs.length} PR{prs.length !== 1 ? "s" : ""} in {repos.length} repo{repos.length !== 1 ? "s" : ""}
          </span>
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Agent</label>
          <select
            value={config?.codingAgent ?? "codex"}
            onChange={(e) => {
              const newAgent = e.target.value as Config["codingAgent"];
              updateConfigMutation.mutate({
                codingAgent: newAgent,
              });
            }}
            disabled={updateConfigMutation.isPending}
            data-testid="select-coding-agent"
            className="border border-border bg-transparent px-2 py-0.5 text-[11px] focus:border-foreground focus:outline-none disabled:opacity-50"
          >
            <option value="codex">codex</option>
            <option value="claude">claude</option>
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={config?.autoResolveMergeConflicts ?? true}
              onChange={(e) =>
                updateConfigMutation.mutate({
                  autoResolveMergeConflicts: e.target.checked,
                })
              }
              disabled={updateConfigMutation.isPending}
              data-testid="checkbox-auto-resolve-conflicts"
              className="accent-foreground"
            />
            Auto-resolve conflicts
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={config?.autoUpdateDocs ?? true}
              onChange={(e) =>
                updateConfigMutation.mutate({
                  autoUpdateDocs: e.target.checked,
                })
              }
              disabled={updateConfigMutation.isPending}
              data-testid="checkbox-auto-update-docs"
              className="accent-foreground"
            />
            Auto-update docs
          </label>
          <Link
            href="/settings"
            className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            settings
          </Link>
        </div>
      </header>

      <OnboardingPanel />

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
                        <div
                          key={repo.repo}
                          className="flex items-center justify-between gap-3 border border-border/60 px-2 py-1.5"
                        >
                          <a
                            href={getRepoHref(repo.repo)}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`tracked-repo-${repo.repo.replace("/", "-")}`}
                            className="min-w-0 break-all text-foreground/75 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                          >
                            {repo.repo}
                          </a>
                          <label className="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={repo.autoCreateReleases}
                              onChange={(e) =>
                                updateRepoSettingsMutation.mutate({
                                  repo: repo.repo,
                                  autoCreateReleases: e.target.checked,
                                })
                              }
                              disabled={updateRepoSettingsMutation.isPending}
                              data-testid={`tracked-repo-auto-release-${repo.repo.replace("/", "-")}`}
                              className="accent-foreground"
                            />
                            Auto-release
                          </label>
                        </div>
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
                      <AgentIndicator pr={selectedPR} />
                      {!selectedPRWatchEnabled && <WatchPausedIndicator />}
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
                      {!selectedPRWatchEnabled && <WatchPausedIndicator />}
                      <span>{selectedPR.feedbackItems.length} items</span>
                      {selectedPR.feedbackItems.length > 0 && (() => {
                        const counts = countActiveFeedbackStatuses(selectedPR.feedbackItems);
                        return (
                          <>
                            {counts.queued > 0 && <span>{counts.queued} queued</span>}
                            {counts.inProgress > 0 && <span>{counts.inProgress} in progress</span>}
                            {counts.failed > 0 && <span>{counts.failed} failed</span>}
                            {counts.warning > 0 && <span>{counts.warning} warnings</span>}
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
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => applyMutation.mutate(selectedPR.id)}
                        disabled={applyMutation.isPending || selectedPR.status === "processing"}
                        data-testid="button-apply"
                        className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
                      >
                        {selectedPR.status === "processing" ? "Running" : "Run now"}
                      </button>
                      <button
                        onClick={() => watchMutation.mutate({ id: selectedPR.id, enabled: !selectedPRWatchEnabled })}
                        disabled={watchMutation.isPending}
                        data-testid="button-toggle-watch"
                        className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background disabled:opacity-30"
                      >
                        {selectedPRWatchEnabled ? "Pause watch" : "Resume watch"}
                      </button>
                    </div>
                  )}
                </div>
                {isPRReadyToMerge(selectedPR.feedbackItems) && selectedPR.status !== "processing" && countActiveFeedbackStatuses(selectedPR.feedbackItems).inProgress === 0 && (
                  <ReadyToMergeIndicator
                    href={selectedPR.url}
                    testId="detail-ready-to-merge"
                    label="All comments resolved — ready to merge"
                    hint="Open PR on GitHub →"
                    className="mt-2 gap-2 px-3 py-1.5 text-[12px] tracking-wider"
                    dotClassName="h-2 w-2"
                    hintClassName="text-[11px] normal-case tracking-normal text-green-500/70"
                  />
                )}
                <div className="text-[11px] text-muted-foreground">
                  {selectedPRWatchEnabled
                    ? "Background watcher syncs GitHub feedback and pushes approved fixes automatically."
                    : "Background watch is paused for this PR; manual runs still work."}
                </div>
              </div>

              <HealingPanel pr={selectedPR} config={config} healingSessions={healingSessions} />

              <div className="flex-1 overflow-y-auto">
                {selectedPR.feedbackItems.length === 0 ? (
                  <div className="p-4 text-[12px] text-muted-foreground">
                    {selectedPRWatchEnabled
                      ? "No feedback yet. The watcher will sync GitHub comments automatically."
                      : "No feedback yet. Background watch is paused for this PR."}
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

        <RightPanel prId={selectedPRId} />
      </div>
    </div>
  );
}
