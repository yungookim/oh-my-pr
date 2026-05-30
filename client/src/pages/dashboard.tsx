import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Activity as ActivityIcon } from "lucide-react";
import { queryClient, apiRequest, fetchJson } from "@/lib/queryClient";
import { getRepoHref } from "@/lib/repoHref";
import { getRepoAddControlsOpen } from "@/lib/repoAddControls";
import type { ActivityItem, ActivitySnapshot, Config, FeedbackItem, HealingSession, LogEntry, OperatorWarning, PR, PRQuestion, ReleaseRun, RuntimeState, WatchedRepo } from "@shared/schema";
import { OnboardingPanel } from "@/components/OnboardingPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import {
  formatFeedbackStatusLabel,
  getFeedbackStatusBadgeClass,
  countActiveFeedbackStatuses,
  isPRReadyToMerge,
} from "@/lib/feedbackStatus";
import {
  formatFeedbackOverview,
  getFeedbackGroupSections,
  getFeedbackPreview,
  type FeedbackGroupSection as FeedbackGroupSectionView,
} from "@/lib/feedbackDisplay";
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

function latestActivityForTarget(activities: ActivityItem[], targetId: string): ActivityItem | undefined {
  return activities.reduce((latest, activity) => {
    if (activity.targetId !== targetId) {
      return latest;
    }
    if (!latest || Date.parse(activity.updatedAt) > Date.parse(latest.updatedAt)) {
      return activity;
    }
    return latest;
  }, undefined as ActivityItem | undefined);
}

function getPRFeedbackFailureReason(pr: PR): string | null {
  const failedItem = pr.feedbackItems.find((item) =>
    (item.status === "failed" || item.status === "warning") && Boolean(item.statusReason),
  );

  return failedItem?.statusReason ?? null;
}

const WATCH_SCOPE_OPTIONS = [
  { value: "mine", label: "My PRs only" },
  { value: "team", label: "My PRs + teammates" },
] as const;

const EMPTY_ACTIVITY_SNAPSHOT: ActivitySnapshot = {
  failed: [],
  inProgress: [],
  queued: [],
  warnings: [],
  generatedAt: "",
};
const MAX_VISIBLE_LOGS = 200;
const TRACKED_REPOS_OPEN_KEY = "oh-my-pr:tracked-repos-open";
const DRAIN_PAUSED_LABEL = "Paused";
const DRAIN_PAUSED_TITLE = "Paused by drain mode";
const MANUAL_RUNS_BLOCKED_COPY = "Manual runs are blocked while global automation is paused.";
const GLOBAL_DRAIN_PR_COPY = "Background and manual runs are paused by drain mode.";
const ASK_DRAIN_COPY = "Ask Agent is paused by drain mode.";
const QUEUED_DRAIN_COPY = "Queued automation is paused until drain mode is disabled.";

type WatchScope = (typeof WATCH_SCOPE_OPTIONS)[number]["value"];
type RepoSettings = WatchedRepo & {
  ownPrsOnly?: boolean;
};
type RepoSettingsUpdate = {
  repo: string;
  autoCreateReleases?: boolean;
  ownPrsOnly?: boolean;
};

function getWatchScope(ownPrsOnly?: boolean): WatchScope {
  return ownPrsOnly === false ? "team" : "mine";
}

const HEALING_TONE_CLASSES: Record<"neutral" | "info" | "warning" | "success" | "danger", string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-foreground text-foreground",
  warning: "border-warning-border bg-warning-muted text-warning-foreground",
  success: "border-success-border bg-success-muted text-success-foreground",
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

const FEEDBACK_DECISIONS = ["accept", "reject", "flag"] as const;
type FeedbackDecision = (typeof FEEDBACK_DECISIONS)[number];

function formatFeedbackLocation(item: FeedbackItem): string {
  if (item.file) {
    return `${item.file}${item.line ? `:${item.line}` : ""}`;
  }

  if (item.type === "general_comment") {
    return "General comment";
  }

  if (item.type === "review") {
    return "Review";
  }

  return "Review comment";
}

function formatFeedbackMeta(item: FeedbackItem, createdAt: string | null): string {
  const parts = [item.author];

  if (createdAt) {
    parts.push(createdAt);
  }

  if (item.decision) {
    parts.push(`decision: ${item.decision}`);
  }

  return parts.join(" · ");
}

function WatchPausedIndicator() {
  return (
    <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
      watch paused
    </span>
  );
}

function WatchScopeControl({
  value,
  onChange,
  disabled,
  name,
  testIdPrefix,
  compact = false,
}: {
  value: WatchScope;
  onChange: (value: WatchScope) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
  compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Automatic PR tracking scope"
      className={`flex flex-wrap gap-1 ${compact ? "" : "mt-1"}`}
    >
      {WATCH_SCOPE_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <label
            key={option.value}
            data-testid={`${testIdPrefix}-${option.value}`}
            className={`cursor-pointer border px-2 text-[10px] transition-colors focus-within:ring-1 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background ${
              compact ? "py-0.5" : "py-1"
            } ${
              active
                ? "border-foreground bg-muted text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            } ${disabled ? "cursor-not-allowed opacity-50" : ""} whitespace-nowrap`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={active}
              onChange={() => onChange(option.value)}
              disabled={disabled}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

function ActivityRow({ activity }: { activity: ActivityItem }) {
  const timeLabel = activity.status === "failed"
    ? formatClock(activity.updatedAt)
    : activity.status === "in_progress"
    ? formatClock(activity.startedAt) ?? formatClock(activity.updatedAt)
    : formatClock(activity.availableAt) ?? formatClock(activity.queuedAt);
  const content = (
    <div className="flex min-w-0 items-start gap-2 px-2 py-1.5 text-left">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 ${
          activity.status === "failed"
            ? "bg-destructive"
            : activity.status === "in_progress"
              ? "animate-pulse bg-foreground"
              : "bg-muted-foreground"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] leading-4 text-foreground">{activity.label}</span>
        {activity.detail && (
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">{activity.detail}</span>
        )}
        {activity.status === "failed" && activity.lastError && (
          <span
            className="block whitespace-pre-wrap break-words text-[11px] leading-4 text-destructive"
            title={activity.lastError}
          >
            {activity.lastError}
          </span>
        )}
      </span>
      {timeLabel && (
        <span className="shrink-0 text-[10px] leading-4 text-muted-foreground">{timeLabel}</span>
      )}
    </div>
  );

  if (activity.targetUrl) {
    return (
      <a
        href={activity.targetUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block outline-none hover:bg-muted focus:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {content}
      </a>
    );
  }

  return <div>{content}</div>;
}

function ActivitySection({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: ActivityItem[];
  emptyLabel: string;
}) {
  return (
    <div className="py-1">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      {items.length > 0 ? (
        <div className="max-h-52 overflow-y-auto">
          {items.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
        </div>
      ) : (
        <div className="px-2 pb-2 text-[11px] text-muted-foreground">{emptyLabel}</div>
      )}
    </div>
  );
}

function ActivityMenu({
  activities,
  onClearFailed,
  isClearingFailed,
  globalDrainMode,
}: {
  activities: ActivitySnapshot;
  onClearFailed: () => void;
  isClearingFailed: boolean;
  globalDrainMode: boolean;
}) {
  const failedCount = activities.failed.length;
  const inProgressCount = activities.inProgress.length;
  const queuedCount = activities.queued.length;
  const totalCount = failedCount + inProgressCount + queuedCount;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        aria-label="Open activity menu"
        data-testid="activity-menu-trigger"
      >
        <ActivityIcon className="h-3 w-3" aria-hidden="true" />
        <span>activity</span>
        <span className="text-foreground">{totalCount}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-medium">Activities</div>
            {failedCount > 0 && (
              <button
                type="button"
                onClick={onClearFailed}
                disabled={isClearingFailed}
                className="border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="clear-failed-activities"
              >
                {isClearingFailed ? "clearing" : "clear failed"}
              </button>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {failedCount} failed / {inProgressCount} in progress / {queuedCount} queued
          </div>
        </div>
        <ActivitySection
          title="Failed"
          items={activities.failed}
          emptyLabel="No failed activities."
        />
        <div className="border-t border-border" />
        <ActivitySection
          title="In progress"
          items={activities.inProgress}
          emptyLabel="No activities running right now."
        />
        <div className="border-t border-border" />
        <ActivitySection
          title="Queued"
          items={activities.queued}
          emptyLabel="Queue is empty."
        />
        {globalDrainMode && queuedCount > 0 && (
          <div
            className="border-t border-border px-2 py-2 text-[11px] text-muted-foreground"
            data-testid="activity-drain-note"
          >
            {QUEUED_DRAIN_COPY}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DashboardDrainBanner({ runtimeState }: { runtimeState: RuntimeState | undefined }) {
  if (!runtimeState?.drainMode) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-[12px]"
      data-testid="dashboard-drain-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-destructive">
            {DRAIN_PAUSED_TITLE}
          </div>
          {runtimeState.drainReason ? (
            <div
              className="mt-1 break-words text-foreground/80"
              data-testid="dashboard-drain-reason"
            >
              {runtimeState.drainReason}
            </div>
          ) : null}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {MANUAL_RUNS_BLOCKED_COPY}
          </div>
        </div>
        <Link
          href="/settings"
          className="shrink-0 border border-destructive/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Settings
        </Link>
      </div>
    </div>
  );
}

function OperatorWarningsBanner({ warnings }: { warnings: OperatorWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-yellow-600/50 bg-yellow-500/10 px-4 py-3"
      data-testid="operator-warnings-banner"
    >
      <div className="space-y-3">
        {warnings.map((warning) => (
          <div key={warning.id} data-testid={`operator-warning-${warning.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[12px] font-medium uppercase tracking-wider text-yellow-600">
                {warning.title}
              </div>
              {warning.targetUrl && (
                <a
                  href={warning.targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-yellow-600/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-yellow-600 transition-colors hover:bg-yellow-600 hover:text-background"
                >
                  Open PR
                </a>
              )}
            </div>
            <div className="mt-1 text-[12px] text-foreground/80">{warning.message}</div>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
              {warning.fixSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
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
      className={`inline-flex items-center border border-success-border bg-success-muted font-medium uppercase text-success-foreground transition-colors hover:bg-success-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${className}`}
    >
      <span className={`inline-block rounded-full bg-success ${dotClassName}`} />
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

const PRRow = memo(function PRRow({
  pr,
  isSelected,
  onSelect,
  failureMessage,
}: {
  pr: PR;
  isSelected: boolean;
  onSelect: (id: string) => void;
  failureMessage?: string | null;
}) {
  const checkedAt = formatClock(pr.lastChecked);
  const watchEnabled = isPRWatchEnabled(pr);
  const agentActive = pr.status === "processing" || countActiveFeedbackStatuses(pr.feedbackItems).inProgress > 0;
  const readyToMerge = !agentActive && isPRReadyToMerge(pr.feedbackItems);

  return (
    <div
      onClick={() => onSelect(pr.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(pr.id);
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
              hintClassName="text-[10px] normal-case tracking-normal text-success-foreground/75"
            />
          )}
          {pr.status === "error" && failureMessage && (
            <div className="mt-2 ml-[3.75rem] border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] leading-4 text-destructive">
              <span className="font-medium uppercase tracking-wider">Error:</span>{" "}
              <span className="break-words">{failureMessage}</span>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.75rem] text-[11px] text-muted-foreground">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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
});

function FeedbackRow({
  item,
  prId,
  readOnly,
  globalDrainMode = false,
}: {
  item: FeedbackItem;
  prId: string;
  readOnly?: boolean;
  globalDrainMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const overrideMutation = useMutation({
    mutationFn: async (decision: FeedbackDecision) => {
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
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not retry feedback item", error);
    },
  });

  const createdAt = formatClock(item.createdAt);
  const location = formatFeedbackLocation(item);
  const preview = getFeedbackPreview(item);
  const meta = formatFeedbackMeta(item, createdAt);
  const prominentStatusReason = (item.status === "failed" || item.status === "warning") && item.statusReason
    ? item.statusReason
    : null;
  const prominentStatusLabel = item.status === "warning" ? "Warning" : "Blocked";

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="border-b border-border/80">
      <div className="px-4 py-2.5">
        <div className="flex items-start gap-3">
          <div className="shrink-0 pt-0.5">
            <FeedbackStatusTag status={item.status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-col gap-0.5 lg:flex-row lg:items-baseline lg:gap-2">
              <span className="min-w-0 truncate text-[12px] font-medium text-foreground/85 lg:max-w-[42%] lg:shrink-0">
                {location}
              </span>
              <span className="min-w-0 truncate text-[12px] text-foreground/75" title={preview}>
                "{preview}"
              </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={meta}>
              {meta}
            </div>
            {prominentStatusReason && (
              <div
                className="mt-1 flex min-w-0 items-center gap-1 border border-destructive/25 bg-destructive/10 px-2 py-1 text-[11px] leading-4 text-destructive"
                title={prominentStatusReason}
              >
                <span className="shrink-0 font-medium uppercase tracking-wider">{prominentStatusLabel}:</span>
                <span className="min-w-0 truncate">{prominentStatusReason}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!readOnly && (item.status === "failed" || item.status === "warning") && (
              <button
                type="button"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending || globalDrainMode}
                data-testid={`retry-${item.id}`}
                aria-label={`Retry feedback from ${item.author}`}
                title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Retry feedback item"}
                className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
              >
                {globalDrainMode ? DRAIN_PAUSED_LABEL : "Retry"}
              </button>
            )}
            <Collapsible.Trigger asChild>
              <button
                type="button"
                data-testid={`toggle-${item.id}`}
                aria-label={`${open ? "Hide" : "Show"} feedback details from ${item.author}`}
                title="Toggle feedback details"
                className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                {open ? "Hide" : "Open"}
              </button>
            </Collapsible.Trigger>
          </div>
        </div>
      </div>
      <Collapsible.Content>
        <div className="px-4 pb-3 pl-[calc(1rem+4.5rem)]">
          {item.bodyHtml ? (
            <div
              className="feedback-markdown text-[12px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: item.bodyHtml }}
            />
          ) : (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/80">{item.body}</p>
          )}
          {item.statusReason && !prominentStatusReason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground/70">Status reason:</span>{" "}
              {item.statusReason}
            </p>
          )}
          {item.decisionReason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground/70">Decision reason:</span>{" "}
              {item.decisionReason}
            </p>
          )}
          {!readOnly && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Manual decision
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {FEEDBACK_DECISIONS.map((decision) => (
                  <button
                    type="button"
                    key={decision}
                    onClick={() => overrideMutation.mutate(decision)}
                    disabled={overrideMutation.isPending}
                    data-testid={`override-${decision}-${item.id}`}
                    aria-label={`${decision} feedback from ${item.author}`}
                    className={`px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30 ${
                      item.decision === decision ? "bg-foreground text-background" : "border border-border text-muted-foreground"
                    }`}
                  >
                    {decision}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function FeedbackGroupSection({
  section,
  prId,
  readOnly,
  globalDrainMode,
}: {
  section: FeedbackGroupSectionView;
  prId: string;
  readOnly?: boolean;
  globalDrainMode: boolean;
}) {
  const [open, setOpen] = useState(section.defaultOpen);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="border-b border-border last:border-b-0">
      <div className="sticky top-0 z-[1] border-b border-border/80 bg-background/95 px-4 py-2">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            aria-label={`${open ? "Collapse" : "Expand"} ${section.label.toLowerCase()} feedback`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="w-3 text-[10px] text-muted-foreground">
                {open ? "▾" : "▸"}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-foreground/80">
                {section.label}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {section.items.length}
              </span>
            </span>
            {section.summary && (
              <span className="truncate text-[11px] text-muted-foreground">
                {section.summary}
              </span>
            )}
          </button>
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content>
        {section.items.map((item) => (
          <FeedbackRow
            key={item.id}
            item={item}
            prId={prId}
            readOnly={readOnly}
            globalDrainMode={globalDrainMode}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function FeedbackGroups({
  items,
  prId,
  readOnly,
  globalDrainMode,
}: {
  items: FeedbackItem[];
  prId: string;
  readOnly?: boolean;
  globalDrainMode: boolean;
}) {
  return (
    <>
      {getFeedbackGroupSections(items).map((section) => (
        <FeedbackGroupSection
          key={section.key}
          section={section}
          prId={prId}
          readOnly={readOnly}
          globalDrainMode={globalDrainMode}
        />
      ))}
    </>
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
  const visibleLogs = useMemo(
    () => logs.length > MAX_VISIBLE_LOGS ? logs.slice(-MAX_VISIBLE_LOGS) : logs,
    [logs],
  );
  const hiddenLogCount = logs.length - visibleLogs.length;

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
          <>
            {hiddenLogCount > 0 && (
              <div className="border-b border-border/60 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Showing latest {MAX_VISIBLE_LOGS} of {logs.length} entries.
              </div>
            )}
            {visibleLogs.map((log) => {
              const metadataText = log.metadata && Object.keys(log.metadata).length > 0
                ? JSON.stringify(log.metadata, null, 2)
                : null;

              return (
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
                  <div className={`mt-1 break-words ${log.level === "error" ? "text-destructive" : "text-foreground/75"}`}>
                    {log.message}
                  </div>
                  {metadataText && (
                    <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                      {metadataText}
                    </pre>
                  )}
                </div>
              );
            })}
          </>
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

function RightPanel({
  prId,
  prStatus,
  globalDrainMode,
}: {
  prId: string | null;
  prStatus?: PR["status"] | null;
  globalDrainMode: boolean;
}) {
  const [tab, setTab] = useState<"activity" | "ask">("ask");

  useEffect(() => {
    if (prStatus === "error") {
      setTab("activity");
    }
  }, [prId, prStatus]);

  return (
    <div className="flex min-h-[24rem] w-full shrink-0 flex-col border-t border-border lg:min-h-0 lg:w-80 lg:border-l lg:border-t-0">
      <div className="flex border-b border-border">
        <button
          type="button"
          onClick={() => setTab("ask")}
          data-testid="tab-ask"
          className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
            tab === "ask"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Ask Agent
        </button>
        <button
          type="button"
          onClick={() => setTab("activity")}
          data-testid="tab-activity"
          className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
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
          <QAPanel prId={prId} globalDrainMode={globalDrainMode} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            Select a PR to ask questions.
          </div>
        )}
      </div>
    </div>
  );
}

function QAPanel({ prId, globalDrainMode }: { prId: string; globalDrainMode: boolean }) {
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
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      setInput("");
    },
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [questions.length, questions[questions.length - 1]?.status]);

  const askDisabled = askMutation.isPending || !input.trim() || globalDrainMode;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Ask Agent
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {questions.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">
            {globalDrainMode
              ? ASK_DRAIN_COPY
              : "Ask questions about this PR — the agent will read activity logs, feedback, and status to answer."}
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
          if (!askDisabled) askMutation.mutate(input.trim());
        }}
        className="border-t border-border p-3"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={globalDrainMode ? "Drain mode is enabled." : "Was the review done? Why did this fail?"}
            aria-label="Question for selected pull request"
            disabled={globalDrainMode}
            data-testid="input-question"
            className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
          <button
            type="submit"
            disabled={askDisabled}
            title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Ask agent"}
            data-testid="button-ask"
            className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
          >
            {globalDrainMode ? DRAIN_PAUSED_LABEL : askMutation.isPending ? "..." : "Ask"}
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
  const [addControlsOpen, setAddControlsOpen] = useState<boolean | null>(null);
  const [trackedReposOpen, setTrackedReposOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const stored = window.localStorage.getItem(TRACKED_REPOS_OPEN_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const [watchScope, setWatchScope] = useState<WatchScope>("mine");
  const [viewMode, setViewMode] = useState<"active" | "archived">("active");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TRACKED_REPOS_OPEN_KEY, String(trackedReposOpen));
    } catch {
      // Ignore storage errors when browser settings restrict localStorage.
    }
  }, [trackedReposOpen]);

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

  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: 3000,
  });

  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 3000,
  });

  const { data: repos = [] } = useQuery<RepoSettings[]>({
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
  const selectedFailedActivity = selectedPR ? latestActivityForTarget(activities.failed, selectedPR.id) : undefined;
  const selectedPRErrorMessage = selectedPR?.status === "error"
    ? selectedFailedActivity?.lastError ?? getPRFeedbackFailureReason(selectedPR) ?? "Automation stopped on this PR. Check the activity log for the full failure context."
    : null;
  const repoAddControlsOpen = getRepoAddControlsOpen(addControlsOpen, repos.length);
  const globalDrainMode = runtimeState?.drainMode === true;

  const addMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/prs", { url });
      return res.json();
    },
    onSuccess: (data: PR) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
    onError: (error) => {
      showMutationError("Could not sync repositories", error);
    },
  });

  const clearFailedActivitiesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/activities/failed");
      return res.json() as Promise<{ cleared: number }>;
    },
    onSuccess: ({ cleared }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      toast({ description: cleared === 1 ? "Cleared 1 failed activity." : `Cleared ${cleared} failed activities.` });
    },
    onError: (error) => {
      showMutationError("Could not clear failed activities", error);
    },
  });

  const manualReleaseMutation = useMutation({
    mutationFn: async (repo: string) => {
      const res = await apiRequest("POST", "/api/repos/release", { repo });
      return res.json() as Promise<ReleaseRun>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/releases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      toast({ description: "Release queued." });
    },
    onError: (error) => {
      showMutationError("Could not create release", error);
    },
  });

  const updateRepoSettingsRequest = async (updates: RepoSettingsUpdate) => {
    const res = await apiRequest("PATCH", "/api/repos/settings", updates);
    return res.json();
  };

  const updateRepoSettingsMutation = useMutation({
    mutationFn: updateRepoSettingsRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
    onError: (error) => {
      showMutationError("Could not update repository settings", error);
    },
  });

  const addRepoMutation = useMutation({
    mutationFn: async ({ repo }: { repo: string; watchScope: WatchScope }) => {
      const res = await apiRequest("POST", "/api/repos", { repo });
      return res.json();
    },
    onSuccess: async (data: { repo: string }, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setAddRepo("");
      setWatchScope("mine");

      if (variables.watchScope === "team") {
        try {
          await updateRepoSettingsRequest({
            repo: data.repo,
            ownPrsOnly: false,
          });
          queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
        } catch (error) {
          showMutationError("Repository added, but could not update tracking scope", error);
        }
      }
    },
    onError: (error) => {
      showMutationError("Could not watch repository", error);
    },
  });

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <UpdateBanner />
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="oh-my-pr">
            <rect x="1" y="1" width="14" height="14" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 5h8M4 8h5M4 11h6" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span className="text-sm font-medium tracking-tight">oh-my-pr</span>
          <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            autonomous
          </span>
          <span className="text-[11px] text-muted-foreground">
            poll {formatPollInterval(config?.pollIntervalMs)}
          </span>
          <Link
            href="/changelogs"
            className="text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            changelogs
          </Link>
          <Link
            href="/releases"
            className="text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            releases
          </Link>
          <Link
            href="/logs"
            className="text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            logs
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {prs.length} PR{prs.length !== 1 ? "s" : ""} in {repos.length} repo{repos.length !== 1 ? "s" : ""}
          </span>
          <label htmlFor="dashboard-coding-agent" className="text-[11px] uppercase tracking-wider text-muted-foreground">Agent</label>
          <select
            id="dashboard-coding-agent"
            value={config?.codingAgent ?? "codex"}
            onChange={(e) => {
              const newAgent = e.target.value as Config["codingAgent"];
              updateConfigMutation.mutate({
                codingAgent: newAgent,
              });
            }}
            disabled={updateConfigMutation.isPending}
            data-testid="select-coding-agent"
            className="border border-border bg-transparent px-2 py-0.5 text-[11px] focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          >
            <option value="codex">codex</option>
            <option value="claude">claude</option>
          </select>
          <Link
            href="/settings"
            className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            settings
          </Link>
          <ActivityMenu
            activities={activities}
            onClearFailed={() => clearFailedActivitiesMutation.mutate()}
            isClearingFailed={clearFailedActivitiesMutation.isPending}
            globalDrainMode={globalDrainMode}
          />
        </div>
      </header>

      <OnboardingPanel />
      <OperatorWarningsBanner warnings={activities.warnings} />
      <DashboardDrainBanner runtimeState={runtimeState} />

      <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-y-auto border-b border-border lg:max-h-none lg:min-h-0 lg:w-80 lg:border-b-0 lg:border-r">
          <div className="sticky top-0 z-10 flex shrink-0 border-b border-border bg-background">
            <button
              type="button"
              onClick={() => setViewMode("active")}
              data-testid="tab-active"
              className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "active"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Active ({prs.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode("archived")}
              data-testid="tab-archived"
              className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
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
              <Collapsible.Root
                open={repoAddControlsOpen}
                onOpenChange={setAddControlsOpen}
                className="border-b border-border"
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                  <span>
                    {repos.length > 0
                      ? "Add a PR or watch another repo."
                      : "Add a PR or watch a repo. Sync and babysit start automatically."}
                  </span>
                  <Collapsible.Trigger asChild>
                    <button
                      type="button"
                      data-testid="button-toggle-add-controls"
                      className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      {repoAddControlsOpen ? "Hide" : "Add"}
                    </button>
                  </Collapsible.Trigger>
                </div>
                <Collapsible.Content>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (addUrl.trim()) addMutation.mutate(addUrl.trim());
                    }}
                    className="border-t border-border p-3"
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={addUrl}
                        onChange={(e) => setAddUrl(e.target.value)}
                        placeholder="github.com/owner/repo/pull/123"
                        aria-label="GitHub pull request URL"
                        data-testid="input-add-pr"
                        className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      />
                      <button
                        type="submit"
                        disabled={addMutation.isPending || !addUrl.trim()}
                        data-testid="button-add-pr"
                        className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                      >
                        Add
                      </button>
                    </div>
                  </form>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const repo = addRepo.trim();
                      if (repo) {
                        addRepoMutation.mutate({ repo, watchScope });
                      }
                    }}
                    className="border-t border-border p-3"
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={addRepo}
                        onChange={(e) => setAddRepo(e.target.value)}
                        placeholder="owner/repo"
                        aria-label="Repository owner and name"
                        data-testid="input-add-repo"
                        className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      />
                      <button
                        type="submit"
                        disabled={addRepoMutation.isPending || !addRepo.trim()}
                        data-testid="button-add-repo"
                        className="border border-border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                      >
                        Watch
                      </button>
                    </div>
                    <div className="mt-3">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Track automatically
                      </div>
                      <WatchScopeControl
                        value={watchScope}
                        onChange={setWatchScope}
                        disabled={addRepoMutation.isPending}
                        name="watch-scope"
                        testIdPrefix="watch-scope"
                      />
                    </div>
                  </form>
                </Collapsible.Content>
              </Collapsible.Root>
              <Collapsible.Root
                open={trackedReposOpen}
                onOpenChange={setTrackedReposOpen}
                className="border-b border-border"
              >
                <div className="flex items-center justify-between gap-2 p-3">
                  <Collapsible.Trigger asChild>
                    <button
                      type="button"
                      data-testid="button-toggle-tracked-repos"
                      aria-label={trackedReposOpen ? "Collapse tracked repositories" : "Expand tracked repositories"}
                      className="flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      <span aria-hidden="true">{trackedReposOpen ? "▾" : "▸"}</span>
                      <span>Tracked repositories</span>
                      {!trackedReposOpen && repos.length > 0 && (
                        <span className="text-muted-foreground/70">({repos.length})</span>
                      )}
                    </button>
                  </Collapsible.Trigger>
                  <button
                    type="button"
                    onClick={() => syncReposMutation.mutate()}
                    disabled={syncReposMutation.isPending}
                    data-testid="button-sync-repos"
                    className="border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                  >
                    {syncReposMutation.isPending ? "Fetching..." : "Fetch"}
                  </button>
                </div>
                <Collapsible.Content className="px-3 pb-3">
                  {repos.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground">No repositories being watched yet.</div>
                  ) : (
                    <div className="space-y-1 text-[12px]">
                      {repos.map((repo) => {
                        const manualReleasePending = manualReleaseMutation.isPending
                          && manualReleaseMutation.variables === repo.repo;

                        return (
                          <div
                            key={repo.repo}
                            className="space-y-2 border border-border/60 px-2 py-2"
                          >
                            <a
                              href={getRepoHref(repo.repo)}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid={`tracked-repo-${repo.repo.replace("/", "-")}`}
                              className="min-w-0 break-all text-foreground/75 underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            >
                              {repo.repo}
                            </a>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                  Track automatically
                                </div>
                                <WatchScopeControl
                                  value={getWatchScope(repo.ownPrsOnly)}
                                  onChange={(value) =>
                                    updateRepoSettingsMutation.mutate({
                                      repo: repo.repo,
                                      ownPrsOnly: value === "mine",
                                    })
                                  }
                                  disabled={updateRepoSettingsMutation.isPending}
                                  name={`tracked-repo-scope-${repo.repo}`}
                                  testIdPrefix={`tracked-repo-scope-${repo.repo.replace("/", "-")}`}
                                  compact
                                />
                              </div>
                              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end">
                                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
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
                                    className="accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                  />
                                  Auto-release
                                </label>
                                <button
                                  type="button"
                                  onClick={() => manualReleaseMutation.mutate(repo.repo)}
                                  disabled={manualReleaseMutation.isPending || globalDrainMode}
                                  title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Queue manual release"}
                                  data-testid={`tracked-repo-manual-release-${repo.repo.replace("/", "-")}`}
                                  className="border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                                >
                                  {globalDrainMode ? DRAIN_PAUSED_LABEL : manualReleasePending ? "Releasing..." : "Release"}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Collapsible.Content>
              </Collapsible.Root>
            </>
          )}
          <div className="flex-1">
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
                  onSelect={setSelectedPRId}
                  failureMessage={
                    pr.status === "error"
                      ? latestActivityForTarget(activities.failed, pr.id)?.lastError ?? getPRFeedbackFailureReason(pr)
                      : null
                  }
                />
              ))
            )}
          </div>
        </div>

        <div className="flex min-h-[32rem] flex-1 flex-col overflow-hidden lg:min-h-0">
          {selectedPR ? (
            <>
              <div className="shrink-0 border-b border-border px-4 py-3">
                <div className="mb-1 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusDot status={selectedPR.status} />
                      <span className="truncate font-medium">{selectedPR.title}</span>
                      <AgentIndicator pr={selectedPR} />
                      {!selectedPRWatchEnabled && <WatchPausedIndicator />}
                      <a
                        href={selectedPR.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      >
                        {selectedPR.repo}#{selectedPR.number}
                      </a>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>status: {formatStatusLabel(selectedPR.status)}</span>
                      {!selectedPRWatchEnabled && <WatchPausedIndicator />}
                      <span>feedback: {formatFeedbackOverview(selectedPR.feedbackItems)}</span>
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
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => applyMutation.mutate(selectedPR.id)}
                        disabled={applyMutation.isPending || selectedPR.status === "processing" || globalDrainMode}
                        title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Run babysitter now"}
                        data-testid="button-apply"
                        className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                      >
                        {globalDrainMode ? DRAIN_PAUSED_LABEL : selectedPR.status === "processing" ? "Running" : "Run now"}
                      </button>
                      <button
                        type="button"
                        onClick={() => watchMutation.mutate({ id: selectedPR.id, enabled: !selectedPRWatchEnabled })}
                        disabled={watchMutation.isPending}
                        data-testid="button-toggle-watch"
                        className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
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
                    hintClassName="text-[11px] normal-case tracking-normal text-success-foreground/75"
                  />
                )}
                {selectedPRErrorMessage && (
                  <div
                    className="mt-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive"
                    data-testid="selected-pr-error"
                  >
                    <div className="text-[10px] font-medium uppercase tracking-wider">Automation error</div>
                    <div className="mt-1 whitespace-pre-wrap break-words">{selectedPRErrorMessage}</div>
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  {globalDrainMode
                    ? GLOBAL_DRAIN_PR_COPY
                    : selectedPRWatchEnabled
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
                  <FeedbackGroups
                    items={selectedPR.feedbackItems}
                    prId={selectedPR.id}
                    readOnly={isArchived}
                    globalDrainMode={globalDrainMode}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Select a PR from the left panel.
            </div>
          )}
        </div>

        <RightPanel
          prId={selectedPRId}
          prStatus={selectedPR?.status ?? null}
          globalDrainMode={globalDrainMode}
        />
      </div>
    </div>
  );
}
