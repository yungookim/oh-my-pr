import { randomUUID } from "crypto";
import { access } from "fs/promises";
import path from "path";
import type { AgentRun, CheckSnapshot, FeedbackItem, HealingSession, PR } from "@shared/schema";
import type { IStorage } from "./storage";
import {
  applyFixesWithAgent,
  checkAgentHealth,
  detectAgentUnavailability,
  evaluateFixNecessityWithAgent,
  isAgentUnavailableError,
  resolveAgent,
  runCommand,
  STDIN_PRELUDE_PATTERN,
  summarizeCommandResult,
  type AgentHealthResult,
  type AgentUnavailabilityKind,
  type CodingAgent,
} from "./agentRunner";
import {
  addReactionToComment,
  buildGitHubCloneUrl,
  buildOctokit,
  checkCISettled,
  fetchCheckSnapshotsForRef,
  fetchFeedbackItemsForPR,
  fetchPullCloseState,
  fetchPullSummary,
  formatRepoSlug,
  GitHubIntegrationError,
  listFailingStatuses,
  listOpenPullsForRepo,
  parseRepoSlug,
  postFollowUpForFeedbackItem,
  postPRComment,
  postStatusReplyForFeedbackItem,
  resolveReviewThread,
  resolveGitHubAuthToken,
  updateStatusReply,
  APP_STATUS_COMMENT_PATTERN,
  type GitHubPullSummary,
  type GitHubStatusFailure,
  type ParsedPRUrl,
  type ParsedRepoSlug,
  type StatusReplyRef,
} from "./github";
import { CIHealingManager, isTerminalHealingState } from "./ciHealingManager";
import { classifyCIFailures, type ClassifiedCIFailure } from "./ciFailureClassifier";
import { isFailingCheckSnapshot } from "./ciCheckIngestor";
import { runCIHealingRepairAttempt } from "./ciHealingAgent";
import { childLogger } from "./logger";
import { getCodeFactoryPaths } from "./paths";

const log = childLogger("babysitter");
import { ensureRepoCache, preparePrWorktree, removePrWorktree, RepoCacheRecloneBlockedError } from "./repoWorkspace";
import { buildBackgroundJobDedupeKey, type ScheduleBackgroundJob } from "./backgroundJobQueue";
import { buildActivityPayload } from "./activityPayload";
import type { DeploymentHealingManager } from "./deploymentHealingManager";
import { detectDeploymentPlatform } from "./deploymentPlatformDetector";
import {
  applyEvaluationDecision,
  markInProgress,
  markResolved,
  markFailed,
  markRetry,
  markWarning,
  shouldResolveReviewConversation,
} from "./feedbackLifecycle";

const DEFAULT_GIT_USER_NAME = "PR Babysitter";
const DEFAULT_GIT_USER_EMAIL = "pr-babysitter@local";
const AGENT_HEALTH_CACHE_TTL_MS = 60_000;
const DEPENDENCY_PREFLIGHT_FAILURE_PREFIX = "Dependency preflight failed:";
const DEPENDENCY_PREFLIGHT_FAILURE_KIND = "dependency_preflight";
const CONFLICT_REPAIR_FAILURE_KIND = "merge_conflict_repair";
const NO_OP_CHECK_KIND = "no_op_check";
const CONFLICT_REPAIR_RETRY_BUDGET = 2;
const NO_OP_SUPPRESSION_COOLDOWN_MS = 5 * 60_000;
const CODE_OWNER_FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const AGENT_STREAM_LOG_LINE_LIMIT = 120;
const APP_NAME = "oh-my-pr";
const APP_REPOSITORY_URL = "https://github.com/yungookim/oh-my-pr";
export const APP_COMMENT_FOOTER = formatAppCommentFooter(APP_NAME, true);
const AUDIT_TOKEN_PATTERN = /\bcodefactory-feedback:[^\s<>()[\]{}"']+/g;

export class TerminalBabysitterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalBabysitterError";
  }
}

type GitHubService = {
  addReactionToComment: typeof addReactionToComment;
  buildOctokit: typeof buildOctokit;
  checkCISettled: typeof checkCISettled;
  fetchFeedbackItemsForPR: typeof fetchFeedbackItemsForPR;
  fetchPullCloseState?: typeof fetchPullCloseState;
  fetchPullSummary: typeof fetchPullSummary;
  fetchCheckSnapshotsForRef?: typeof fetchCheckSnapshotsForRef;
  getAuthenticatedLogin?: (octokit: Awaited<ReturnType<typeof buildOctokit>>) => Promise<string | null>;
  listFailingStatuses: typeof listFailingStatuses;
  listOpenPullsForRepo: typeof listOpenPullsForRepo;
  postFollowUpForFeedbackItem: typeof postFollowUpForFeedbackItem;
  postPRComment: typeof postPRComment;
  postStatusReplyForFeedbackItem: typeof postStatusReplyForFeedbackItem;
  resolveReviewThread: typeof resolveReviewThread;
  resolveGitHubAuthToken: typeof resolveGitHubAuthToken;
  updateStatusReply: typeof updateStatusReply;
};

type DeterministicFailureMarker = {
  kind: typeof DEPENDENCY_PREFLIGHT_FAILURE_KIND;
  headSha: string;
  reason: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
};

type ConflictRepairFailureMarker = {
  kind: typeof CONFLICT_REPAIR_FAILURE_KIND;
  headSha: string;
  baseRef: string;
  baseSha: string;
  conflictFiles: string[];
  reason: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
};

type CIFailureSummary = {
  totalFailures: number;
  contexts: Array<{
    context: string;
    count: number;
    targetUrls: string[];
  }>;
};

type NoOpCheckMarker = {
  kind: typeof NO_OP_CHECK_KIND;
  headSha: string;
  checkedAt: string;
};

type AgentHealthSelection = {
  agent: CodingAgent;
  fallbackFromAgent?: CodingAgent;
  fallbackReason?: string;
};

type BabysitterRuntime = {
  applyFixesWithAgent: typeof applyFixesWithAgent;
  checkAgentHealth?: typeof checkAgentHealth;
  checkDependencyPreflight?: (params: DependencyPreflightParams) => Promise<DependencyPreflightResult>;
  evaluateFixNecessityWithAgent: typeof evaluateFixNecessityWithAgent;
  resolveAgent: typeof resolveAgent;
  runCommand: typeof runCommand;
  runCIHealingRepairAttempt?: typeof runCIHealingRepairAttempt;
  ciPollIntervalMs?: number;
  now?: () => Date;
};

type DependencyPreflightParams = {
  cwd: string;
  pr: PR;
  pullSummary: GitHubPullSummary;
  requiresVerification: boolean;
  runCommand: typeof runCommand;
};

type DependencyPreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

type ReleaseManagerLike = {
  enqueueMergedPullReleaseEvaluation(input: {
    repo: string;
    baseBranch: string;
    triggerPrNumber: number;
    triggerPrTitle: string;
    triggerPrUrl: string;
    triggerMergeSha: string;
    triggerMergedAt: string;
  }): Promise<unknown>;
};

const defaultGitHubService: GitHubService = {
  addReactionToComment,
  buildOctokit,
  checkCISettled,
  fetchCheckSnapshotsForRef,
  fetchFeedbackItemsForPR,
  fetchPullCloseState,
  fetchPullSummary,
  getAuthenticatedLogin: async (octokit) => {
    const { data } = await octokit.rest.users.getAuthenticated();
    const login = data.login?.trim().toLowerCase();
    return login ? login : null;
  },
  listFailingStatuses,
  listOpenPullsForRepo,
  postFollowUpForFeedbackItem,
  postPRComment,
  postStatusReplyForFeedbackItem,
  resolveReviewThread,
  resolveGitHubAuthToken,
  updateStatusReply,
};

const defaultBabysitterRuntime: BabysitterRuntime = {
  applyFixesWithAgent,
  checkAgentHealth,
  checkDependencyPreflight,
  evaluateFixNecessityWithAgent,
  resolveAgent,
  runCommand,
  runCIHealingRepairAttempt,
};

const STATUS_MESSAGES = {
  accepted: "\u23f3 **Accepted** — this comment requires code changes. Queuing fix...",
  agentRunning: (agent: CodingAgent) => `\ud83e\uddf0 **Agent running** — \`${agent}\` is working on the fix...`,
  agentFailed: (agent: CodingAgent, reason?: string) => reason
    ? `\u274c **Agent failed** — \`${agent}\` exited with an error: ${reason}`
    : `\u274c **Agent failed** — \`${agent}\` exited with an error.`,
  agentCompleted: "\u2705 **Agent completed** — verifying changes...",
  resolved: (headSha: string) => {
    const shortSha = headSha.trim().slice(0, 7);
    return shortSha
      ? `\ud83c\udf89 **Resolved** — addressed in commit \`${shortSha}\`.`
      : "\ud83c\udf89 **Resolved** — addressed in the latest babysitter run.";
  },
} as const;

function countDecisions(items: FeedbackItem[]): {
  accepted: number;
  rejected: number;
  flagged: number;
} {
  return {
    accepted: items.filter((item) => item.decision === "accept").length,
    rejected: items.filter((item) => item.decision === "reject").length,
    flagged: items.filter((item) => item.decision === "flag").length,
  };
}

function mergeFeedbackItems(existing: FeedbackItem[], incoming: FeedbackItem[]): { merged: FeedbackItem[]; newCount: number } {
  const previousById = new Map(existing.map((item) => [item.id, item]));
  let newCount = 0;

  const merged = incoming.map((item) => {
    const previous = previousById.get(item.id);
    if (!previous) {
      newCount += 1;
      return item;
    }

    // Preserve triage decisions, action annotations, and lifecycle status across refreshes.
    return {
      ...item,
      decision: previous.decision,
      decisionReason: previous.decisionReason,
      action: previous.action,
      status: previous.status,
      statusReason: previous.statusReason,
    };
  });

  // Keep historical items that are no longer returned by API to avoid losing manual triage context.
  for (const item of existing) {
    if (!merged.find((candidate) => candidate.id === item.id)) {
      merged.push(item);
    }
  }

  merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return { merged, newCount };
}

function hasMissingReviewThreadMetadata(pr: PR): boolean {
  return pr.feedbackItems.some((item) =>
    item.replyKind === "review_thread" && (item.threadId === null || item.threadResolved === null),
  );
}

function formatFeedbackSyncLogMessage(total: number, newCount: number): string {
  const suffix = total === 1 ? "" : "s";
  return `GitHub sync complete: ${total} feedback item${suffix} (${newCount} new)`;
}

function buildCommentEvaluationPrompt(params: {
  pr: PR;
  item: FeedbackItem;
}): string {
  const { pr, item } = params;

  return [
    "You are deciding whether a PR comment requires code changes.",
    "Return JSON only.",
    `Repository: ${pr.repo}`,
    `PR: #${pr.number}`,
    `Comment author: ${item.author}`,
    `Comment type: ${item.type}`,
    `File: ${item.file || "n/a"}`,
    `Line: ${item.line ?? "n/a"}`,
    "Comment:",
    item.body,
    "Decision rule:",
    "- needsFix=true only when concrete code changes are required.",
    "- needsFix=false for acknowledgements, compliments, or non-actionable statements.",
  ].join("\n");
}

function buildStatusEvaluationPrompt(params: {
  pr: PR;
  context: string;
  description: string;
  targetUrl: string | null;
}): string {
  const { pr, context, description, targetUrl } = params;

  return [
    "You are deciding whether a failing CI status should trigger automated code changes.",
    "Return JSON only.",
    `Repository: ${pr.repo}`,
    `PR: #${pr.number}`,
    `Status context: ${context}`,
    `Description: ${description}`,
    `Target URL: ${targetUrl || "n/a"}`,
    "Decision rule:",
    "- needsFix=true if this is likely caused by source code or project config that can be fixed in-branch.",
    "- needsFix=false if it is transient infra failure, flaky external system, or missing permissions/secrets.",
  ].join("\n");
}

function truncateForPrompt(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  return `${input.slice(0, maxChars)}\n... (truncated)`;
}

function buildDocumentationAssessmentPrompt(params: {
  pr: PR;
  pullSummary: GitHubPullSummary;
  changedFiles: string;
  diffStat: string;
  diffPreview: string;
}): string {
  const { pr, pullSummary, changedFiles, diffStat, diffPreview } = params;

  return [
    "You are deciding whether a pull request requires repository documentation updates.",
    "Return JSON only.",
    `Repository: ${pr.repo}`,
    `PR: #${pr.number}`,
    `PR title: ${pr.title}`,
    `Base branch: ${pullSummary.baseRef}`,
    `Head branch: ${pullSummary.headRef}`,
    "",
    "Changed files (git diff --name-only origin/base...HEAD):",
    truncateForPrompt(changedFiles || "None", 4000),
    "",
    "Diff stat (git diff --stat origin/base...HEAD):",
    truncateForPrompt(diffStat || "None", 4000),
    "",
    "Unified diff excerpt (git diff --unified=0 origin/base...HEAD):",
    truncateForPrompt(diffPreview || "None", 12000),
    "",
    "Decision rule:",
    "- needsFix=true only when docs should be updated in this PR branch.",
    "- needsFix=false when current docs are already accurate for these changes.",
    "- Consider README, setup docs, API docs, configuration docs, and operator docs based on repo conventions.",
    "- reason must briefly explain what docs should change (or why no docs change is needed).",
  ].join("\n");
}

function getCurrentHeadDocsAssessment(pr: PR, headSha: string): NonNullable<PR["docsAssessment"]> | null {
  const assessment = pr.docsAssessment;
  if (!assessment || assessment.headSha !== headSha) {
    return null;
  }

  return assessment;
}

function shouldAssessDocsForHead(pr: PR, headSha: string, enabled: boolean): boolean {
  if (!enabled) {
    return false;
  }

  const existing = getCurrentHeadDocsAssessment(pr, headSha);
  if (!existing) {
    return true;
  }

  return existing.status === "failed";
}

function buildConflictResolutionPrompt(params: {
  pr: PR;
  pullSummary: GitHubPullSummary;
  remoteName: string;
  conflictFiles: string[];
}): string {
  const { pr, pullSummary, remoteName, conflictFiles } = params;

  return [
    `You are acting as an autonomous PR babysitter for ${pr.repo} PR #${pr.number}.`,
    `PR URL: ${pr.url}`,
    `Base repository: ${pullSummary.repoFullName}`,
    `Head repository: ${pullSummary.headRepoFullName}`,
    `Head branch: ${pullSummary.headRef}`,
    `Base branch: ${pullSummary.baseRef}`,
    `Head remote: ${remoteName}`,
    "You are running inside an isolated app-owned worktree under ~/.oh-my-pr.",
    "",
    "A merge from the base branch into the head branch has been started but has conflicts.",
    "The following files have merge conflicts:",
    ...conflictFiles.map((f) => `  - ${f}`),
    "",
    "Your task:",
    "1) Resolve ALL merge conflicts in the listed files.",
    "2) Preserve the intent of both the base branch and head branch changes.",
    "3) When in doubt, prefer the head branch (PR) changes, since that is the author's work.",
    "4) Leave the resolved files in the worktree. The babysitter app will handle Git finalization.",
    "5) Do not stage files, create commits, or push branches.",
    "6) Summarize what you resolved in your final response.",
    "",
    "Do not wait for user input, confirmation, or approval at any point.",
    "Do not rewrite unrelated files.",
    "Use the available git tooling for inspection and verification only.",
  ].join("\n");
}

function buildAgentFixPrompt(params: {
  pr: PR;
  pullSummary: GitHubPullSummary;
  remoteName: string;
  commentTasks: FeedbackItem[];
  statusTasks: { context: string; description: string; targetUrl: string | null }[];
  docsTaskSummary: string | null;
}): string {
  const { pr, pullSummary, remoteName, commentTasks, statusTasks, docsTaskSummary } = params;

  const commentSection = commentTasks.length
    ? commentTasks
        .map((item, index) => {
          return [
            `${index + 1}. [${item.type}] ${item.author}`,
            `   file=${item.file || "n/a"} line=${item.line ?? "n/a"}`,
            `   sourceId=${item.sourceId} sourceUrl=${item.sourceUrl || "n/a"}`,
            `   replyKind=${item.replyKind} threadId=${item.threadId || "n/a"} threadResolved=${item.threadResolved ?? "n/a"}`,
            `   auditToken=${item.auditToken}`,
            `   ${item.body}`,
          ].join("\n");
        })
        .join("\n")
    : "None";

  const statusSection = statusTasks.length
    ? statusTasks
        .map((status, index) => {
          return `${index + 1}. ${status.context}: ${status.description}${status.targetUrl ? ` (${status.targetUrl})` : ""}`;
        })
        .join("\n")
    : "None";

  const docsSection = docsTaskSummary
    ? [
        "Documentation updates are required for this PR.",
        `Assessment summary: ${docsTaskSummary}`,
        "Update the appropriate repository documentation for these changes.",
        "Choose the right docs files for this repository (for example README, docs pages, API/config/operator docs).",
        "If, after inspection, the repository documentation is already accurate or there is no appropriate docs target, leave docs unchanged and report that using the docs summary block with `no_change`.",
      ].join("\n")
    : "None";

  return [
    `You are acting as an autonomous PR babysitter for ${pr.repo} PR #${pr.number}.`,
    `PR URL: ${pr.url}`,
    `Base repository: ${pullSummary.repoFullName}`,
    `Head repository: ${pullSummary.headRepoFullName}`,
    `Head branch: ${pullSummary.headRef}`,
    `Head remote: ${remoteName}`,
    "You are running inside an isolated app-owned worktree under ~/.oh-my-pr.",
    "Make only targeted changes that resolve the approved tasks.",
    "Do not wait for user input, confirmation, or approval at any point.",
    "Do not rewrite unrelated files.",
    "Use the available git tooling for inspection and verification only.",
    "If dependencies are missing, install them using the repository's lockfile/package manager as needed inside this isolated worktree.",
    "Leave file edits uncommitted; the babysitter app will handle Git finalization after your run.",
    "GitHub follow-up replies and review-thread resolution will be handled by the babysitter after your run.",
    "If a task is invalid after inspection, explain it in your final response and include the exact audit token.",
    "",
    "Approved review-comment tasks:",
    commentSection,
    "",
    "Approved status-check tasks:",
    statusSection,
    "",
    "Approved documentation tasks:",
    docsSection,
    "",
    "When done:",
    "1) Run the relevant verification for your changes.",
    "2) Leave any changed files in the worktree for the babysitter app to finalize.",
    "3) For each feedback item you addressed or were blocked on, emit a summary block in the following format:",
    "   FEEDBACK_SUMMARY_START <auditToken>",
    "   <A concise 1-2 sentence summary of what you did or why you were blocked>",
    "   FEEDBACK_SUMMARY_END",
    "   Include one block per audit token. These summaries will be posted as follow-up comments on the PR.",
    "4) If documentation tasks were assigned, emit exactly one docs summary block in the following format:",
    "   DOCS_SUMMARY_START <changed|no_change>",
    "   <A concise 1-2 sentence summary of the docs you updated, or why no docs changes were necessary after inspection>",
    "   DOCS_SUMMARY_END",
  ].join("\n");
}

function buildCodeOwnerFallbackPrompt(params: {
  pr: PR;
  pullSummary: GitHubPullSummary;
  remoteName: string;
}): string {
  const { pr, pullSummary, remoteName } = params;

  return [
    pr.url,
    "",
    "You are acting as code owner of this pull request.",
    "",
    "Context:",
    `- Base repository: ${pullSummary.repoFullName}`,
    `- Head repository: ${pullSummary.headRepoFullName}`,
    `- Head branch: ${pullSummary.headRef}`,
    `- Head remote: ${remoteName}`,
    "- You are already inside an isolated app-owned worktree under ~/.oh-my-pr, checked out at the current PR head.",
    "- Do not operate outside this worktree.",
    "- Review the latest PR review comments, unresolved review threads, issue comments, and failing checks.",
    "- Treat reviewer feedback as actionable by default, but validate it against the current code before changing anything. You can reject the feedback if it's not a valid feedback.",
    "",
    "Task:",
    "1. Fetch and inspect the current PR state.",
    "2. For each review comment/thread:",
    "   - Accept it if it identifies a real bug, missing requirement, unclear code, test gap, maintainability issue, security issue, or reasonable requested cleanup.",
    "   - Reject it only if it is factually incorrect, already fixed in the current PR head, conflicts with product requirements, would introduce a regression, or is outside the PR scope.",
    "   - If uncertain, prefer a minimal safe fix or leave a clear explanation instead of guessing.",
    "3. For accepted feedback:",
    "   - Make the smallest correct code change.",
    "   - Avoid unrelated refactors.",
    "   - Add or update focused tests when behavior changes.",
    "   - Run the relevant verification commands.",
    "4. For rejected feedback:",
    "   - Do not change code just to satisfy an invalid request.",
    "   - Reply with a concise explanation grounded in the current code or requirements.",
    "5. When a thread is handled:",
    "   - Reply directly to the GitHub comment/thread with what was done, or why it was rejected.",
    "   - Resolve the GitHub conversation after replying.",
    "   - If the item is not a resolvable review thread, leave the reply/comment and note that there was no thread to resolve.",
    "6. When all valid feedback is handled:",
    "   - Confirm the worktree is clean except for intended changes.",
    "   - Commit changes if any were made.",
    `   - Push to the PR branch with \`git push ${remoteName} HEAD:${pullSummary.headRef}\`, not main.`,
    "   - Report the commit SHA, verification commands run, and the disposition of every reviewed comment.",
    "",
    "Rules:",
    "- Never mark feedback complete without proof: code inspection, tests, or a clear factual reason.",
    "- Do not resolve a conversation silently.",
    "- Do not batch vague replies like \"fixed\"; each reply should say what changed.",
    "- Do not overwrite unrelated user changes.",
    "- If GitHub permissions, tests, or push fail, stop and report the exact blocker with the comments already handled.",
  ].join("\n");
}

function extractMentionedAuditTokens(body: string): string[] {
  const matches = body.match(AUDIT_TOKEN_PATTERN);
  if (!matches) {
    return [];
  }

  return Array.from(new Set(matches));
}

const FEEDBACK_SUMMARY_BLOCK = /FEEDBACK_SUMMARY_START\s+(codefactory-feedback:[^\s]+)\s*\n([\s\S]*?)FEEDBACK_SUMMARY_END/g;
const DOCS_SUMMARY_BLOCK = /DOCS_SUMMARY_START\s+(changed|no_change)\s*\n([\s\S]*?)DOCS_SUMMARY_END/;

type DocsTaskOutcome = {
  outcome: "changed" | "no_change";
  summary: string;
};

function extractAgentSummaries(agentOutput: string): Map<string, string> {
  const summaries = new Map<string, string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(FEEDBACK_SUMMARY_BLOCK.source, FEEDBACK_SUMMARY_BLOCK.flags);
  while ((match = pattern.exec(agentOutput)) !== null) {
    const auditToken = match[1];
    const summary = match[2].trim();
    if (auditToken && summary) {
      summaries.set(auditToken, summary);
    }
  }
  return summaries;
}

function extractDocsTaskOutcome(agentOutput: string): DocsTaskOutcome | null {
  const match = DOCS_SUMMARY_BLOCK.exec(agentOutput);
  if (!match) {
    return null;
  }

  const outcome = match[1];
  const summary = match[2]?.trim();
  if (!summary || (outcome !== "changed" && outcome !== "no_change")) {
    return null;
  }

  return {
    outcome,
    summary,
  };
}

function isAutomationAuditTrailFollowUp(item: FeedbackItem, feedbackItems: FeedbackItem[]): boolean {
  const mentionedTokens = extractMentionedAuditTokens(item.body).filter((token) => token !== item.auditToken);
  if (mentionedTokens.length === 0) {
    return false;
  }

  const itemCreatedAtMs = new Date(item.createdAt).getTime();

  return mentionedTokens.some((token) =>
    feedbackItems.some((candidate) => {
      if (candidate.id === item.id || candidate.auditToken !== token) {
        return false;
      }

      const candidateCreatedAtMs = new Date(candidate.createdAt).getTime();
      if (Number.isNaN(itemCreatedAtMs) || Number.isNaN(candidateCreatedAtMs)) {
        return false;
      }

      return candidateCreatedAtMs <= itemCreatedAtMs;
    })
  );
}

function hasAuditTrail(
  item: FeedbackItem,
  feedbackItems: FeedbackItem[],
  runStartedAtMs?: number,
): boolean {
  return feedbackItems.some((candidate) => {
    if (candidate.id === item.id || !candidate.body.includes(item.auditToken)) {
      return false;
    }

    if (item.replyKind === "review_thread") {
      if (!item.threadId || candidate.threadId !== item.threadId) {
        return false;
      }
    }

    const createdAtMs = new Date(candidate.createdAt).getTime();
    if (Number.isNaN(createdAtMs)) {
      return false;
    }

    if (typeof runStartedAtMs === "number") {
      return createdAtMs >= runStartedAtMs;
    }

    return true;
  });
}

function looksLikeStatusReply(body: string): boolean {
  return APP_STATUS_COMMENT_PATTERN.test(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDependencyPreflightFailure(metadata: AgentRun["metadata"]): DeterministicFailureMarker | null {
  const marker = metadata?.deterministicFailure;
  if (isRecord(marker)
    && marker.kind === DEPENDENCY_PREFLIGHT_FAILURE_KIND
    && typeof marker.headSha === "string"
    && typeof marker.reason === "string"
  ) {
    return {
      kind: DEPENDENCY_PREFLIGHT_FAILURE_KIND,
      headSha: marker.headSha,
      reason: marker.reason,
      firstSeenAt: typeof marker.firstSeenAt === "string" ? marker.firstSeenAt : "",
      lastSeenAt: typeof marker.lastSeenAt === "string" ? marker.lastSeenAt : "",
      count: typeof marker.count === "number" ? marker.count : 1,
    };
  }

  return null;
}

function normalizeConflictFiles(files: string[]): string[] {
  return Array.from(new Set(files.map((file) => file.trim()).filter(Boolean))).sort();
}

async function findFilesWithConflictMarkers(
  runGitCommand: typeof runCommand,
  worktreePath: string,
  files: string[],
): Promise<string[]> {
  const normalizedFiles = normalizeConflictFiles(files);
  if (normalizedFiles.length === 0) {
    return [];
  }

  const markerPattern = "^(<<<<<<<|=======|>>>>>>>|\\|\\|\\|\\|\\|\\|\\|)";
  const result = await runGitCommand(
    "git",
    ["grep", "-z", "-l", "-I", "-E", markerPattern, "--", ...normalizedFiles],
    {
      cwd: worktreePath,
      timeoutMs: 5000,
    },
  );
  if (result.code === 1) {
    return [];
  }
  if (result.code !== 0) {
    throw new Error(formatGitFailure("checking merge conflict markers", result));
  }

  return normalizeConflictFiles(result.stdout.split("\0"));
}

function buildTerminalConflictRepairReason(params: {
  conflictFiles: string[];
  headSha: string;
  baseRef: string;
  baseSha: string;
  lastReason?: string;
}): string {
  const headLabel = params.headSha ? params.headSha.slice(0, 7) : "unknown head";
  const baseLabel = params.baseSha
    ? `${params.baseRef} (${params.baseSha.slice(0, 7)})`
    : params.baseRef || "unknown base";
  const files = params.conflictFiles.length > 0 ? params.conflictFiles.join(", ") : "the same conflict paths";
  const suffix = params.lastReason ? ` Last failure: ${params.lastReason}` : "";
  return `Merge conflict repair failed twice for ${files} at head ${headLabel} against base ${baseLabel}; stopping automatic babysitter runs until the PR head or base changes.${suffix}`;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readConflictRepairFailure(metadata: AgentRun["metadata"]): ConflictRepairFailureMarker | null {
  const marker = metadata?.conflictRepairFailure;
  if (!isRecord(marker)
    || marker.kind !== CONFLICT_REPAIR_FAILURE_KIND
    || typeof marker.headSha !== "string"
    || typeof marker.baseRef !== "string"
    || typeof marker.baseSha !== "string"
    || typeof marker.reason !== "string"
    || !Array.isArray(marker.conflictFiles)
  ) {
    return null;
  }

  return {
    kind: CONFLICT_REPAIR_FAILURE_KIND,
    headSha: marker.headSha,
    baseRef: marker.baseRef,
    baseSha: marker.baseSha,
    conflictFiles: normalizeConflictFiles(marker.conflictFiles.filter((file): file is string => typeof file === "string")),
    reason: marker.reason,
    firstSeenAt: typeof marker.firstSeenAt === "string" ? marker.firstSeenAt : "",
    lastSeenAt: typeof marker.lastSeenAt === "string" ? marker.lastSeenAt : "",
    count: typeof marker.count === "number" ? marker.count : 1,
  };
}

function readNoOpCheck(metadata: AgentRun["metadata"]): NoOpCheckMarker | null {
  const marker = metadata?.noOpCheck;
  if (isRecord(marker)
    && marker.kind === NO_OP_CHECK_KIND
    && typeof marker.headSha === "string"
    && typeof marker.checkedAt === "string"
  ) {
    return {
      kind: NO_OP_CHECK_KIND,
      headSha: marker.headSha,
      checkedAt: marker.checkedAt,
    };
  }

  return null;
}

function isDependencyPreflightFailureMessage(message: string): boolean {
  return message.trim().startsWith(DEPENDENCY_PREFLIGHT_FAILURE_PREFIX);
}

function readStatusReplyRefs(metadata: AgentRun["metadata"]): Record<string, StatusReplyRef> {
  const raw = metadata?.statusReplyRefs;
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const refs: Record<string, StatusReplyRef> = {};
  for (const [feedbackId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const candidate = value as Partial<StatusReplyRef>;
    if (
      typeof candidate.commentDatabaseId === "number"
      && (candidate.replyKind === "review_thread" || candidate.replyKind === "review" || candidate.replyKind === "general_comment")
      && typeof candidate.body === "string"
    ) {
      refs[feedbackId] = {
        commentDatabaseId: candidate.commentDatabaseId,
        replyKind: candidate.replyKind,
        body: candidate.body,
      };
    }
  }

  return refs;
}

function findStatusReplyRefForFeedback(item: FeedbackItem, feedbackItems: FeedbackItem[]): StatusReplyRef | null {
  for (const candidate of feedbackItems) {
    if (candidate.id === item.id || !looksLikeStatusReply(candidate.body)) {
      continue;
    }

    const commentDatabaseId = Number(candidate.sourceId);
    if (!Number.isFinite(commentDatabaseId)) {
      continue;
    }

    if (item.replyKind === "review_thread") {
      if (candidate.type !== "review_comment" || !item.threadId || candidate.threadId !== item.threadId) {
        continue;
      }

      return {
        commentDatabaseId,
        replyKind: "review_thread",
        body: candidate.body,
      };
    }

    if (candidate.type === "general_comment") {
      return {
        commentDatabaseId,
        replyKind: item.replyKind,
        body: candidate.body,
      };
    }
  }

  return null;
}

function collectAuditTrailErrors(params: {
  pr: PR;
  followUpTasks: FeedbackItem[];
  runStartedAtMs: number;
}): string[] {
  const { pr, followUpTasks, runStartedAtMs } = params;
  const errors: string[] = [];

  for (const item of followUpTasks) {
    if (!hasAuditTrail(item, pr.feedbackItems, runStartedAtMs)) {
      errors.push(`missing audit trail for ${item.id}`);
    }

    if (item.replyKind === "review_thread") {
      const refreshed = pr.feedbackItems.find((candidate) => candidate.id === item.id);
      if (!refreshed?.threadResolved) {
        errors.push(`review thread not resolved for ${item.id}`);
      }
    }
  }

  return errors;
}

function needsGitHubFollowUp(item: FeedbackItem, feedbackItems: FeedbackItem[]): boolean {
  if (item.decision !== "accept") {
    return false;
  }

  if (item.status !== "queued" && item.status !== "in_progress") {
    return false;
  }

  if (!hasAuditTrail(item, feedbackItems)) {
    return true;
  }

  return shouldResolveReviewConversation(markResolved(item));
}

function collectGitHubFollowUpTasks(pr: PR): FeedbackItem[] {
  return pr.feedbackItems.filter((item) => needsGitHubFollowUp(item, pr.feedbackItems));
}

function snapshotIdentity(snapshot: CheckSnapshot): string {
  return [
    snapshot.prId,
    snapshot.sha,
    snapshot.provider,
    snapshot.context,
    snapshot.status,
    snapshot.conclusion || "",
    snapshot.description,
    snapshot.targetUrl || "",
  ].join("|");
}

function summarizePendingChecks(snapshots: CheckSnapshot[]): Array<{
  context: string;
  status: string;
  conclusion: string | null;
  description: string;
  targetUrl: string | null;
}> {
  return snapshots
    .filter((snapshot) => snapshot.status !== "completed" || snapshot.conclusion === null)
    .map((snapshot) => ({
      context: snapshot.context,
      status: snapshot.status,
      conclusion: snapshot.conclusion,
      description: snapshot.description,
      targetUrl: snapshot.targetUrl,
    }))
    .sort((a, b) => a.context.localeCompare(b.context));
}

function summarizeCIFailures(failures: GitHubStatusFailure[]): CIFailureSummary {
  const byContext = new Map<string, { count: number; targetUrls: Set<string> }>();

  for (const failure of failures) {
    const current = byContext.get(failure.context) ?? { count: 0, targetUrls: new Set<string>() };
    current.count += 1;
    if (failure.targetUrl) {
      current.targetUrls.add(failure.targetUrl);
    }
    byContext.set(failure.context, current);
  }

  return {
    totalFailures: failures.length,
    contexts: Array.from(byContext.entries())
      .map(([context, summary]) => ({
        context,
        count: summary.count,
        targetUrls: Array.from(summary.targetUrls).sort(),
      }))
      .sort((a, b) => a.context.localeCompare(b.context)),
  };
}

function repoCacheTelemetry(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof RepoCacheRecloneBlockedError)) {
    return null;
  }

  return {
    kind: "repo_cache_reclone_blocked",
    reason: error.reason,
    repoCacheDir: error.repoCacheDir,
    activeWorkspaceCount: error.activeWorkspaceCount,
    registeredWorktreeCount: error.registeredWorktreeCount,
  };
}

async function persistCheckSnapshotsIfMissing(storage: IStorage, snapshots: CheckSnapshot[]): Promise<void> {
  if (snapshots.length === 0) {
    return;
  }

  const existing = await storage.listCheckSnapshots({
    prId: snapshots[0].prId,
    sha: snapshots[0].sha,
  });
  const seen = new Set(existing.map((snapshot) => snapshotIdentity(snapshot)));

  for (const snapshot of snapshots) {
    const identity = snapshotIdentity(snapshot);
    if (seen.has(identity)) {
      continue;
    }

    const { id: _snapshotId, ...snapshotData } = snapshot;
    await storage.createCheckSnapshot(snapshotData);
    seen.add(identity);
  }
}

async function persistFailureFingerprintsIfMissing(
  storage: IStorage,
  sessionId: string,
  sha: string,
  failures: ClassifiedCIFailure[],
): Promise<void> {
  const existing = await storage.listFailureFingerprints({ sessionId, sha });
  const seen = new Set(existing.map((fingerprint) => fingerprint.fingerprint));

  for (const failure of failures) {
    if (seen.has(failure.fingerprint)) {
      continue;
    }

    await storage.createFailureFingerprint({
      sessionId,
      sha,
      fingerprint: failure.fingerprint,
      category: failure.category,
      classification: failure.classification,
      summary: failure.summary,
      selectedEvidence: failure.selectedEvidence,
    });
    seen.add(failure.fingerprint);
  }
}

function computeHealingImprovementScore(
  targetFingerprints: string[],
  currentFailures: ClassifiedCIFailure[],
): {
  removedTargetFingerprints: string[];
  remainingTargetFingerprints: string[];
  newUnrelatedFingerprints: string[];
  improvementScore: number;
} {
  const targetSet = new Set(targetFingerprints);
  const currentSet = new Set(currentFailures.map((failure) => failure.fingerprint));

  const removedTargetFingerprints = targetFingerprints.filter((fingerprint) => !currentSet.has(fingerprint));
  const remainingTargetFingerprints = targetFingerprints.filter((fingerprint) => currentSet.has(fingerprint));
  const newUnrelatedFingerprints = currentFailures
    .map((failure) => failure.fingerprint)
    .filter((fingerprint) => !targetSet.has(fingerprint));

  const improvementScore = (removedTargetFingerprints.length * 2)
    - (remainingTargetFingerprints.length * 2)
    - (newUnrelatedFingerprints.length * 3);

  return {
    removedTargetFingerprints,
    remainingTargetFingerprints,
    newUnrelatedFingerprints,
    improvementScore,
  };
}

function formatAppName(githubCommentAppName: string, includeRepositoryLinksInGitHubComments: boolean): string {
  const appName = githubCommentAppName.trim();
  if (!appName) {
    return "";
  }

  return includeRepositoryLinksInGitHubComments ? `[${appName}](${APP_REPOSITORY_URL})` : appName;
}

export function formatAppCommentFooter(
  githubCommentAppName: string,
  includeRepositoryLinksInGitHubComments: boolean,
): string {
  const appName = formatAppName(githubCommentAppName, includeRepositoryLinksInGitHubComments);
  return appName ? `Posted by ${appName}` : "";
}

function formatIncludedAppCommentFooter(
  includeRepositoryLinksInGitHubComments: boolean,
  githubCommentAppName: string,
): string {
  return includeRepositoryLinksInGitHubComments
    ? formatAppCommentFooter(githubCommentAppName, includeRepositoryLinksInGitHubComments)
    : "";
}

function buildFeedbackFollowUpBody(
  headSha: string,
  item: FeedbackItem,
  includeRepositoryLinksInGitHubComments: boolean,
  githubCommentAppName: string,
  agentSummary?: string,
): string {
  const shortSha = headSha.trim() ? headSha.trim().slice(0, 7) : "";
  const headline = shortSha
    ? `Addressed in commit \`${shortSha}\` by the latest babysitter run.`
    : "Addressed in the latest babysitter run.";

  const parts = [headline];

  // For non-review-thread items the follow-up is posted as a top-level PR
  // comment, so include a reference to the original comment for a clear audit
  // trail linking the fix back to the feedback.
  if (item.replyKind !== "review_thread" && item.sourceUrl) {
    const firstLine = (item.body || "").split("\n")[0] || "";
    const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
    parts.push(
      "",
      `> Responding to [comment by @${item.author}](${item.sourceUrl}):`,
      `> ${preview}`,
    );
  }

  if (agentSummary) {
    parts.push("", agentSummary);
  }

  parts.push("", `<!-- ${item.auditToken} -->`);
  const footer = formatIncludedAppCommentFooter(
    includeRepositoryLinksInGitHubComments,
    githubCommentAppName,
  );
  if (footer) {
    parts.push("", footer);
  }

  return parts.join("\n");
}

const CODEFACTORY_COMMENT_MARKER = "<!-- codefactory-agent-command -->";

function buildCodeFence(content: string): { open: string; close: string } {
  let maxRun = 0;
  const backtickRuns = content.match(/`{3,}/g);
  if (backtickRuns) {
    for (const run of backtickRuns) {
      if (run.length > maxRun) maxRun = run.length;
    }
  }
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return { open: `${fence}text`, close: fence };
}

function isCodeFactoryComment(body: string): boolean {
  return body.includes(CODEFACTORY_COMMENT_MARKER);
}

export function formatAgentCommandGitHubComment(
  agent: CodingAgent,
  prompt: string,
  includeRepositoryLinksInGitHubComments: boolean,
  githubCommentAppName: string,
): string {
  const fence = buildCodeFence(prompt);
  const appName = formatAppName(githubCommentAppName, includeRepositoryLinksInGitHubComments);
  const footer = formatIncludedAppCommentFooter(
    includeRepositoryLinksInGitHubComments,
    githubCommentAppName,
  );
  return [
    CODEFACTORY_COMMENT_MARKER,
    appName
      ? `\ud83e\udd16 **${appName}** dispatched \`${agent}\` with the following prompt:`
      : `\ud83e\udd16 Dispatched \`${agent}\` with the following prompt:`,
    "",
    "<details>",
    "<summary>Agent prompt (click to expand)</summary>",
    "",
    fence.open,
    prompt,
    fence.close,
    "",
    "</details>",
    ...(footer ? ["", footer] : []),
  ].join("\n");
}

function appendStatusLine(
  existingBody: string,
  line: string,
  includeRepositoryLinksInGitHubComments: boolean,
  githubCommentAppName: string,
): string {
  const footer = formatIncludedAppCommentFooter(
    includeRepositoryLinksInGitHubComments,
    githubCommentAppName,
  );
  const { bodyWithoutFooter, hadFooter } = splitAppCommentFooter(existingBody, footer);
  const nextBody = bodyWithoutFooter ? `${bodyWithoutFooter}\n${line}` : line;
  return hadFooter && footer ? `${nextBody}\n\n${footer}` : nextBody;
}

function splitAppCommentFooter(body: string, footer: string): { bodyWithoutFooter: string; hadFooter: boolean } {
  const trimmedBody = body.trimEnd();
  const possibleFooters = [
    footer,
    APP_COMMENT_FOOTER,
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

  for (const possibleFooter of possibleFooters) {
    if (trimmedBody === possibleFooter) {
      return { bodyWithoutFooter: "", hadFooter: true };
    }

    const suffix = "\n\n" + possibleFooter;
    if (trimmedBody.endsWith(suffix)) {
      return { bodyWithoutFooter: trimmedBody.slice(0, -suffix.length), hadFooter: true };
    }
  }

  const linkedFooterPattern = /\n\nPosted by \[[^\]\n]+\]\(https:\/\/github\.com\/yungookim\/oh-my-pr\)$/;
  const linkedFooterMatch = trimmedBody.match(linkedFooterPattern);
  if (linkedFooterMatch?.index !== undefined) {
    return { bodyWithoutFooter: trimmedBody.slice(0, linkedFooterMatch.index), hadFooter: true };
  }

  return { bodyWithoutFooter: body, hadFooter: false };
}

function withOptionalAppCommentFooter(
  body: string,
  includeRepositoryLinksInGitHubComments: boolean,
  githubCommentAppName: string,
): string {
  const footer = formatIncludedAppCommentFooter(
    includeRepositoryLinksInGitHubComments,
    githubCommentAppName,
  );
  if (!footer) {
    return body;
  }

  const { bodyWithoutFooter } = splitAppCommentFooter(body, footer);
  return bodyWithoutFooter ? `${bodyWithoutFooter}\n\n${footer}` : footer;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function summarizeCommandFailure(result: Awaited<ReturnType<typeof runCommand>>): string {
  return result.stderr.trim() || result.stdout.trim() || "no output";
}

function isGitInfrastructureFailure(message: string): boolean {
  return /\b(Could not resolve host|ENOTFOUND|EAI_AGAIN|ECONNRESET|network error|Failed to connect|Connection timed out)\b/i.test(message);
}

function formatGitFailure(context: string, result: Awaited<ReturnType<typeof runCommand>>): string {
  const summary = summarizeCommandFailure(result);
  return isGitInfrastructureFailure(summary)
    ? `Infrastructure Git failure while ${context}: ${summary}`
    : `${context} failed: ${summary}`;
}

function summarizeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyFeedbackSyncError(error: unknown): "auth" | "rate_limit" | "network" | "not_found" | "unknown" {
  const message = summarizeUnknownError(error).toLowerCase();
  if (/\b(401|unauthor|forbidden|bad credentials|authentication|token)\b/.test(message)) {
    return "auth";
  }
  if (/\b(rate limit|abuse detection|secondary rate|429)\b/.test(message)) {
    return "rate_limit";
  }
  if (/\b(404|not found)\b/.test(message)) {
    return "not_found";
  }
  if (/\b(econnreset|enotfound|eai_again|network|timeout|timed out|fetch failed|socket hang up)\b/.test(message)) {
    return "network";
  }
  return "unknown";
}

function getNextCodingAgent(agent: CodingAgent): CodingAgent {
  return agent === "claude" ? "codex" : "claude";
}

function formatConciseFailureReason(message: string): string {
  const detail = message
    .replace(/^(?:claude|codex|agent) apply failed \(\d+\):\s*/i, "")
    .replace(/^Agent failed to resolve merge conflicts \(\d+\):\s*/i, "")
    .replace(/^Error:\s*/i, "");
  const firstLine = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !STDIN_PRELUDE_PATTERN.test(line))
    ?? "No failure details were reported";
  const singleLine = firstLine.replace(/\s+/g, " ");
  const capped = singleLine.length > 180 ? `${singleLine.slice(0, 177).trimEnd()}...` : singleLine;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function drainChunkLines(buffer: string, chunk: string): { lines: string[]; buffer: string } {
  const text = `${buffer}${chunk}`;
  const parts = text.split(/\r?\n/);
  return {
    lines: parts.slice(0, -1),
    buffer: parts.at(-1) ?? "",
  };
}

async function ensureGitIdentity(worktreePath: string, run: typeof runCommand): Promise<void> {
  const name = await run("git", ["config", "--get", "user.name"], { cwd: worktreePath, timeoutMs: 3000 });
  if (name.code !== 0 || !name.stdout.trim()) {
    await run("git", ["config", "user.name", DEFAULT_GIT_USER_NAME], { cwd: worktreePath, timeoutMs: 3000 });
  }

  const email = await run("git", ["config", "--get", "user.email"], { cwd: worktreePath, timeoutMs: 3000 });
  if (email.code !== 0 || !email.stdout.trim()) {
    await run("git", ["config", "user.email", DEFAULT_GIT_USER_EMAIL], { cwd: worktreePath, timeoutMs: 3000 });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

async function checkDependencyPreflight(params: DependencyPreflightParams): Promise<DependencyPreflightResult> {
  if (!params.requiresVerification) {
    return { ok: true };
  }

  const packageJsonPath = path.join(params.cwd, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return { ok: true };
  }

  const lockfiles = {
    packageLock: await pathExists(path.join(params.cwd, "package-lock.json")),
    npmShrinkwrap: await pathExists(path.join(params.cwd, "npm-shrinkwrap.json")),
    pnpmLock: await pathExists(path.join(params.cwd, "pnpm-lock.yaml")),
    yarnLock: await pathExists(path.join(params.cwd, "yarn.lock")),
  };

  if (!lockfiles.packageLock && !lockfiles.npmShrinkwrap && !lockfiles.pnpmLock && !lockfiles.yarnLock) {
    return { ok: true };
  }

  if (!(await pathExists(path.join(params.cwd, "node_modules")))) {
    const ignoreCheck = await params.runCommand("git", ["check-ignore", "-q", "node_modules/"], {
      cwd: params.cwd,
      timeoutMs: 5000,
    });
    if (ignoreCheck.code !== 0) {
      return {
        ok: false,
        reason: "Node dependency cache is missing, but node_modules is not ignored by git; refusing to install dependencies automatically",
      };
    }

    const installCommand = lockfiles.pnpmLock
      ? { command: "pnpm", args: ["install", "--frozen-lockfile"] }
      : lockfiles.yarnLock
        ? { command: "yarn", args: ["install", "--frozen-lockfile"] }
        : { command: "npm", args: ["ci"] };
    const result = await params.runCommand(installCommand.command, installCommand.args, {
      cwd: params.cwd,
      timeoutMs: 300000,
    });
    if (result.code !== 0) {
      return {
        ok: false,
        reason: summarizeCommandResult(result, `Dependency install failed while running ${installCommand.command} ${installCommand.args.join(" ")}`),
      };
    }
  }

  return { ok: true };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PRBabysitter {
  private readonly storage: IStorage;
  private readonly inProgress = new Map<string, {
    preferredAgent: CodingAgent;
    runId: string;
    startedAt: string;
  }>();
  private readonly feedbackMutationLocks = new Map<string, Promise<void>>();
  private readonly github: GitHubService;
  private readonly runtime: BabysitterRuntime;
  private readonly releaseManager?: ReleaseManagerLike;
  private readonly deploymentHealingManager?: DeploymentHealingManager;
  private readonly scheduleBackgroundJob?: ScheduleBackgroundJob;
  private readonly clock: () => Date;
  private readonly agentHealthCache = new Map<CodingAgent, { checkedAtMs: number; result: AgentHealthResult }>();

  constructor(
    storage: IStorage,
    github: GitHubService = defaultGitHubService,
    runtime: BabysitterRuntime = defaultBabysitterRuntime,
    releaseManager?: ReleaseManagerLike,
    scheduleBackgroundJob?: ScheduleBackgroundJob,
    deploymentHealingManager?: DeploymentHealingManager,
  ) {
    this.storage = storage;
    this.github = github;
    this.runtime = runtime;
    this.releaseManager = releaseManager;
    this.deploymentHealingManager = deploymentHealingManager;
    this.scheduleBackgroundJob = scheduleBackgroundJob;
    this.clock = runtime.now ?? (() => new Date());
  }

  private now(): Date {
    return this.clock();
  }

  private async findLatestDependencyPreflightFailure(prId: string, headSha: string): Promise<DeterministicFailureMarker | null> {
    const failedRuns = (await this.storage.listAgentRuns({ prId, status: "failed" }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    for (const run of failedRuns) {
      const marker = readDependencyPreflightFailure(run.metadata);
      const runHeadSha = marker?.headSha ?? run.initialHeadSha;
      if (runHeadSha !== headSha) {
        continue;
      }

      return marker?.kind === DEPENDENCY_PREFLIGHT_FAILURE_KIND ? marker : null;
    }

    return null;
  }

  private async countConflictRepairFailures(prId: string, headSha: string, baseSha: string, conflictFiles: string[]): Promise<number> {
    const normalizedFiles = normalizeConflictFiles(conflictFiles);
    const failedRuns = await this.storage.listAgentRuns({ prId, status: "failed" });
    return failedRuns.reduce((count, run) => {
      const marker = readConflictRepairFailure(run.metadata);
      if (!marker
        || marker.headSha !== headSha
        || marker.baseSha !== baseSha
        || !sameStrings(marker.conflictFiles, normalizedFiles)
      ) {
        return count;
      }

      return count + 1;
    }, 0);
  }

  private async findLatestConflictRepairFailure(
    prId: string,
    headSha: string,
    baseSha: string,
    conflictFiles: string[],
  ): Promise<ConflictRepairFailureMarker | null> {
    const normalizedFiles = normalizeConflictFiles(conflictFiles);
    const failedRuns = (await this.storage.listAgentRuns({ prId, status: "failed" }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    for (const run of failedRuns) {
      const marker = readConflictRepairFailure(run.metadata);
      if (!marker
        || marker.headSha !== headSha
        || marker.baseSha !== baseSha
        || !sameStrings(marker.conflictFiles, normalizedFiles)
      ) {
        continue;
      }

      return marker;
    }

    return null;
  }

  private async findTerminalConflictRepairFailureForHead(
    prId: string,
    headSha: string,
    baseSha: string,
  ): Promise<ConflictRepairFailureMarker | null> {
    const failedRuns = (await this.storage.listAgentRuns({ prId, status: "failed" }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const grouped = new Map<string, { marker: ConflictRepairFailureMarker; count: number }>();

    for (const run of failedRuns) {
      const marker = readConflictRepairFailure(run.metadata);
      if (!marker
        || marker.headSha !== headSha
        || marker.baseSha !== baseSha
      ) {
        continue;
      }

      const key = JSON.stringify(marker.conflictFiles);
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
        existing.marker = {
          ...existing.marker,
          count: Math.max(existing.marker.count, marker.count, existing.count),
        };
      } else {
        grouped.set(key, {
          marker,
          count: 1,
        });
      }
    }

    for (const group of Array.from(grouped.values())) {
      const count = Math.max(group.count, group.marker.count);
      if (count >= CONFLICT_REPAIR_RETRY_BUDGET) {
        return {
          ...group.marker,
          count,
        };
      }
    }

    return null;
  }

  private async findLatestNoOpCheck(prId: string, headSha: string): Promise<NoOpCheckMarker | null> {
    const matchingRuns = await this.storage.listAgentRuns({
      prId,
      status: "completed",
      initialHeadSha: headSha,
      orderBy: "updatedAt",
      order: "desc",
      limit: 1,
    });

    const latest = matchingRuns[0];
    if (!latest) {
      return null;
    }

    const marker = readNoOpCheck(latest.metadata);
    return marker?.kind === NO_OP_CHECK_KIND ? marker : null;
  }

  private async readAgentHealth(agent: CodingAgent): Promise<AgentHealthResult> {
    const nowMs = this.now().getTime();
    const cached = this.agentHealthCache.get(agent);
    if (cached && nowMs - cached.checkedAtMs < AGENT_HEALTH_CACHE_TTL_MS) {
      return cached.result;
    }

    const result = this.runtime.checkAgentHealth
      ? await this.runtime.checkAgentHealth(agent)
      : { ok: true } as AgentHealthResult;
    this.agentHealthCache.set(agent, { checkedAtMs: nowMs, result });
    return result;
  }

  private async pauseAutomationForAgentFailure(
    agent: CodingAgent,
    reason: string,
    prIds: string[],
    classification: AgentUnavailabilityKind,
  ): Promise<void> {
    const message = `Agent health check failed for ${agent}: ${reason}`;
    await this.storage.updateRuntimeState({
      drainMode: true,
      drainRequestedAt: this.now().toISOString(),
      drainReason: message,
    });

    await Promise.all(prIds.map(async (prId) => {
      const pr = await this.storage.getPR(prId);
      if (pr) {
        const updatedItems = pr.feedbackItems.map((item) =>
          item.decision === "accept" && (item.status === "queued" || item.status === "in_progress")
            ? markFailed(item, message)
            : item,
        );
        if (updatedItems.some((item, index) => item !== pr.feedbackItems[index])) {
          const counters = countDecisions(updatedItems);
          await this.storage.updatePR(pr.id, {
            feedbackItems: updatedItems,
            accepted: counters.accepted,
            rejected: counters.rejected,
            flagged: counters.flagged,
          });
        }
      }

      await this.storage.addLog(prId, "error", `Automation paused: ${message}`, {
        phase: "agent.health",
        metadata: { agent, classification },
      });
    }));
  }

  private async ensureAgentHealthy(
    agent: CodingAgent,
    prIds: string[],
    options: { allowFallback?: boolean } = {},
  ): Promise<AgentHealthSelection> {
    const health = await this.readAgentHealth(agent);
    if (health.ok) {
      return { agent };
    }

    const message = `Agent health check failed for ${agent}: ${health.reason}`;
    if (options.allowFallback) {
      const fallbackAgent = getNextCodingAgent(agent);
      const fallbackHealth = await this.readAgentHealth(fallbackAgent);
      if (fallbackHealth.ok) {
        await Promise.all(prIds.map(async (prId) => {
          await this.storage.addLog(prId, "warn", `Falling back from ${agent} to ${fallbackAgent} because ${agent} is not healthy: ${health.reason}`, {
            phase: "agent.health",
            metadata: {
              failedAgent: agent,
              fallbackAgent,
              fallbackReason: health.reason,
            },
          });
        }));
        return { agent: fallbackAgent, fallbackFromAgent: agent, fallbackReason: health.reason };
      }
    }

    const classification = detectAgentUnavailability(health.reason);
    if (classification !== null) {
      await this.pauseAutomationForAgentFailure(agent, health.reason, prIds, classification);
    } else {
      await Promise.all(prIds.map(async (prId) => {
        await this.storage.addLog(prId, "warn", `Automation skipped: ${message}`, {
          phase: "agent.health",
          metadata: { agent, classification: null },
        });
      }));
    }
    throw new Error(message);
  }

  private async supersedeActiveHealingSessionsForArchivedPr(prId: string): Promise<void> {
    const sessions = await this.storage.listHealingSessions({ prId });
    const endedAt = this.now().toISOString();

    for (const session of sessions) {
      if (isTerminalHealingState(session.state)) {
        continue;
      }

      await this.storage.updateHealingSession(session.id, {
        state: "superseded",
        endedAt,
        escalationReason: "PR archived on GitHub",
      });
    }
  }

  getActiveRunCount(): number {
    return this.inProgress.size;
  }

  async waitForIdle(timeoutMs = 120000): Promise<boolean> {
    const startedAt = Date.now();

    while (this.inProgress.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await wait(100);
    }

    return true;
  }

  async runQueuedBabysitPR(
    prId: string,
    preferredAgent: CodingAgent,
  ): Promise<void> {
    const interruptedRun = (await this.storage.listAgentRuns({ status: "running", prId }))
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

    if (!interruptedRun) {
      await this.babysitPR(prId, preferredAgent, {
        allowDuringDrain: true,
        rethrowOnFailure: true,
      });
      return;
    }

    const canReplay = Boolean(
      interruptedRun.prompt
      && interruptedRun.resolvedAgent
      && interruptedRun.initialHeadSha,
    );
    if (!canReplay) {
      const now = new Date().toISOString();
      await this.storage.upsertAgentRun({
        ...interruptedRun,
        status: "failed",
        phase: "run.failed",
        lastError: "Interrupted run missing replay context",
        updatedAt: now,
      });
      await this.babysitPR(prId, preferredAgent, {
        allowDuringDrain: true,
        rethrowOnFailure: true,
      });
      return;
    }

    await this.babysitPR(prId, interruptedRun.preferredAgent, {
      runId: interruptedRun.id,
      recoveryMode: true,
      forceAgentPrompt: interruptedRun.prompt,
      forceResolvedAgent: interruptedRun.resolvedAgent,
      replayInitialHeadSha: interruptedRun.initialHeadSha,
      allowDuringDrain: true,
      rethrowOnFailure: true,
    });
  }

  async resumeInterruptedRuns(): Promise<void> {
    const interruptedRuns = await this.storage.listAgentRuns({ status: "running" });
    if (interruptedRuns.length === 0) {
      return;
    }

    if (this.scheduleBackgroundJob) {
      const queuedPrIds = new Set<string>();

      for (const run of interruptedRuns) {
        if (queuedPrIds.has(run.prId)) {
          continue;
        }

        queuedPrIds.add(run.prId);
        await this.scheduleBackgroundJob(
          "babysit_pr",
          run.prId,
          buildBackgroundJobDedupeKey("babysit_pr", run.prId),
          { preferredAgent: run.preferredAgent },
        );
      }

      return;
    }

    for (const run of interruptedRuns) {
      const canReplay = Boolean(run.prompt && run.resolvedAgent && run.initialHeadSha);
      if (!canReplay) {
        const now = new Date().toISOString();
        await this.storage.upsertAgentRun({
          ...run,
          status: "failed",
          phase: "run.failed",
          lastError: "Interrupted run missing replay context",
          updatedAt: now,
        });
        await this.babysitPR(run.prId, run.preferredAgent, {
          allowDuringDrain: true,
        });
        continue;
      }

      await this.babysitPR(run.prId, run.preferredAgent, {
        runId: run.id,
        recoveryMode: true,
        forceAgentPrompt: run.prompt,
        forceResolvedAgent: run.resolvedAgent,
        replayInitialHeadSha: run.initialHeadSha,
        allowDuringDrain: true,
      });
    }
  }

  private async withFeedbackMutationLock<T>(
    prId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousLock = this.feedbackMutationLocks.get(prId) ?? Promise.resolve();
    let releaseCurrentLock: (() => void) | undefined;
    const currentLock = new Promise<void>((resolve) => {
      releaseCurrentLock = () => resolve();
    });
    const lockQueue = previousLock.then(() => currentLock);
    this.feedbackMutationLocks.set(prId, lockQueue);

    await previousLock;
    try {
      return await operation();
    } finally {
      releaseCurrentLock?.();
      if (this.feedbackMutationLocks.get(prId) === lockQueue) {
        this.feedbackMutationLocks.delete(prId);
      }
    }
  }

  async retryFeedbackItem(
    prId: string,
    feedbackId: string,
  ): Promise<
    | { kind: "ok"; updated: PR }
    | { kind: "pr_not_found" }
    | { kind: "feedback_not_found" }
    | { kind: "feedback_not_retryable" }
  > {
    return this.withFeedbackMutationLock(prId, async () => {
      const pr = await this.storage.getPR(prId);
      if (!pr) {
        return { kind: "pr_not_found" };
      }

      const item = pr.feedbackItems.find((candidate) => candidate.id === feedbackId);
      if (!item) {
        return { kind: "feedback_not_found" };
      }

      if (item.status !== "failed" && item.status !== "warning") {
        return { kind: "feedback_not_retryable" };
      }

      const feedbackItems = pr.feedbackItems.map((candidate) =>
        candidate.id === feedbackId ? markRetry(candidate) : candidate,
      );
      const counters = countDecisions(feedbackItems);
      const updated = await this.storage.updatePR(pr.id, {
        feedbackItems,
        accepted: counters.accepted,
        rejected: counters.rejected,
        flagged: counters.flagged,
      });

      if (!updated) {
        throw new Error(`Failed to queue retry for feedback item ${feedbackId} on PR ${prId}`);
      }

      return { kind: "ok", updated };
    });
  }

  async syncFeedbackForPR(
    prId: string,
    options?: {
      runId?: string | null;
      logStart?: boolean;
      phase?: string | null;
    },
  ): Promise<PR> {
    const pr = await this.storage.getPR(prId);
    if (!pr) {
      throw new Error("PR not found");
    }

    const parsedRepo = parseRepoSlug(pr.repo);
    if (!parsedRepo) {
      throw new Error(`Invalid repository slug: ${pr.repo}`);
    }

    const parsed: ParsedPRUrl = {
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
      number: pr.number,
    };

    const config = await this.storage.getConfig();
    const octokit = await this.github.buildOctokit(config);
    const phase = options?.phase ?? "sync";

    if (options?.logStart) {
      await this.storage.addLog(pr.id, "info", "Syncing GitHub comments/reviews...", {
        runId: options.runId ?? null,
        phase,
      });
    }

    const incomingFeedback = await this.github.fetchFeedbackItemsForPR(octokit, parsed, config);
    const { merged, newCount } = mergeFeedbackItems(pr.feedbackItems, incomingFeedback);
    const counters = countDecisions(merged);

    const updated = await this.storage.updatePR(pr.id, {
      title: pr.title,
      status: pr.status,
      lastChecked: new Date().toISOString(),
      feedbackItems: merged,
      accepted: counters.accepted,
      rejected: counters.rejected,
      flagged: counters.flagged,
    });

    if (!updated) {
      throw new Error("Failed to update PR after feedback sync");
    }

    await this.storage.addLog(pr.id, "info", formatFeedbackSyncLogMessage(incomingFeedback.length, newCount), {
      runId: options?.runId ?? null,
      phase,
      metadata: {
        total: incomingFeedback.length,
        newCount,
      },
    });

    return updated;
  }

  async syncAndBabysitTrackedRepos(): Promise<void> {
    const runtimeState = await this.storage.getRuntimeState();
    const automationBlocked = runtimeState.drainMode;

    const repairCandidates = [
      ...(await this.storage.getPRs()),
      ...(await this.storage.getArchivedPRs()),
    ].filter(hasMissingReviewThreadMetadata);
    const syncedFeedbackPrIds = new Set<string>();

    for (const pr of repairCandidates) {
      try {
        await this.syncFeedbackForPR(pr.id, {
          phase: "repair",
        });
        syncedFeedbackPrIds.add(pr.id);
      } catch (error) {
        await this.storage.addLog(pr.id, "warn", `Could not repair missing GitHub review-thread metadata: ${summarizeUnknownError(error)}`, {
          phase: "repair",
        });
      }
    }

    const config = await this.storage.getConfig();
    const tracked = await this.storage.getPRs();
    const explicitlyWatchedRepos = new Set(config.watchedRepos.map((repo) => repo.toLowerCase()));
    const repoCandidates = new Set<string>([
      ...tracked.map((pr) => pr.repo),
      ...config.watchedRepos,
    ]);
    const selectedAgent = config.codingAgent as CodingAgent;
    let watcherAgent = selectedAgent;
    const watchedPrIds = tracked
      .filter((pr) => pr.watchEnabled !== false && pr.status !== "archived")
      .map((pr) => pr.id);
    if (!automationBlocked && repoCandidates.size > 0) {
      try {
        watcherAgent = (await this.ensureAgentHealthy(selectedAgent, watchedPrIds, {
          allowFallback: config.fallbackToNextCodingAgent,
        })).agent;
      } catch {
        return;
      }
    }

    const repoSettingsByRepo = new Map(
      (await this.storage.listRepoSettings()).map((repo) => [repo.repo, repo]),
    );
    const octokit = await this.github.buildOctokit(config);

    const needsAuthenticatedLogin = Array.from(repoCandidates).some(
      (repo) => (repoSettingsByRepo.get(repo)?.ownPrsOnly ?? true),
    );
    let authenticatedLoginPromise: Promise<string | null> | null = null;
    const getAuthenticatedLogin = async (): Promise<string | null> => {
      if (!needsAuthenticatedLogin) {
        return null;
      }

      if (!authenticatedLoginPromise) {
        authenticatedLoginPromise = (this.github.getAuthenticatedLogin?.(octokit) ?? Promise.resolve(null))
          .catch((error) => {
            log.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "Failed to determine authenticated GitHub login for watcher filtering",
            );
            return null;
          });
      }

      return authenticatedLoginPromise;
    };

    const repos = Array.from(repoCandidates)
      .map((repo) => parseRepoSlug(repo))
      .filter((repo): repo is NonNullable<typeof repo> => Boolean(repo));

    for (const repo of repos) {
      const repoSlug = formatRepoSlug(repo);
      const repoIsExplicitlyWatched = explicitlyWatchedRepos.has(repoSlug.toLowerCase());

      let openPulls;
      try {
        openPulls = await this.github.listOpenPullsForRepo(octokit, repo);
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error), repo: repoSlug },
          "Failed to list open PRs",
        );
        continue;
      }

      const openNumbers = new Set(openPulls.map((p) => p.number));
      const repoOwnPrsOnly = repoSettingsByRepo.get(repoSlug)?.ownPrsOnly ?? true;
      const authenticatedLogin = repoOwnPrsOnly ? await getAuthenticatedLogin() : null;
      const automationScopeNumbers = new Set(
        openPulls
          .filter((pull) => !repoOwnPrsOnly || (
            authenticatedLogin !== null
            && pull.author.trim().toLowerCase() === authenticatedLogin
          ))
          .map((pull) => pull.number),
      );

      // Archive tracked PRs that are no longer open on GitHub
      const trackedForRepo = tracked.filter((pr) => pr.repo === repoSlug);
      for (const pr of trackedForRepo) {
        if (!openNumbers.has(pr.number) && pr.status !== "archived") {
          let closeState:
            | Awaited<ReturnType<NonNullable<GitHubService["fetchPullCloseState"]>>>
            | undefined;
          if (this.github.fetchPullCloseState) {
            try {
              closeState = await this.github.fetchPullCloseState(octokit, {
                owner: repo.owner,
                repo: repo.repo,
                number: pr.number,
              });
            } catch (error) {
              await this.storage.addLog(pr.id, "warn", `Could not confirm merge state before archival: ${summarizeUnknownError(error)}`, {
                phase: "watcher",
              });
            }
          }

          await this.storage.updatePR(pr.id, { status: "archived" });
          await this.supersedeActiveHealingSessionsForArchivedPr(pr.id);
          await this.storage.addLog(pr.id, "info", `PR #${pr.number} is no longer open on GitHub — archived`, {
            phase: "watcher",
          });

          const repoAutoCreateReleases = repoSettingsByRepo.get(repoSlug)?.autoCreateReleases ?? false;
          if (closeState?.merged) {
            await this.storage.incrementUsageCounter(
              "mergedPrCount",
              1,
              closeState.mergedAt || closeState.closedAt || new Date().toISOString(),
            );
          }

          if (!automationBlocked && closeState?.merged && this.releaseManager && config.autoCreateReleases) {
            if (!repoAutoCreateReleases) {
              await this.storage.addLog(pr.id, "info", `PR #${pr.number} was merged, but auto-release is disabled for ${repoSlug}`, {
                phase: "watcher",
              });
            } else {
              const baseBranch = closeState.baseRef.trim();
              const triggerMergeSha = closeState.mergeCommitSha || closeState.headSha;
              const triggerMergedAt = closeState.mergedAt || closeState.closedAt;
              if (!baseBranch || !triggerMergeSha || !triggerMergedAt) {
                const missingReleaseMetadata = [
                  !baseBranch ? "a base branch" : null,
                  !triggerMergeSha ? "a commit SHA" : null,
                  !triggerMergedAt ? "a merge timestamp" : null,
                ].filter((value): value is string => Boolean(value));
                await this.storage.addLog(
                  pr.id,
                  "warn",
                  `PR #${pr.number} was merged, but release evaluation was not queued because GitHub did not return ${missingReleaseMetadata.join(" and ")}.`,
                  {
                    phase: "watcher",
                    metadata: {
                      baseBranch,
                      headSha: closeState.headSha,
                      mergeCommitSha: closeState.mergeCommitSha,
                      mergedAt: closeState.mergedAt,
                      closedAt: closeState.closedAt,
                    },
                  },
                );
              } else {
                try {
                  await this.releaseManager.enqueueMergedPullReleaseEvaluation({
                    repo: repoSlug,
                    baseBranch,
                    triggerPrNumber: closeState.number,
                    triggerPrTitle: closeState.title,
                    triggerPrUrl: closeState.url,
                    triggerMergeSha,
                    triggerMergedAt,
                  });

                  await this.storage.addLog(pr.id, "info", `PR #${pr.number} was merged — queued release evaluation`, {
                    phase: "watcher",
                    metadata: {
                      baseBranch,
                      triggerMergeSha,
                    },
                  });
                } catch (error) {
                  await this.storage.addLog(pr.id, "warn", `PR #${pr.number} was merged, but release evaluation could not be queued: ${summarizeUnknownError(error)}`, {
                    phase: "watcher",
                  });
                }
              }
            }
          } else if (closeState && !closeState.merged) {
            await this.storage.addLog(pr.id, "info", `PR #${pr.number} closed without merge`, {
              phase: "watcher",
            });
          }

          if (!automationBlocked && closeState?.merged && this.deploymentHealingManager && this.scheduleBackgroundJob && config.autoHealDeployments) {
            const depBaseBranch = closeState.baseRef.trim();
            const depMergeSha = closeState.mergeCommitSha || closeState.headSha;
            if (depBaseBranch && depMergeSha) {
              try {
                const githubToken = await this.github.resolveGitHubAuthToken(config);
                const repoCloneUrl = buildGitHubCloneUrl(repoSlug, githubToken);
                const { repoCacheDir } = await ensureRepoCache({
                  repoFullName: repoSlug,
                  repoCloneUrl,
                  runCommand: this.runtime.runCommand,
                });
                const detected = await detectDeploymentPlatform(repoCacheDir);
                if (detected) {
                  await this.scheduleBackgroundJob(
                    "heal_deployment",
                    `${repoSlug}:${depMergeSha}`,
                    buildBackgroundJobDedupeKey("heal_deployment", `${repoSlug}:${depMergeSha}`),
                    {
                      repo: repoSlug, platform: detected.platform, mergeSha: depMergeSha,
                      triggerPrNumber: pr.number, triggerPrTitle: pr.title,
                      triggerPrUrl: pr.url, baseBranch: depBaseBranch,
                      ...buildActivityPayload({
                        label: `Healing ${detected.platform} deployment`,
                        detail: `${repoSlug} PR #${pr.number} - ${pr.title}`,
                        targetUrl: pr.url,
                      }),
                    },
                  );
                  await this.storage.addLog(pr.id, "info",
                    `PR #${pr.number} merged — queued deployment healing (${detected.platform})`,
                    { phase: "watcher", metadata: { platform: detected.platform, mergeSha: depMergeSha } },
                  );
                }
              } catch (error) {
                await this.storage.addLog(pr.id, "warn",
                  `Failed to queue deployment healing: ${summarizeUnknownError(error)}`,
                  { phase: "watcher" },
                );
              }
            }
          }
        }
      }
      for (const pull of openPulls) {
        let local = await this.storage.getPRByRepoAndNumber(repoSlug, pull.number);
        if (!local) {
          if (!repoIsExplicitlyWatched || !automationScopeNumbers.has(pull.number)) {
            continue;
          }

          local = await this.storage.addPR({
            number: pull.number,
            title: pull.title,
            repo: repoSlug,
            branch: pull.branch,
            author: pull.author,
            url: pull.url,
            status: "watching",
            feedbackItems: [],
            accepted: 0,
            rejected: 0,
            flagged: 0,
            testsPassed: null,
            lintPassed: null,
            lastChecked: null,
          });

          await this.storage.addLog(local.id, "info", `Auto-registered open PR #${pull.number} from ${repoSlug}`);
        }

        if (!automationScopeNumbers.has(pull.number)) {
          continue;
        }

        if (local.watchEnabled === false) {
          continue;
        }

        if (automationBlocked) {
          if (syncedFeedbackPrIds.has(local.id)) {
            continue;
          }

          try {
            await this.syncFeedbackForPR(local.id, {
              phase: "watcher",
            });
            syncedFeedbackPrIds.add(local.id);
          } catch (error) {
            await this.storage.addLog(local.id, "warn", `Could not sync GitHub feedback while automation is paused: ${summarizeUnknownError(error)}`, {
              phase: "watcher",
            });
          }
          continue;
        }

        const priorDependencyFailure = pull.headSha
          ? await this.findLatestDependencyPreflightFailure(local.id, pull.headSha)
          : null;
        if (priorDependencyFailure) {
          const lastChecked = this.now().toISOString();
          if (local.status !== "error") {
            await this.storage.updatePR(local.id, {
              status: "error",
              lastChecked,
            });
            await this.storage.addLog(local.id, "warn", "Dependency preflight previously failed for this PR head; skipping automatic babysitter run until the head changes", {
              phase: "watcher",
              metadata: {
                repo: repoSlug,
                headSha: pull.headSha,
                reason: priorDependencyFailure.reason,
                count: priorDependencyFailure.count,
              },
            });
          } else {
            await this.storage.updatePR(local.id, { lastChecked });
          }
          continue;
        }

        const terminalConflictFailure = pull.headSha && pull.baseSha
          ? await this.findTerminalConflictRepairFailureForHead(local.id, pull.headSha, pull.baseSha)
          : null;
        if (terminalConflictFailure) {
          const lastChecked = this.now().toISOString();
          if (local.status !== "error") {
            const reason = buildTerminalConflictRepairReason({
              conflictFiles: terminalConflictFailure.conflictFiles,
              headSha: terminalConflictFailure.headSha,
              baseRef: terminalConflictFailure.baseRef,
              baseSha: terminalConflictFailure.baseSha,
              lastReason: terminalConflictFailure.reason,
            });
            await this.storage.updatePR(local.id, {
              status: "error",
              lastChecked,
            });
            await this.storage.addLog(local.id, "warn", reason, {
              phase: "watcher",
              metadata: {
                repo: repoSlug,
                headSha: pull.headSha,
                baseSha: pull.baseSha,
                baseRef: pull.baseRef,
                conflictFiles: terminalConflictFailure.conflictFiles,
                count: terminalConflictFailure.count,
                priorReason: terminalConflictFailure.reason,
              },
            });
          } else {
            await this.storage.updatePR(local.id, { lastChecked });
          }
          continue;
        }

        const priorNoOpCheck = pull.headSha
          ? await this.findLatestNoOpCheck(local.id, pull.headSha)
          : null;
        if (priorNoOpCheck) {
          const lastCheckedMs = local.lastChecked ? Date.parse(local.lastChecked) : Number.NaN;
          const nowMs = this.now().getTime();
          const priorCheckedMs = Date.parse(priorNoOpCheck.checkedAt);
          if (
            Number.isFinite(lastCheckedMs)
            && Number.isFinite(priorCheckedMs)
            && lastCheckedMs >= priorCheckedMs
            && nowMs - lastCheckedMs < NO_OP_SUPPRESSION_COOLDOWN_MS
          ) {
            await this.storage.updatePR(local.id, {
              status: "watching",
            });
            await this.storage.addLog(local.id, "info", "Skipping unchanged clean PR head during no-op cooldown", {
              phase: "watcher",
              metadata: {
                repo: repoSlug,
                headSha: pull.headSha,
                checkedAt: priorNoOpCheck.checkedAt,
                lastChecked: local.lastChecked,
                cooldownMs: NO_OP_SUPPRESSION_COOLDOWN_MS,
              },
            });
            continue;
          }

          let syncedLocal: typeof local | null = null;
          try {
            syncedLocal = await this.syncFeedbackForPR(local.id, {
              phase: "watcher",
            });
          } catch (error) {
            await this.storage.addLog(local.id, "warn", `Could not sync GitHub feedback before no-op suppression: ${summarizeUnknownError(error)}`, {
              phase: "watcher",
              metadata: {
                repo: repoSlug,
                headSha: pull.headSha,
                errorClass: classifyFeedbackSyncError(error),
              },
            });
          }

          let failingStatuses: GitHubStatusFailure[] | null = null;
          if (syncedLocal) {
            try {
              failingStatuses = await this.github.listFailingStatuses(octokit, repo, pull.headSha);
            } catch (error) {
              await this.storage.addLog(local.id, "warn", `Could not check CI status before no-op suppression: ${summarizeUnknownError(error)}`, {
                phase: "watcher",
                metadata: {
                  repo: repoSlug,
                  headSha: pull.headSha,
                },
              });
            }
          }

          const hasPendingFeedback = syncedLocal?.feedbackItems.some((item) =>
            item.status === "pending" || item.status === "queued" || item.status === "in_progress"
          ) ?? false;
          if (syncedLocal && !hasPendingFeedback && failingStatuses && failingStatuses.length === 0) {
            const lastChecked = this.now().toISOString();
            await this.storage.updatePR(local.id, {
              status: "watching",
              lastChecked,
            });
            await this.storage.addLog(local.id, "info", "Skipping babysitter run because the same PR head was already checked with no necessary fixes", {
              phase: "watcher",
              metadata: {
                repo: repoSlug,
                headSha: pull.headSha,
                checkedAt: priorNoOpCheck.checkedAt,
              },
            });
            continue;
          }
        }

        await this.storage.addLog(local.id, "info", "Watcher queued autonomous babysitter run", {
          phase: "watcher",
          metadata: { repo: repoSlug },
        });
        if (this.scheduleBackgroundJob) {
          await this.scheduleBackgroundJob(
            "babysit_pr",
            local.id,
            buildBackgroundJobDedupeKey("babysit_pr", local.id),
            {
              preferredAgent: watcherAgent,
              ...buildActivityPayload({
                label: `Babysitting PR #${local.number}`,
                detail: `${local.repo} - ${local.title}`,
                targetUrl: local.url,
              }),
            },
          );
        } else {
          await this.babysitPR(local.id, watcherAgent);
        }
      }
    }
  }

  /**
   * Poll for CI/CD completion on a given commit SHA, then return the
   * aggregate result. Gives CI up to ~5 minutes to finish (30s intervals,
   * 10 attempts). Returns early as soon as all checks settle.
   */
  private async pollForCICompletion(
    octokit: Awaited<ReturnType<typeof buildOctokit>>,
    repo: ParsedRepoSlug,
    _pr: ParsedPRUrl,
    headSha: string,
    prId: string,
    queueLog: (prId: string, level: "info" | "warn" | "error", message: string, opts?: { phase?: string | null; metadata?: Record<string, unknown> | null }) => Promise<void>,
  ): Promise<{ status: "success" | "failure" | "timeout"; failures: GitHubStatusFailure[]; failureSummary?: CIFailureSummary }> {
    const MAX_ATTEMPTS = 10;
    const pollIntervalMs = this.runtime.ciPollIntervalMs ?? 30_000;
    const startedAtMs = this.now().getTime();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await wait(pollIntervalMs);

      try {
        const settled = await this.github.checkCISettled(octokit, repo, headSha);
        const failures = await this.github.listFailingStatuses(octokit, repo, headSha);

        await queueLog(prId, "info", `CI poll attempt ${attempt}/${MAX_ATTEMPTS}: ${failures.length} failure(s), settled=${settled}`, {
          phase: "verify.ci",
          metadata: { attempt, failures: failures.length, settled },
        });

        if (settled) {
          return failures.length > 0
            ? { status: "failure", failures, failureSummary: summarizeCIFailures(failures) }
            : { status: "success", failures: [] };
        }
      } catch (error) {
        await queueLog(prId, "warn", `CI poll attempt ${attempt} failed: ${summarizeUnknownError(error)}`, {
          phase: "verify.ci",
          metadata: { attempt },
        });
      }
    }

    // Final check after timeout.
    try {
      const finalFailures = await this.github.listFailingStatuses(octokit, repo, headSha);
      if (finalFailures.length > 0) {
        return { status: "failure", failures: finalFailures };
      }
    } catch (error) {
      await queueLog(prId, "warn", `Final CI status check after timeout failed: ${summarizeUnknownError(error)}`, {
        phase: "verify.ci",
      });
    }

    let pendingChecks: ReturnType<typeof summarizePendingChecks> = [];
    if (this.github.fetchCheckSnapshotsForRef) {
      try {
        pendingChecks = summarizePendingChecks(
          await this.github.fetchCheckSnapshotsForRef(octokit, repo, prId, headSha),
        );
      } catch (error) {
        await queueLog(prId, "warn", `Could not fetch pending CI check details after timeout: ${summarizeUnknownError(error)}`, {
          phase: "verify.ci",
        });
      }
    }
    const pendingSummary = pendingChecks.length > 0
      ? ` Pending: ${pendingChecks.map((check) => `${check.context} (${check.status}${check.conclusion ? `/${check.conclusion}` : ""})`).join("; ")}`
      : "";
    const elapsedMs = Math.max(0, this.now().getTime() - startedAtMs);
    await queueLog(prId, "warn", `CI status did not settle after ${MAX_ATTEMPTS} poll attempt(s).${pendingSummary}`, {
      phase: "verify.ci",
      metadata: { attempts: MAX_ATTEMPTS, pollIntervalMs, elapsedMs, headSha, pendingChecks },
    });
    return { status: "timeout", failures: [] };
  }

  async babysitPR(
    prId: string,
    preferredAgent: CodingAgent,
    options?: {
      runId?: string;
      recoveryMode?: boolean;
      forceAgentPrompt?: string | null;
      forceResolvedAgent?: CodingAgent | null;
      replayInitialHeadSha?: string | null;
      allowDuringDrain?: boolean;
      rethrowOnFailure?: boolean;
    },
  ): Promise<void> {
    const runId = options?.runId || randomUUID();
    const runtimeState = await this.storage.getRuntimeState();
    if (runtimeState.drainMode && !options?.allowDuringDrain) {
      const pr = await this.storage.getPR(prId);
      if (pr) {
        await this.storage.addLog(pr.id, "warn", "Babysitter run skipped because drain mode is enabled", {
          phase: "run",
        });
      }
      return;
    }

    const activeRun = this.inProgress.get(prId);
    if (activeRun) {
      const pr = await this.storage.getPR(prId);
      if (pr) {
        const activeStartedAtMs = Date.parse(activeRun.startedAt);
        const activeAgeMs = Number.isNaN(activeStartedAtMs)
          ? null
          : Math.max(0, this.now().getTime() - activeStartedAtMs);
        await this.storage.addLog(pr.id, "warn", "Babysitter run skipped because another run is already in progress", {
          phase: "run",
          metadata: {
            reason: "in_progress",
            activeRunId: activeRun.runId,
            activePreferredAgent: activeRun.preferredAgent,
            activeStartedAt: activeRun.startedAt,
            activeAgeMs,
            requestedPreferredAgent: preferredAgent,
          },
        });
      }
      return;
    }

    this.inProgress.set(prId, {
      runId,
      preferredAgent,
      startedAt: this.now().toISOString(),
    });
    const auditWindowStartMs = Math.floor(Date.now() / 1000) * 1000 - 1000;
    let logQueue = Promise.resolve();
    const runCreatedAt = new Date().toISOString();
    let runRecord: AgentRun = (await this.storage.getAgentRun(runId)) || {
      id: runId,
      prId,
      preferredAgent,
      resolvedAgent: options?.forceResolvedAgent ?? null,
      status: "running",
      phase: "run.started",
      prompt: options?.forceAgentPrompt ?? null,
      initialHeadSha: options?.replayInitialHeadSha ?? null,
      metadata: {
        recoveryMode: Boolean(options?.recoveryMode),
      },
      lastError: null,
      createdAt: runCreatedAt,
      updatedAt: runCreatedAt,
    };
    await this.storage.upsertAgentRun(runRecord);

    const updateRunRecord = async (
      updates: Partial<Pick<AgentRun, "status" | "phase" | "resolvedAgent" | "prompt" | "initialHeadSha" | "metadata" | "lastError">>,
    ) => {
      runRecord = {
        ...runRecord,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      await this.storage.upsertAgentRun(runRecord);
    };

    const queueLog = (
      currentPrId: string,
      level: "info" | "warn" | "error",
      message: string,
      details?: {
        phase?: string | null;
        metadata?: Record<string, unknown> | null;
      },
	    ) => {
	      logQueue = logQueue
	        .then(async () => {
	          await this.storage.addLog(currentPrId, level, message, {
	            runId,
	            phase: details?.phase ?? null,
	            metadata: details?.metadata ?? null,
	          });
	        })
	        .catch((logError) => {
	          log.warn(
	            { err: logError instanceof Error ? logError.message : String(logError) },
	            "Babysitter log write failed",
	          );
	        });

      return logQueue;
    };

    const logBestEffortFailure = async (
      currentPrId: string,
      phase: string,
      message: string,
      metadata?: Record<string, unknown>,
    ) => {
      await queueLog(currentPrId, "warn", message, {
        phase,
        metadata: metadata ?? null,
      });
    };

    const createChunkLogger = (
      currentPrId: string,
      phase: string,
      stream: "stdout" | "stderr",
      level: "info" | "warn",
      maxLines?: number,
      options?: { logLines?: boolean },
    ) => {
      let buffer = "";
      let loggedLines = 0;
      let loggedTruncation = false;
      const capturedLines: string[] = [];
      const kind = stream === "stderr" ? "subprocess_stderr" : "subprocess_stdout";

      const enqueueLine = (trimmed: string) => {
        capturedLines.push(trimmed);
        if (options?.logLines === false) {
          return logQueue;
        }

        if (maxLines !== undefined && loggedLines >= maxLines) {
          if (!loggedTruncation) {
            loggedTruncation = true;
            return queueLog(currentPrId, level, `[${stream}] output truncated after ${maxLines} line(s)`, {
              phase,
              metadata: {
                stream,
                kind,
                truncated: true,
                maxLines,
              },
            });
          }
          return logQueue;
        }

        loggedLines += 1;
        return queueLog(currentPrId, level, `[${stream}] ${trimmed}`, {
          phase,
          metadata: { stream, kind },
        });
      };

      return {
        onChunk: (chunk: string) => {
          const drained = drainChunkLines(buffer, chunk);
          buffer = drained.buffer;
          for (const line of drained.lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            void enqueueLine(trimmed);
          }
        },
        flush: async () => {
          const trimmed = buffer.trim();
          buffer = "";
          if (trimmed) {
            await enqueueLine(trimmed);
            return;
          }
          await logQueue;
        },
        getCapturedLines: () => capturedLines.slice(),
      };
    };

    const emitCapturedStreamLines = async (
      currentPrId: string,
      phase: string,
      stream: "stdout" | "stderr",
      level: "info" | "warn",
      lines: string[],
      maxLines?: number,
      metadata?: Record<string, unknown>,
    ) => {
      let loggedLines = 0;
      const kind = stream === "stderr" ? "subprocess_stderr" : "subprocess_stdout";
      for (const line of lines) {
        if (maxLines !== undefined && loggedLines >= maxLines) {
          await queueLog(currentPrId, level, `[${stream}] output truncated after ${maxLines} line(s)`, {
            phase,
            metadata: {
              stream,
              kind,
              truncated: true,
              maxLines,
              ...metadata,
            },
          });
          return;
        }

        loggedLines += 1;
        await queueLog(currentPrId, level, `[${stream}] ${line}`, {
          phase,
          metadata: { stream, kind, ...metadata },
        });
      }

      await logQueue;
    };

    const runLoggedCommand = async (params: {
      currentPrId: string;
      command: string;
      args: string[];
      cwd?: string;
      timeoutMs?: number;
      phase: string;
      successMessage: string;
      maxOutputLogLines?: number;
    }) => {
      const { currentPrId, command, args, cwd, timeoutMs, phase, successMessage, maxOutputLogLines } = params;

      await queueLog(currentPrId, "info", `Running ${formatCommand(command, args)}`, {
        phase,
      });

      const stdoutLogger = createChunkLogger(currentPrId, phase, "stdout", "info", maxOutputLogLines);
      const stderrLogger = createChunkLogger(currentPrId, phase, "stderr", "info", maxOutputLogLines, {
        logLines: false,
      });

      const result = await this.runtime.runCommand(command, args, {
        cwd,
        timeoutMs,
        onStdoutChunk: stdoutLogger.onChunk,
        onStderrChunk: stderrLogger.onChunk,
      });

      await stdoutLogger.flush();
      await stderrLogger.flush();

      if (result.code === 0) {
        await emitCapturedStreamLines(currentPrId, phase, "stderr", "info", stderrLogger.getCapturedLines(), maxOutputLogLines);
        await queueLog(currentPrId, "info", successMessage, {
          phase,
          metadata: { command: formatCommand(command, args), code: result.code },
        });
      } else {
        await emitCapturedStreamLines(currentPrId, phase, "stderr", "warn", stderrLogger.getCapturedLines(), maxOutputLogLines, {
          reemittedFor: "failure",
        });
        await queueLog(currentPrId, "error", `${formatCommand(command, args)} failed (${result.code})`, {
          phase,
          metadata: {
            command: formatCommand(command, args),
            code: result.code,
            summary: summarizeCommandFailure(result),
          },
        });
      }

      return result;
    };

    const commitDirtyWorktree = async (params: {
      currentPrId: string;
      cwd: string;
      commitArgs: string[];
      phase: string;
      context: string;
    }): Promise<boolean> => {
      const status = await runLoggedCommand({
        currentPrId: params.currentPrId,
        command: "git",
        args: ["status", "--porcelain"],
        cwd: params.cwd,
        timeoutMs: 5000,
        phase: params.phase,
        successMessage: "Collected worktree git status",
      });
      if (status.code !== 0) {
        throw new Error(formatGitFailure("checking worktree status", status));
      }

      if (!status.stdout.trim()) {
        await queueLog(params.currentPrId, "info", `No worktree changes to commit after ${params.context}`, {
          phase: params.phase,
        });
        return false;
      }

      const addResult = await runLoggedCommand({
        currentPrId: params.currentPrId,
        command: "git",
        args: ["add", "-A"],
        cwd: params.cwd,
        timeoutMs: 30000,
        phase: params.phase,
        successMessage: "Staged worktree changes",
      });
      if (addResult.code !== 0) {
        throw new Error(formatGitFailure("staging worktree changes", addResult));
      }

      const commitResult = await runLoggedCommand({
        currentPrId: params.currentPrId,
        command: "git",
        args: params.commitArgs,
        cwd: params.cwd,
        timeoutMs: 60000,
        phase: params.phase,
        successMessage: "Committed worktree changes",
      });
      if (commitResult.code !== 0) {
        throw new Error(formatGitFailure("committing worktree changes", commitResult));
      }

      return true;
    };

    const runCodeOwnerFallbackAfterFailure = async (params: {
      pr: PR;
      failureMessage: string;
    }): Promise<{ agent: CodingAgent; prompt: string }> => {
      const { pr, failureMessage } = params;
      const config = await this.storage.getConfig();
      const agent = await this.runtime.resolveAgent(preferredAgent, {
        allowFallback: config.fallbackToNextCodingAgent,
      });
      const fallbackStartedAt = this.now().toISOString();

      await updateRunRecord({
        phase: "code-owner-fallback.preparing",
        resolvedAgent: agent,
        metadata: {
          ...(runRecord.metadata ?? {}),
          defaultFailure: failureMessage,
          codeOwnerFallback: {
            ...(isRecord(runRecord.metadata?.codeOwnerFallback) ? runRecord.metadata.codeOwnerFallback : {}),
            status: "preparing",
            agent,
            timeoutMs: CODE_OWNER_FALLBACK_TIMEOUT_MS,
            startedAt: fallbackStartedAt,
          },
        },
      });

      const parsedFallbackRepo = parseRepoSlug(pr.repo);
      if (!parsedFallbackRepo) {
        throw new Error(`Invalid repository slug for code-owner fallback: ${pr.repo}`);
      }

      const fallbackOctokit = await this.github.buildOctokit(config);
      const pullSummary = await this.github.fetchPullSummary(fallbackOctokit, {
        owner: parsedFallbackRepo.owner,
        repo: parsedFallbackRepo.repo,
        number: pr.number,
      });

      const codeFactoryPaths = getCodeFactoryPaths();
      await queueLog(pr.id, "info", `Preparing code-owner fallback worktree in ${codeFactoryPaths.rootDir}`, {
        phase: "code-owner-fallback",
      });
      const { repoCacheDir, worktreePath, healed, remoteName } = await preparePrWorktree({
        rootDir: codeFactoryPaths.rootDir,
        repoFullName: pullSummary.repoFullName,
        repoCloneUrl: pullSummary.repoCloneUrl,
        headRepoFullName: pullSummary.headRepoFullName,
        headRepoCloneUrl: pullSummary.headRepoCloneUrl,
        headRef: pullSummary.headRef,
        prNumber: pr.number,
        runId: `${runId}-code-owner-fallback`,
        runCommand: this.runtime.runCommand,
      });

      try {
        await queueLog(pr.id, "info", `Code-owner fallback worktree ready at ${worktreePath}`, {
          phase: "code-owner-fallback",
          metadata: { remoteName, healed },
        });
        await ensureGitIdentity(worktreePath, this.runtime.runCommand);

        const prompt = buildCodeOwnerFallbackPrompt({
          pr,
          pullSummary,
          remoteName,
        });

        await updateRunRecord({
          phase: "code-owner-fallback.running",
          resolvedAgent: agent,
          prompt,
          metadata: {
            ...(runRecord.metadata ?? {}),
            defaultFailure: failureMessage,
            codeOwnerFallback: {
              ...(isRecord(runRecord.metadata?.codeOwnerFallback) ? runRecord.metadata.codeOwnerFallback : {}),
              status: "running",
              agent,
              timeoutMs: CODE_OWNER_FALLBACK_TIMEOUT_MS,
              cwd: worktreePath,
              remoteName,
            },
          },
        });

        let agentEnv: NodeJS.ProcessEnv | undefined;
        try {
          const githubToken = await this.github.resolveGitHubAuthToken(config);
          agentEnv = githubToken
            ? {
                ...process.env,
                GITHUB_TOKEN: githubToken,
                GH_TOKEN: githubToken,
              }
            : undefined;
        } catch (error) {
          await queueLog(pr.id, "warn", `Could not resolve GitHub token for code-owner fallback: ${summarizeUnknownError(error)}`, {
            phase: "code-owner-fallback",
          });
        }

        const cwd = worktreePath;
        const stdoutLogger = createChunkLogger(pr.id, "code-owner-fallback", "stdout", "info", AGENT_STREAM_LOG_LINE_LIMIT);
        const stderrLogger = createChunkLogger(pr.id, "code-owner-fallback", "stderr", "info", AGENT_STREAM_LOG_LINE_LIMIT);

        try {
          await queueLog(pr.id, "info", `Launching ${agent} code-owner fallback after default run failure`, {
            phase: "code-owner-fallback",
            metadata: {
              agent,
              cwd,
              timeoutMs: CODE_OWNER_FALLBACK_TIMEOUT_MS,
              promptChars: prompt.length,
            },
          });

          const result = await this.runtime.applyFixesWithAgent({
            agent,
            cwd,
            prompt,
            env: agentEnv,
            timeoutMs: CODE_OWNER_FALLBACK_TIMEOUT_MS,
            onStdoutChunk: stdoutLogger.onChunk,
            onStderrChunk: stderrLogger.onChunk,
          });
          await stdoutLogger.flush();
          await stderrLogger.flush();

          if (result.code !== 0) {
            const fallbackReason = formatConciseFailureReason(result.stderr || result.stdout);
            throw new Error(`${agent} code-owner fallback failed (${result.code}): ${fallbackReason}`);
          }

          await queueLog(pr.id, "info", `${agent} code-owner fallback completed successfully`, {
            phase: "code-owner-fallback",
            metadata: { agent, cwd },
          });

          return { agent, prompt };
        } finally {
          await stdoutLogger.flush();
          await stderrLogger.flush();
        }
      } finally {
        try {
          await queueLog(pr.id, "info", "Cleaning up code-owner fallback worktree", {
            phase: "code-owner-fallback",
          });
          await removePrWorktree({
            repoCacheDir,
            worktreePath,
            runCommand: this.runtime.runCommand,
          });
          await queueLog(pr.id, "info", "Code-owner fallback worktree cleanup complete", {
            phase: "code-owner-fallback",
          });
        } catch (cleanupError) {
          await queueLog(pr.id, "error", `Code-owner fallback worktree cleanup failed: ${summarizeUnknownError(cleanupError)}`, {
            phase: "code-owner-fallback",
          });
        }
      }
    };

    let followUpTasks: FeedbackItem[] = [];
    const forcedFixPrompt = options?.forceAgentPrompt ?? null;
    const forcedResolvedAgent = options?.forceResolvedAgent ?? null;
    const replayInitialHeadSha = options?.replayInitialHeadSha ?? null;
    const recoveryMode = Boolean(options?.recoveryMode);
    let skipForcedReplay = false;
    let branchMoved = false;

    try {
      await updateRunRecord({
        status: "running",
        phase: "run.started",
        metadata: {
          ...(runRecord.metadata ?? {}),
          recoveryMode,
        },
        lastError: null,
      });

      await this.storage.updatePR(prId, {
        status: "processing",
        lastChecked: this.now().toISOString(),
      });
      await queueLog(prId, "info", `Babysitter run started using preferred agent ${preferredAgent}${recoveryMode ? " (recovery)" : ""}`, {
        phase: "run",
        metadata: { preferredAgent, recoveryMode },
      });

      const config = await this.storage.getConfig();
      const selectedAgent = forcedResolvedAgent || preferredAgent;
      const healthSelection = await this.ensureAgentHealthy(selectedAgent, [prId], {
        allowFallback: !forcedResolvedAgent && config.fallbackToNextCodingAgent,
      });

      await updateRunRecord({ phase: "run.sync" });

      let pr = await this.syncFeedbackForPR(prId, {
        runId,
        logStart: true,
        phase: "sync",
      });
      let agent = forcedResolvedAgent || healthSelection.agent;
      if (!forcedResolvedAgent && healthSelection.agent === selectedAgent) {
        agent = await this.runtime.resolveAgent(preferredAgent, {
          allowFallback: config.fallbackToNextCodingAgent,
        });
      }
      if (agent !== healthSelection.agent) {
        await this.ensureAgentHealthy(agent, [pr.id]);
      }
      await updateRunRecord({
        resolvedAgent: agent,
      });
      const parsedRepo = parseRepoSlug(pr.repo);

      if (!parsedRepo) {
        throw new Error(`Invalid repository slug: ${pr.repo}`);
      }

      await queueLog(pr.id, "info", `Resolved coding agent to ${agent}`, {
        phase: "run",
      });

      let agentFallbackUsed = false;
      if (!forcedResolvedAgent && config.fallbackToNextCodingAgent && agent !== preferredAgent) {
        agentFallbackUsed = true;
        const reason = healthSelection.fallbackReason
          ?? `Configured coding agent ${preferredAgent} CLI is not installed`;
        if (!healthSelection.fallbackFromAgent) {
          await queueLog(pr.id, "warn", `Falling back from ${preferredAgent} to ${agent} because ${preferredAgent} is not working: ${reason}`, {
            phase: "run",
            metadata: {
              failedAgent: preferredAgent,
              fallbackAgent: agent,
            },
          });
        }
        await updateRunRecord({
          metadata: {
            ...(runRecord.metadata ?? {}),
            fallbackFromAgent: preferredAgent,
            fallbackReason: reason,
          },
        });
      }
      const tryFallbackToNextAgent = async (error: unknown, phase: string): Promise<boolean> => {
        if (
          !config.fallbackToNextCodingAgent
          || forcedResolvedAgent
          || agentFallbackUsed
          || !isAgentUnavailableError(error)
        ) {
          return false;
        }

        const failedAgent = agent;
        const fallbackAgent = getNextCodingAgent(failedAgent);
        let resolvedFallback: CodingAgent;
        try {
          resolvedFallback = await this.runtime.resolveAgent(fallbackAgent, { allowFallback: false });
        } catch {
          return false;
        }

        agentFallbackUsed = true;
        agent = resolvedFallback;
        const reason = summarizeUnknownError(error);
        await queueLog(pr.id, "warn", `Falling back from ${failedAgent} to ${agent} because ${failedAgent} is not working: ${reason}`, {
          phase,
          metadata: {
            failedAgent,
            fallbackAgent: agent,
          },
        });
        await updateRunRecord({
          resolvedAgent: agent,
          metadata: {
            ...(runRecord.metadata ?? {}),
            fallbackFromAgent: failedAgent,
            fallbackReason: reason,
          },
        });
        return true;
      };

      const evaluateWithCurrentAgent = async (params: {
        cwd: string;
        prompt: string;
        phase: string;
      }) => {
        try {
          return await this.runtime.evaluateFixNecessityWithAgent({
            agent,
            cwd: params.cwd,
            prompt: params.prompt,
          });
        } catch (error) {
          if (await tryFallbackToNextAgent(error, params.phase)) {
            return this.runtime.evaluateFixNecessityWithAgent({
              agent,
              cwd: params.cwd,
              prompt: params.prompt,
            });
          }
          throw error;
        }
      };

      const octokit = await this.github.buildOctokit(config);
      const parsedPr: ParsedPRUrl = {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        number: pr.number,
      };

      const pullSummary = await this.github.fetchPullSummary(octokit, parsedPr);
      const runInitialHeadSha = replayInitialHeadSha || pullSummary.headSha;
      if (runInitialHeadSha && runRecord.initialHeadSha !== runInitialHeadSha) {
        await updateRunRecord({
          initialHeadSha: runInitialHeadSha,
        });
      }
      if (forcedFixPrompt && replayInitialHeadSha && pullSummary.headSha !== replayInitialHeadSha) {
        skipForcedReplay = true;
        await queueLog(pr.id, "warn", `Skipping forced prompt replay because PR head moved (${replayInitialHeadSha.slice(0, 7)} -> ${pullSummary.headSha.slice(0, 7)})`, {
          phase: "run.replay",
          metadata: {
            replayInitialHeadSha,
            currentHeadSha: pullSummary.headSha,
          },
        });
      }
      const failingStatuses = await this.github.listFailingStatuses(octokit, parsedRepo, pullSummary.headSha);
      const observedAt = this.now().toISOString();
      const checkSnapshots = this.github.fetchCheckSnapshotsForRef
        ? await this.github.fetchCheckSnapshotsForRef(octokit, parsedRepo, pr.id, pullSummary.headSha)
        : failingStatuses.map((status) => ({
            id: `${status.context}:${status.description}:${pullSummary.headSha}`,
            prId: pr.id,
            sha: pullSummary.headSha,
            provider: "github.commit_status",
            context: status.context,
            status: "failure",
            conclusion: null,
            description: status.description,
            targetUrl: status.targetUrl,
            observedAt,
          }));
      const failingCheckSnapshots = checkSnapshots.filter((snapshot) => isFailingCheckSnapshot(snapshot));
      const classifiedHealingFailures = classifyCIFailures(failingCheckSnapshots);
      const healableHealingFailures = classifiedHealingFailures.filter((failure) => failure.classification === "healable_in_branch");
      const blockedHealingFailures = classifiedHealingFailures.filter((failure) => failure.classification === "blocked_external");
      const healingManager = new CIHealingManager(this.storage, () => this.now());
      let healingSession: HealingSession | null = null;

      if (failingCheckSnapshots.length > 0) {
        healingSession = await healingManager.ensureSessionForHead({
          prId: pr.id,
          repo: pr.repo,
          prNumber: pr.number,
          headSha: pullSummary.headSha,
        });

        await persistCheckSnapshotsIfMissing(this.storage, failingCheckSnapshots);
        await persistFailureFingerprintsIfMissing(
          this.storage,
          healingSession.id,
          pullSummary.headSha,
          classifiedHealingFailures,
        );

        if (isTerminalHealingState(healingSession.state)) {
          await queueLog(pr.id, "info", `CI healing session ${healingSession.id} is already ${healingSession.state}; skipping repair transition`, {
            phase: "healing.state",
            metadata: {
              healingSessionId: healingSession.id,
              healingState: healingSession.state,
              headSha: pullSummary.headSha,
            },
          });
        } else if (blockedHealingFailures.length > 0) {
          healingSession = await healingManager.markBlocked(
            healingSession.id,
            blockedHealingFailures[0]?.summary ?? "CI failure classified as blocked_external",
            {
              latestFingerprint: blockedHealingFailures[0]?.fingerprint ?? null,
              currentHeadSha: pullSummary.headSha,
            },
          );
        } else if (healableHealingFailures.length > 0) {
          healingSession = await healingManager.markAwaitingRepairSlot(healingSession.id, {
            latestFingerprint: healableHealingFailures[0]?.fingerprint ?? null,
            currentHeadSha: pullSummary.headSha,
          });
        } else {
          healingSession = await healingManager.markEscalated(
            healingSession.id,
            "CI failure could not be classified as healable in branch",
            {
              latestFingerprint: classifiedHealingFailures[0]?.fingerprint ?? null,
              currentHeadSha: pullSummary.headSha,
            },
          );
        }
      } else {
        const existingHealingSession = await healingManager.getSessionByPrAndHead(pr.id, pullSummary.headSha);
        const canMarkHealthy = existingHealingSession
          && ["triaging", "awaiting_repair_slot", "repairing", "awaiting_ci", "verifying", "cooldown"].includes(existingHealingSession.state);

        if (canMarkHealthy) {
          healingSession = await healingManager.markVerifying(existingHealingSession.id, {
            currentHeadSha: pullSummary.headSha,
          });
          healingSession = await healingManager.markHealed(healingSession.id, {
            currentHeadSha: pullSummary.headSha,
            lastImprovementScore: healingSession.lastImprovementScore ?? 0,
          });
        } else {
          healingSession = existingHealingSession ?? null;
        }
      }

      const includeRepositoryLinksInGitHubComments = config.includeRepositoryLinksInGitHubComments;
      const githubCommentAppName = config.githubCommentAppName;
      const postGitHubProgressReplies = config.postGitHubProgressReplies;
      // Track status reply comments so we can update them with progress.
      const statusReplies = new Map<string, StatusReplyRef>(
        Object.entries(readStatusReplyRefs(runRecord.metadata)),
      );
      const persistStatusReplyRef = async (feedbackId: string, ref: StatusReplyRef) => {
        const statusReplyRefs = {
          ...readStatusReplyRefs(runRecord.metadata),
          [feedbackId]: ref,
        };
        await updateRunRecord({
          metadata: {
            ...(runRecord.metadata ?? {}),
            statusReplyRefs,
          },
        });
      };
      const recoverStatusReplyRef = async (feedbackId: string): Promise<StatusReplyRef | null> => {
        const existing = statusReplies.get(feedbackId);
        if (existing) {
          return existing;
        }

        const item = pr.feedbackItems.find((candidate) => candidate.id === feedbackId);
        if (!item) {
          return null;
        }

        const recovered = findStatusReplyRefForFeedback(item, pr.feedbackItems);
        if (!recovered) {
          return null;
        }

        statusReplies.set(feedbackId, recovered);
        await persistStatusReplyRef(feedbackId, recovered);
        return recovered;
      };
      const updateItemStatus = async (feedbackId: string, line: string) => {
        const ref = await recoverStatusReplyRef(feedbackId);
        if (!ref) return;
        try {
          const newBody = appendStatusLine(
            ref.body,
            line,
            includeRepositoryLinksInGitHubComments,
            githubCommentAppName,
          );
          await this.github.updateStatusReply(octokit, parsedPr, ref, newBody);
          await persistStatusReplyRef(feedbackId, ref);
        } catch (error) {
          const item = pr.feedbackItems.find((candidate) => candidate.id === feedbackId);
          const recovered = item ? findStatusReplyRefForFeedback(item, pr.feedbackItems) : null;
          if (recovered && recovered.commentDatabaseId !== ref.commentDatabaseId) {
            try {
              const newBody = appendStatusLine(
                recovered.body,
                line,
                includeRepositoryLinksInGitHubComments,
                githubCommentAppName,
              );
              await this.github.updateStatusReply(octokit, parsedPr, recovered, newBody);
              statusReplies.set(feedbackId, recovered);
              await persistStatusReplyRef(feedbackId, recovered);
              return;
            } catch (retryError) {
              await logBestEffortFailure(
                pr.id,
                "github.status",
                `Failed to update recovered status reply for ${feedbackId}: ${summarizeUnknownError(retryError)}`,
                { feedbackId },
              );
              return;
            }
          }

          await logBestEffortFailure(
            pr.id,
            "github.status",
            `Failed to update status reply for ${feedbackId}: ${summarizeUnknownError(error)}`,
            { feedbackId },
          );
        }
      };

      const postAgentCommandComment = async (agent: CodingAgent, prompt: string) => {
        try {
          await this.github.postPRComment(
            octokit,
            parsedPr,
            formatAgentCommandGitHubComment(
              agent,
              prompt,
              includeRepositoryLinksInGitHubComments,
              githubCommentAppName,
            ),
          );
        } catch (error) {
          await logBestEffortFailure(
            pr.id,
            "github.agent-command",
            `Failed to post agent command comment: ${summarizeUnknownError(error)}`,
          );
        }
      };

      const applyWithCurrentAgent = async (
        params: Omit<Parameters<typeof applyFixesWithAgent>[0], "agent"> & {
          phase: string;
          onFallback?: (fallbackAgent: CodingAgent) => Promise<void>;
        },
      ) => {
        const { phase, onFallback, ...agentParams } = params;
        const result = await this.runtime.applyFixesWithAgent({
          agent,
          ...agentParams,
        });
        if (result.code === 0) {
          return result;
        }

        const error = new Error(`${agent} apply failed (${result.code}): ${result.stderr || result.stdout}`);
        if (!(await tryFallbackToNextAgent(error, phase))) {
          return result;
        }

        await onFallback?.(agent);
        await queueLog(pr.id, "info", `Launching ${agent} after fallback`, {
          phase,
          metadata: { agent, prompt: params.prompt },
        });
        await postAgentCommandComment(agent, params.prompt);

        return this.runtime.applyFixesWithAgent({
          agent,
          ...agentParams,
        });
      };

      const pendingComments = pr.feedbackItems.filter((item) => item.status === "pending");
      await queueLog(pr.id, "info", `Evaluating ${pendingComments.length} pending feedback item(s)`, {
        phase: "evaluate.comments",
      });

      const evaluatedItems = new Map<string, FeedbackItem>();

      for (const item of pendingComments) {
        await queueLog(pr.id, "info", `Inspecting feedback from ${item.author}`, {
          phase: "evaluate.comments",
          metadata: {
            feedbackId: item.id,
            file: item.file,
            line: item.line,
          },
        });

        if (isCodeFactoryComment(item.body)) {
          const reason = "oh-my-pr-authored agent command comment; no code change required";
          evaluatedItems.set(item.id, applyEvaluationDecision(item, false, reason));
          await queueLog(pr.id, "info", `Ignored self-authored agent command comment ${item.id}`, {
            phase: "evaluate.comments",
            metadata: {
              feedbackId: item.id,
              decision: "reject",
            },
          });
          continue;
        }

        if (looksLikeStatusReply(item.body)) {
          const reason = "oh-my-pr status comment; no code change required";
          evaluatedItems.set(item.id, applyEvaluationDecision(item, false, reason));
          await queueLog(pr.id, "info", `Ignored self-authored status comment ${item.id}`, {
            phase: "evaluate.comments",
            metadata: {
              feedbackId: item.id,
              decision: "reject",
            },
          });
          continue;
        }

        if (isAutomationAuditTrailFollowUp(item, pr.feedbackItems)) {
          const reason = "Automation audit trail follow-up; no code change required";
          evaluatedItems.set(item.id, applyEvaluationDecision(item, false, reason));
          await queueLog(pr.id, "info", `Ignored audit-trail follow-up comment ${item.id}`, {
            phase: "evaluate.comments",
            metadata: {
              feedbackId: item.id,
              decision: "reject",
            },
          });
          continue;
        }

        const evalPrompt = buildCommentEvaluationPrompt({ pr, item });
        await queueLog(pr.id, "info", `Evaluating feedback ${item.id} with ${agent}`, {
          phase: "evaluate.comments",
          metadata: { feedbackId: item.id, agent, prompt: evalPrompt },
        });

        const evaluation = await evaluateWithCurrentAgent({
          cwd: process.cwd(),
          prompt: evalPrompt,
          phase: "evaluate.comments",
        });

        const updated = applyEvaluationDecision(item, evaluation.needsFix, evaluation.reason);
        evaluatedItems.set(item.id, updated);

        if (evaluation.needsFix) {
          await queueLog(pr.id, "info", `Accepted feedback ${item.id}: ${evaluation.reason}`, {
            phase: "evaluate.comments",
            metadata: { feedbackId: item.id, decision: "accept" },
          });

          // Add 👀 reaction to signal we've seen this comment.
          try {
            await this.github.addReactionToComment(octokit, parsedPr, item, "eyes");
          } catch (error) {
            await logBestEffortFailure(
              pr.id,
              "github.reaction",
              `Failed to add reaction for ${item.id}: ${summarizeUnknownError(error)}`,
              { feedbackId: item.id },
            );
          }

          if (postGitHubProgressReplies) {
            try {
              const ref = await this.github.postStatusReplyForFeedbackItem(
                octokit,
                parsedPr,
                item,
                withOptionalAppCommentFooter(
                  STATUS_MESSAGES.accepted,
                  includeRepositoryLinksInGitHubComments,
                  githubCommentAppName,
                ),
              );
              if (ref) {
                statusReplies.set(item.id, ref);
                await persistStatusReplyRef(item.id, ref);
              }
            } catch (error) {
              await logBestEffortFailure(
                pr.id,
                "github.status",
                `Failed to post status reply for ${item.id}: ${summarizeUnknownError(error)}`,
                { feedbackId: item.id },
              );
            }
          }

        } else {
          await queueLog(pr.id, "info", `Rejected feedback ${item.id}: ${evaluation.reason}`, {
            phase: "evaluate.comments",
            metadata: { feedbackId: item.id, decision: "reject" },
          });
        }
      }

      const statusTasks: { context: string; description: string; targetUrl: string | null }[] = [];
      if (config.autoHealCI && healingSession) {
        await queueLog(pr.id, "info", `Skipping legacy status-task evaluation because CI healing session ${healingSession.id} is active`, {
          phase: "evaluate.status",
          metadata: {
            healingSessionId: healingSession.id,
            healingState: healingSession.state,
          },
        });
      } else {
        await queueLog(pr.id, "info", `Evaluating ${failingStatuses.length} failing status check(s)`, {
          phase: "evaluate.status",
        });
        for (const status of failingStatuses) {
          const statusEvalPrompt = buildStatusEvaluationPrompt({
            pr,
            context: status.context,
            description: status.description,
            targetUrl: status.targetUrl,
          });
          await queueLog(pr.id, "info", `Evaluating failing status ${status.context} with ${agent}`, {
            phase: "evaluate.status",
            metadata: { context: status.context, agent, prompt: statusEvalPrompt },
          });

          const evaluation = await evaluateWithCurrentAgent({
            cwd: process.cwd(),
            prompt: statusEvalPrompt,
            phase: "evaluate.status",
          });

          if (evaluation.needsFix) {
            statusTasks.push(status);
            await queueLog(pr.id, "info", `Accepted failing status ${status.context}: ${evaluation.reason}`, {
              phase: "evaluate.status",
              metadata: { context: status.context, decision: "accept" },
            });
          } else {
            await queueLog(pr.id, "info", `Rejected failing status ${status.context}: ${evaluation.reason}`, {
              phase: "evaluate.status",
              metadata: { context: status.context, decision: "reject" },
            });
          }
        }
      }

      if (evaluatedItems.size > 0) {
        const updatedItems = pr.feedbackItems.map((item) => evaluatedItems.get(item.id) ?? item);

        const counters = countDecisions(updatedItems);
        const updatedPR = await this.storage.updatePR(pr.id, {
          feedbackItems: updatedItems,
          accepted: counters.accepted,
          rejected: counters.rejected,
          flagged: counters.flagged,
        });

        if (updatedPR) {
          pr = updatedPR;
        }
      }

      const commentTasks = pr.feedbackItems.filter(
        (item) => item.status === "queued" && item.decision === "accept",
      );
      const replayCommentTasks = forcedFixPrompt
        ? pr.feedbackItems.filter(
            (item) => (item.status === "queued" || item.status === "in_progress") && item.decision === "accept",
          )
        : [];
      const effectiveCommentTasks = replayCommentTasks.length > 0 ? replayCommentTasks : commentTasks;
      followUpTasks = collectGitHubFollowUpTasks(pr);
      const prHasConflicts = pullSummary.mergeable === false;
      const hasConflicts = prHasConflicts && config.autoResolveMergeConflicts;

      if (prHasConflicts && !config.autoResolveMergeConflicts) {
        await queueLog(pr.id, "warn", `PR #${pr.number} has merge conflicts but auto-resolve is disabled in settings`, {
          phase: "conflict",
          metadata: { baseRef: pullSummary.baseRef, mergeable: pullSummary.mergeable },
        });
      }
      const shouldRunForcedReplay = Boolean(forcedFixPrompt && !skipForcedReplay);
      const disableAgentExecution = Boolean(forcedFixPrompt && skipForcedReplay);
      const hasCommentOrStatusAgentWork = !disableAgentExecution && (effectiveCommentTasks.length > 0 || statusTasks.length > 0 || shouldRunForcedReplay);
      const currentHeadDocsAssessment = getCurrentHeadDocsAssessment(pr, pullSummary.headSha);
      const docsAssessmentNeeded = !disableAgentExecution
        && !shouldRunForcedReplay
        && shouldAssessDocsForHead(pr, pullSummary.headSha, config.autoUpdateDocs);
      let docsTaskSummary = config.autoUpdateDocs && currentHeadDocsAssessment?.status === "needed"
        ? currentHeadDocsAssessment.summary
        : null;
      let hasDocsTask = Boolean(docsTaskSummary);
      const needsWorktree = hasCommentOrStatusAgentWork || hasConflicts || docsAssessmentNeeded || hasDocsTask;
      let healingRetryBlockedReason: string | null = null;
      const wouldRunCIHealingAgent = Boolean(
        config.autoHealCI
        && healingSession
        && healingSession.state === "awaiting_repair_slot"
        && !disableAgentExecution
        && !hasCommentOrStatusAgentWork
        && !hasConflicts
        && !docsAssessmentNeeded
        && !hasDocsTask,
      );

      if (wouldRunCIHealingAgent && healingSession) {
        const retryFingerprint = healableHealingFailures[0]?.fingerprint ?? healingSession.latestFingerprint ?? undefined;
        const retryBudget = await healingManager.canRetry(healingSession.id, retryFingerprint);
        if (!retryBudget.canRetry) {
          healingRetryBlockedReason = retryBudget.reason ?? "retry budget rejected the healing attempt";
          healingSession = await healingManager.markEscalated(healingSession.id, healingRetryBlockedReason, {
            currentHeadSha: pullSummary.headSha,
            latestFingerprint: retryFingerprint ?? healingSession.latestFingerprint,
          });
          await queueLog(pr.id, "warn", `CI healing retry skipped: ${healingRetryBlockedReason}`, {
            phase: "healing.retry",
            metadata: {
              healingSessionId: healingSession.id,
              fingerprint: retryFingerprint ?? null,
              sessionAttempts: retryBudget.sessionAttempts,
              fingerprintAttempts: retryBudget.fingerprintAttempts,
              maxSessionAttempts: retryBudget.maxSessionAttempts,
              maxFingerprintAttempts: retryBudget.maxFingerprintAttempts,
            },
          });
        }
      }

      const shouldRunCIHealingAgent = Boolean(
        wouldRunCIHealingAgent
        && healingSession?.state === "awaiting_repair_slot"
        && !healingRetryBlockedReason,
      );

      if (config.autoUpdateDocs && currentHeadDocsAssessment && !docsAssessmentNeeded) {
        await queueLog(
          pr.id,
          "info",
          `Documentation assessment already recorded for ${pullSummary.headSha.slice(0, 7)} (${currentHeadDocsAssessment.status})`,
          {
            phase: "evaluate.docs",
            metadata: {
              headSha: pullSummary.headSha,
              status: currentHeadDocsAssessment.status,
            },
          },
        );
      }

      if (!needsWorktree && !shouldRunCIHealingAgent && followUpTasks.length === 0 && !hasConflicts && failingCheckSnapshots.length === 0) {
        await queueLog(pr.id, "info", `Babysitter checked PR #${pr.number}; no necessary fixes identified`, {
          phase: "run",
        });
        await this.storage.updatePR(pr.id, {
          status: "watching",
          lastChecked: this.now().toISOString(),
        });
        await updateRunRecord({
          status: "completed",
          phase: "run.completed",
          metadata: {
            ...(runRecord.metadata ?? {}),
            noOpCheck: {
              kind: NO_OP_CHECK_KIND,
              headSha: pullSummary.headSha,
              checkedAt: this.now().toISOString(),
            },
          },
          lastError: null,
        });
        return;
      }

      let headShaForFollowUp = pullSummary.headSha;
      // branchMoved is declared in the outer scope so it's accessible in the catch block
      branchMoved = false;
      let remoteNameForLogs: string | null = null;
      let agentSummaries = new Map<string, string>();
      let docsTaskOutcome: DocsTaskOutcome | null = null;
      let healingAttemptMade = false;
      let healingAttemptRecordId: string | null = null;
      let healingAttemptResult: Awaited<ReturnType<typeof runCIHealingRepairAttempt>> | null = null;

      if (hasConflicts) {
        await queueLog(pr.id, "info", `PR #${pr.number} has merge conflicts with base branch ${pullSummary.baseRef}`, {
          phase: "conflict",
          metadata: { baseRef: pullSummary.baseRef, mergeable: pullSummary.mergeable },
        });
      }

      if (needsWorktree || hasConflicts) {
        await queueLog(
          pr.id,
          "info",
          `Babysitter preparing fix run with ${effectiveCommentTasks.length} comment task(s), ${statusTasks.length} status task(s), ${hasDocsTask ? 1 : 0} documentation task(s), and ${followUpTasks.length} GitHub follow-up task(s)${docsAssessmentNeeded ? ", with documentation assessment" : ""}${hasConflicts ? ", plus merge conflict resolution" : ""}${shouldRunForcedReplay ? ", with forced prompt replay" : ""} using ${agent}`,
          {
            phase: "run",
            metadata: {
              commentTasks: effectiveCommentTasks.length,
              statusTasks: statusTasks.length,
              docsTasks: hasDocsTask ? 1 : 0,
              docsAssessmentNeeded,
              followUpTasks: followUpTasks.length,
              hasConflicts,
              shouldRunForcedReplay,
              agent,
            },
          },
        );

        const codeFactoryPaths = getCodeFactoryPaths();
        await queueLog(pr.id, "info", `Preparing worktree in ${codeFactoryPaths.rootDir}`, {
          phase: "worktree",
        });
        const { repoCacheDir, worktreePath, healed, remoteName } = await preparePrWorktree({
          rootDir: codeFactoryPaths.rootDir,
          repoFullName: pullSummary.repoFullName,
          repoCloneUrl: pullSummary.repoCloneUrl,
          headRepoFullName: pullSummary.headRepoFullName,
          headRepoCloneUrl: pullSummary.headRepoCloneUrl,
          headRef: pullSummary.headRef,
          prNumber: pr.number,
          runId,
          runCommand: this.runtime.runCommand,
        });

        remoteNameForLogs = remoteName;

        try {
          await queueLog(pr.id, "info", `Worktree ready at ${worktreePath}`, {
            phase: "worktree",
            metadata: { remoteName, healed },
          });
          if (healed) {
            await queueLog(pr.id, "info", "Repo cache required auto-heal before the worktree was created", {
              phase: "worktree",
              metadata: { repoCacheDir },
            });
          }
          await queueLog(pr.id, "info", `Prepared PR head from remote ${remoteName}`, {
            phase: "worktree",
            metadata: { remoteName, headRef: pullSummary.headRef },
          });
          await queueLog(pr.id, "info", "Ensuring git identity", {
            phase: "git.identity",
          });
          await ensureGitIdentity(worktreePath, this.runtime.runCommand);
          await queueLog(pr.id, "info", "Git identity ready", {
            phase: "git.identity",
          });

          const dependencyPreflight = await (this.runtime.checkDependencyPreflight ?? checkDependencyPreflight)({
            cwd: worktreePath,
            pr,
            pullSummary,
            requiresVerification: hasCommentOrStatusAgentWork || hasConflicts || docsAssessmentNeeded || hasDocsTask,
            runCommand: this.runtime.runCommand,
          });
          if (!dependencyPreflight.ok) {
            const seenAt = this.now().toISOString();
            if (pullSummary.headSha) {
              const previousFailure = await this.findLatestDependencyPreflightFailure(pr.id, pullSummary.headSha);
              const failureCount = (previousFailure?.count ?? 0) + 1;
              const failureFirstSeenAt = previousFailure?.firstSeenAt || seenAt;
              await updateRunRecord({
                metadata: {
                  ...(runRecord.metadata ?? {}),
                  deterministicFailure: {
                    kind: DEPENDENCY_PREFLIGHT_FAILURE_KIND,
                    headSha: pullSummary.headSha,
                    reason: dependencyPreflight.reason,
                    firstSeenAt: failureFirstSeenAt,
                    lastSeenAt: seenAt,
                    count: failureCount,
                  },
                },
              });
            }
            await queueLog(pr.id, "error", `${DEPENDENCY_PREFLIGHT_FAILURE_PREFIX} ${dependencyPreflight.reason}`, {
              phase: "preflight.dependencies",
              metadata: {
                headSha: pullSummary.headSha,
                reason: dependencyPreflight.reason,
              },
            });
            throw new Error(`${DEPENDENCY_PREFLIGHT_FAILURE_PREFIX} ${dependencyPreflight.reason}`);
          }
          await queueLog(pr.id, "info", "Dependency preflight passed", {
            phase: "preflight.dependencies",
          });

          if (docsAssessmentNeeded) {
            await queueLog(pr.id, "info", "Documentation assessment started", {
              phase: "evaluate.docs",
              metadata: {
                headSha: pullSummary.headSha,
              },
            });

            try {
              const baseFetchForDocs = await runLoggedCommand({
                currentPrId: pr.id,
                command: "git",
                args: ["fetch", "origin", pullSummary.baseRef],
                cwd: worktreePath,
                timeoutMs: 120000,
                phase: "evaluate.docs",
                successMessage: `Fetched origin/${pullSummary.baseRef} for docs assessment`,
              });
              if (baseFetchForDocs.code !== 0) {
                throw new Error(`Failed to fetch origin/${pullSummary.baseRef} for docs assessment: ${summarizeCommandFailure(baseFetchForDocs)}`);
              }

              const changedFilesResult = await runLoggedCommand({
                currentPrId: pr.id,
                command: "git",
                args: ["diff", "--name-only", `origin/${pullSummary.baseRef}...HEAD`],
                cwd: worktreePath,
                timeoutMs: 10000,
                phase: "evaluate.docs",
                successMessage: "Collected changed files for docs assessment",
              });
              if (changedFilesResult.code !== 0) {
                throw new Error(`Failed to collect changed files for docs assessment: ${summarizeCommandFailure(changedFilesResult)}`);
              }

              const diffStatResult = await runLoggedCommand({
                currentPrId: pr.id,
                command: "git",
                args: ["diff", "--stat", `origin/${pullSummary.baseRef}...HEAD`],
                cwd: worktreePath,
                timeoutMs: 10000,
                phase: "evaluate.docs",
                successMessage: "Collected diff stat for docs assessment",
              });
              if (diffStatResult.code !== 0) {
                throw new Error(`Failed to collect diff stat for docs assessment: ${summarizeCommandFailure(diffStatResult)}`);
              }

              const diffPreviewResult = await runLoggedCommand({
                currentPrId: pr.id,
                command: "git",
                args: ["diff", "--no-color", "--unified=0", `origin/${pullSummary.baseRef}...HEAD`],
                cwd: worktreePath,
                timeoutMs: 10000,
                phase: "evaluate.docs",
                successMessage: "Collected diff preview for docs assessment",
                maxOutputLogLines: 20,
              });
              if (diffPreviewResult.code !== 0) {
                throw new Error(`Failed to collect diff preview for docs assessment: ${summarizeCommandFailure(diffPreviewResult)}`);
              }

              const docsPrompt = buildDocumentationAssessmentPrompt({
                pr,
                pullSummary,
                changedFiles: changedFilesResult.stdout.trim(),
                diffStat: diffStatResult.stdout.trim(),
                diffPreview: diffPreviewResult.stdout.trim(),
              });
              await queueLog(pr.id, "info", `Evaluating documentation needs with ${agent}`, {
                phase: "evaluate.docs",
                metadata: {
                  agent,
                  prompt: docsPrompt,
                },
              });

              const docsEvaluation = await evaluateWithCurrentAgent({
                cwd: worktreePath,
                prompt: docsPrompt,
                phase: "evaluate.docs",
              });

              const docsAssessment = {
                headSha: pullSummary.headSha,
                status: docsEvaluation.needsFix ? "needed" as const : "not_needed" as const,
                summary: docsEvaluation.reason,
                assessedAt: new Date().toISOString(),
              };
              const docsUpdatedPR = await this.storage.updatePR(pr.id, {
                docsAssessment,
              });
              if (docsUpdatedPR) {
                pr = docsUpdatedPR;
              }

              hasDocsTask = docsEvaluation.needsFix;
              docsTaskSummary = docsEvaluation.needsFix ? docsEvaluation.reason : null;

              await queueLog(pr.id, "info", docsEvaluation.needsFix
                ? `Documentation updates required: ${docsEvaluation.reason}`
                : `Documentation updates not required: ${docsEvaluation.reason}`, {
                phase: "evaluate.docs",
                metadata: {
                  decision: docsEvaluation.needsFix ? "needed" : "not_needed",
                  headSha: pullSummary.headSha,
                },
              });
            } catch (error) {
              const failureMessage = summarizeUnknownError(error);
              const docsAssessment = {
                headSha: pullSummary.headSha,
                status: "failed" as const,
                summary: failureMessage,
                assessedAt: new Date().toISOString(),
              };
              const docsUpdatedPR = await this.storage.updatePR(pr.id, {
                docsAssessment,
              });
              if (docsUpdatedPR) {
                pr = docsUpdatedPR;
              }

              hasDocsTask = false;
              docsTaskSummary = null;

              await queueLog(pr.id, "warn", `Documentation assessment failed: ${failureMessage}`, {
                phase: "evaluate.docs",
                metadata: {
                  headSha: pullSummary.headSha,
                },
              });
            }
          }

          if (hasConflicts) {
            await queueLog(pr.id, "info", `Fetching base branch origin/${pullSummary.baseRef} for merge`, {
              phase: "conflict",
            });
            const baseFetch = await runLoggedCommand({
              currentPrId: pr.id,
              command: "git",
              args: ["fetch", "origin", pullSummary.baseRef],
              cwd: worktreePath,
              timeoutMs: 120000,
              phase: "conflict",
              successMessage: `Fetched origin/${pullSummary.baseRef}`,
            });
            if (baseFetch.code !== 0) {
              throw new Error(`Failed to fetch base branch origin/${pullSummary.baseRef}: ${summarizeCommandFailure(baseFetch)}`);
            }

            await queueLog(pr.id, "info", `Attempting merge of origin/${pullSummary.baseRef} into ${pullSummary.headRef}`, {
              phase: "conflict",
            });
            const mergeResult = await this.runtime.runCommand("git", ["merge", "FETCH_HEAD", "--no-edit"], {
              cwd: worktreePath,
              timeoutMs: 60000,
            });

            if (mergeResult.code !== 0) {
              await queueLog(pr.id, "info", "Merge produced conflicts; invoking agent to resolve them", {
                phase: "conflict",
              });

              const conflictListResult = await this.runtime.runCommand("git", ["diff", "--name-only", "--diff-filter=U"], {
                cwd: worktreePath,
                timeoutMs: 10000,
              });
              const normalizedConflictFiles = normalizeConflictFiles(conflictListResult.stdout.trim().split("\n"));

              if (normalizedConflictFiles.length === 0) {
                throw new Error(`Merge failed but no conflict files detected: ${mergeResult.stderr || mergeResult.stdout}`);
              }

              await queueLog(pr.id, "info", `Found ${normalizedConflictFiles.length} file(s) with merge conflicts`, {
                phase: "conflict",
                metadata: { conflictFiles: normalizedConflictFiles },
              });

              const recordConflictRepairFailure = async (files: string[], reason: string, phase = "conflict.agent", priorFailures?: number) => {
                const conflictFilesForMarker = normalizeConflictFiles(files);
                const seenAt = this.now().toISOString();
                const previousFailures = priorFailures ?? await this.countConflictRepairFailures(
                  pr.id,
                  pullSummary.headSha,
                  pullSummary.baseSha,
                  conflictFilesForMarker,
                );
                const previousFailure = await this.findLatestConflictRepairFailure(
                  pr.id,
                  pullSummary.headSha,
                  pullSummary.baseSha,
                  conflictFilesForMarker,
                );
                const failureFirstSeenAt = previousFailure?.firstSeenAt || seenAt;
                const failureCount = previousFailures + 1;
                await updateRunRecord({
                  metadata: {
                    ...(runRecord.metadata ?? {}),
                    conflictRepairFailure: {
                      kind: CONFLICT_REPAIR_FAILURE_KIND,
                      headSha: pullSummary.headSha,
                      baseRef: pullSummary.baseRef,
                      baseSha: pullSummary.baseSha,
                      conflictFiles: conflictFilesForMarker,
                      reason,
                      firstSeenAt: failureFirstSeenAt,
                      lastSeenAt: seenAt,
                      count: failureCount,
                    },
                  },
                  phase,
                });
                return failureCount;
              };

              const priorConflictFailures = await this.countConflictRepairFailures(
                pr.id,
                pullSummary.headSha,
                pullSummary.baseSha,
                normalizedConflictFiles,
              );
              if (priorConflictFailures >= CONFLICT_REPAIR_RETRY_BUDGET) {
                const reason = buildTerminalConflictRepairReason({
                  conflictFiles: normalizedConflictFiles,
                  headSha: pullSummary.headSha,
                  baseRef: pullSummary.baseRef,
                  baseSha: pullSummary.baseSha,
                });
                await recordConflictRepairFailure(normalizedConflictFiles, reason, "conflict.retry", priorConflictFailures);
                await updateRunRecord({
                  status: "failed",
                  phase: "conflict.retry",
                  lastError: reason,
                });
                await this.storage.updatePR(pr.id, {
                  status: "error",
                  lastChecked: this.now().toISOString(),
                });
                await queueLog(pr.id, "warn", reason, {
                  phase: "conflict.retry",
                  metadata: {
                    headSha: pullSummary.headSha,
                    baseRef: pullSummary.baseRef,
                    baseSha: pullSummary.baseSha,
                    conflictFiles: normalizedConflictFiles,
                    priorFailures: priorConflictFailures,
                  },
                });
                throw new TerminalBabysitterError(reason);
              }

              const conflictStdout = createChunkLogger(pr.id, "conflict.agent", "stdout", "info", AGENT_STREAM_LOG_LINE_LIMIT);
              const conflictStderr = createChunkLogger(pr.id, "conflict.agent", "stderr", "info", AGENT_STREAM_LOG_LINE_LIMIT);
              const githubTokenForConflict = await this.github.resolveGitHubAuthToken(config);
              const conflictAgentEnv = githubTokenForConflict
                ? {
                    ...process.env,
                    GITHUB_TOKEN: githubTokenForConflict,
                    GH_TOKEN: githubTokenForConflict,
                  }
                : undefined;

              const conflictPrompt = buildConflictResolutionPrompt({
                pr,
                pullSummary,
                remoteName,
                conflictFiles: normalizedConflictFiles,
              });

              await queueLog(pr.id, "info", `Launching ${agent} to resolve merge conflicts`, {
                phase: "conflict.agent",
                metadata: { agent, promptChars: conflictPrompt.length },
              });

              await postAgentCommandComment(agent, conflictPrompt);

              const conflictResult = await applyWithCurrentAgent({
                cwd: worktreePath,
                prompt: conflictPrompt,
                env: conflictAgentEnv,
                onStdoutChunk: conflictStdout.onChunk,
                onStderrChunk: conflictStderr.onChunk,
                phase: "conflict.agent",
              });
              await conflictStdout.flush();
              await conflictStderr.flush();

              if (conflictResult.code !== 0) {
                const failureDetail = formatConciseFailureReason(conflictResult.stderr || conflictResult.stdout);
                const failureReason = `${agent} failed to resolve merge conflicts: ${failureDetail}`;
                const failureCount = await recordConflictRepairFailure(normalizedConflictFiles, failureReason, "conflict.agent", priorConflictFailures);
                if (failureCount >= CONFLICT_REPAIR_RETRY_BUDGET) {
                  throw new TerminalBabysitterError(buildTerminalConflictRepairReason({
                    conflictFiles: normalizedConflictFiles,
                    headSha: pullSummary.headSha,
                    baseRef: pullSummary.baseRef,
                    baseSha: pullSummary.baseSha,
                    lastReason: failureReason,
                  }));
                }
                throw new Error(`${agent} failed to resolve merge conflicts (${conflictResult.code}): ${failureDetail}`);
              }

              await queueLog(pr.id, "info", "Agent completed merge conflict resolution", {
                phase: "conflict.agent",
                metadata: { code: conflictResult.code },
              });

              const unresolvedAfterAgent = await this.runtime.runCommand("git", ["diff", "--name-only", "--diff-filter=U"], {
                cwd: worktreePath,
                timeoutMs: 5000,
              });
              if (unresolvedAfterAgent.code !== 0) {
                throw new Error(formatGitFailure("checking unresolved merge conflicts", unresolvedAfterAgent));
              }
              const unresolvedFiles = normalizeConflictFiles(unresolvedAfterAgent.stdout.trim().split("\n"));
              if (unresolvedFiles.length > 0) {
                const failureReason = `${agent} left unresolved merge conflicts: ${unresolvedFiles.join(", ")}`;
                const failureCount = await recordConflictRepairFailure(unresolvedFiles, failureReason);
                if (failureCount >= CONFLICT_REPAIR_RETRY_BUDGET) {
                  throw new TerminalBabysitterError(buildTerminalConflictRepairReason({
                    conflictFiles: unresolvedFiles,
                    headSha: pullSummary.headSha,
                    baseRef: pullSummary.baseRef,
                    baseSha: pullSummary.baseSha,
                    lastReason: failureReason,
                  }));
                }
                throw new Error(failureReason);
              }

              const markerFiles = await findFilesWithConflictMarkers(
                this.runtime.runCommand,
                worktreePath,
                normalizedConflictFiles,
              );
              if (markerFiles.length > 0) {
                const failureReason = `${agent} left merge conflict markers in ${markerFiles.join(", ")}`;
                const failureCount = await recordConflictRepairFailure(markerFiles, failureReason);
                if (failureCount >= CONFLICT_REPAIR_RETRY_BUDGET) {
                  throw new TerminalBabysitterError(buildTerminalConflictRepairReason({
                    conflictFiles: markerFiles,
                    headSha: pullSummary.headSha,
                    baseRef: pullSummary.baseRef,
                    baseSha: pullSummary.baseSha,
                    lastReason: failureReason,
                  }));
                }
                throw new Error(failureReason);
              }

              await commitDirtyWorktree({
                currentPrId: pr.id,
                cwd: worktreePath,
                commitArgs: ["commit", "--no-verify", "--no-edit"],
                phase: "conflict",
                context: "merge conflict resolution",
              });

              await queueLog(pr.id, "info", "Merge conflicts resolved and committed by babysitter", {
                phase: "conflict",
              });
            } else {
              await queueLog(pr.id, "info", "Merge completed without conflicts (GitHub mergeability may have been stale)", {
                phase: "conflict",
              });
            }
          }

          if (effectiveCommentTasks.length > 0) {
            const inProgressIds = new Set(effectiveCommentTasks.map((item) => item.id));
            const inProgressItems = pr.feedbackItems.map((item) =>
              inProgressIds.has(item.id) ? markInProgress(item) : item,
            );
            const inProgressCounters = countDecisions(inProgressItems);
            const inProgressPR = await this.storage.updatePR(pr.id, {
              feedbackItems: inProgressItems,
              accepted: inProgressCounters.accepted,
              rejected: inProgressCounters.rejected,
              flagged: inProgressCounters.flagged,
            });
            if (inProgressPR) {
              pr = inProgressPR;
            }
          }

          if (shouldRunForcedReplay || effectiveCommentTasks.length > 0 || statusTasks.length > 0 || hasDocsTask) {
            const agentStdout = createChunkLogger(pr.id, "agent", "stdout", "info", AGENT_STREAM_LOG_LINE_LIMIT);
            const agentStderr = createChunkLogger(pr.id, "agent", "stderr", "info", AGENT_STREAM_LOG_LINE_LIMIT);
            const githubToken = await this.github.resolveGitHubAuthToken(config);
            const agentEnv = githubToken
              ? {
                  ...process.env,
                  GITHUB_TOKEN: githubToken,
                  GH_TOKEN: githubToken,
                }
              : undefined;

            const fixPrompt = shouldRunForcedReplay && forcedFixPrompt ? forcedFixPrompt : buildAgentFixPrompt({
              pr,
              pullSummary,
              remoteName,
              commentTasks: effectiveCommentTasks,
              statusTasks,
              docsTaskSummary,
            });

            await updateRunRecord({
              phase: "run.prompt-prepared",
              prompt: fixPrompt,
              initialHeadSha: replayInitialHeadSha || pullSummary.headSha,
            });

            await queueLog(pr.id, "info", `Launching ${agent} in autonomous mode`, {
              phase: "agent",
              metadata: { githubAuth: Boolean(githubToken), promptChars: fixPrompt.length },
            });
            await updateRunRecord({
              phase: "run.agent-running",
            });

            // Post agent command to GitHub PR as a comment for debugging visibility.
            await postAgentCommandComment(agent, fixPrompt);

            const agentRunningStatus = STATUS_MESSAGES.agentRunning(agent);
            await Promise.all(effectiveCommentTasks.map((task) => updateItemStatus(task.id, agentRunningStatus)));

            const applyResult = await applyWithCurrentAgent({
              cwd: worktreePath,
              prompt: fixPrompt,
              env: agentEnv,
              onStdoutChunk: agentStdout.onChunk,
              onStderrChunk: agentStderr.onChunk,
              phase: "agent",
              onFallback: async (fallbackAgent) => {
                const fallbackStatus = STATUS_MESSAGES.agentRunning(fallbackAgent);
                await Promise.all(effectiveCommentTasks.map((task) => updateItemStatus(task.id, fallbackStatus)));
              },
            });
            await agentStdout.flush();
            await agentStderr.flush();

            if (applyResult.code !== 0) {
              const failureReason = formatConciseFailureReason(applyResult.stderr || applyResult.stdout);
              await Promise.all(effectiveCommentTasks.map((task) => updateItemStatus(task.id, STATUS_MESSAGES.agentFailed(agent, failureReason))));
              throw new Error(`${agent} apply failed (${applyResult.code}): ${failureReason}`);
            }

            await Promise.all(effectiveCommentTasks.map((task) => updateItemStatus(task.id, STATUS_MESSAGES.agentCompleted)));

            // Extract per-feedback-item summaries from agent output.
            agentSummaries = extractAgentSummaries(applyResult.stdout);
            docsTaskOutcome = extractDocsTaskOutcome(applyResult.stdout);

            await queueLog(pr.id, "info", `${agent} completed successfully`, {
              phase: "agent",
              metadata: {
                code: applyResult.code,
                extractedSummaries: agentSummaries.size,
                docsTaskOutcome: docsTaskOutcome?.outcome ?? null,
              },
            });
            await updateRunRecord({
              phase: "run.agent-finished",
            });
          }

          await commitDirtyWorktree({
            currentPrId: pr.id,
            cwd: worktreePath,
            commitArgs: ["commit", "--no-verify", "-m", `Apply babysitter fixes for PR #${pr.number}`],
            phase: "verify.git.status",
            context: "agent run",
          });
          await queueLog(pr.id, "info", "Worktree is clean after babysitter finalization", {
            phase: "verify.git.status",
          });

          const localHead = await runLoggedCommand({
            currentPrId: pr.id,
            command: "git",
            args: ["rev-parse", "HEAD"],
            cwd: worktreePath,
            timeoutMs: 5000,
            phase: "verify.git.local-head",
            successMessage: "Collected worktree HEAD",
          });
          if (localHead.code !== 0) {
            throw new Error(`git rev-parse HEAD failed: ${localHead.stderr || localHead.stdout}`);
          }

          const remoteFetch = await runLoggedCommand({
            currentPrId: pr.id,
            command: "git",
            args: ["-C", repoCacheDir, "fetch", remoteName, pullSummary.headRef],
            timeoutMs: 120000,
            phase: "verify.git.fetch-head",
            successMessage: `Fetched ${remoteName}/${pullSummary.headRef} for verification`,
          });
          if (remoteFetch.code !== 0) {
            throw new Error(`git fetch ${remoteName} ${pullSummary.headRef} failed: ${remoteFetch.stderr || remoteFetch.stdout}`);
          }

          const remoteHead = await runLoggedCommand({
            currentPrId: pr.id,
            command: "git",
            args: ["-C", repoCacheDir, "rev-parse", "FETCH_HEAD"],
            timeoutMs: 5000,
            phase: "verify.git.remote-head",
            successMessage: "Collected remote PR head SHA",
          });
          if (remoteHead.code !== 0) {
            throw new Error(`git rev-parse FETCH_HEAD failed: ${remoteHead.stderr || remoteHead.stdout}`);
          }

          const localHeadSha = localHead.stdout.trim();
          let remoteHeadSha = remoteHead.stdout.trim();
          const localCommitCreated = localHeadSha !== pullSummary.headSha;

          if (localCommitCreated && remoteHeadSha !== localHeadSha) {
            const pushResult = await runLoggedCommand({
              currentPrId: pr.id,
              command: "git",
              args: ["push", remoteName, `HEAD:${pullSummary.headRef}`],
              cwd: worktreePath,
              timeoutMs: 120000,
              phase: "verify.git.push",
              successMessage: `Pushed babysitter commit to ${remoteName}/${pullSummary.headRef}`,
            });
            if (pushResult.code !== 0) {
              throw new Error(formatGitFailure(`pushing ${remoteName}/${pullSummary.headRef}`, pushResult));
            }

            const refreshedRemoteFetch = await runLoggedCommand({
              currentPrId: pr.id,
              command: "git",
              args: ["-C", repoCacheDir, "fetch", remoteName, pullSummary.headRef],
              timeoutMs: 120000,
              phase: "verify.git.fetch-head",
              successMessage: `Fetched ${remoteName}/${pullSummary.headRef} after babysitter push`,
            });
            if (refreshedRemoteFetch.code !== 0) {
              throw new Error(formatGitFailure(`fetching ${remoteName}/${pullSummary.headRef} after push`, refreshedRemoteFetch));
            }

            const refreshedRemoteHead = await runLoggedCommand({
              currentPrId: pr.id,
              command: "git",
              args: ["-C", repoCacheDir, "rev-parse", "FETCH_HEAD"],
              timeoutMs: 5000,
              phase: "verify.git.remote-head",
              successMessage: "Collected remote PR head SHA after babysitter push",
            });
            if (refreshedRemoteHead.code !== 0) {
              throw new Error(formatGitFailure("reading remote PR head after push", refreshedRemoteHead));
            }
            remoteHeadSha = refreshedRemoteHead.stdout.trim();
          }

          if (localCommitCreated && remoteHeadSha !== localHeadSha) {
            throw new Error("Babysitter created a local commit but could not verify it on the PR head branch");
          }

          branchMoved = remoteHeadSha !== pullSummary.headSha;
          if (branchMoved) {
            await this.storage.incrementUsageCounter("fixesMadeCount");
          }

          if (statusTasks.length > 0 && !branchMoved) {
            throw new Error("Agent did not update the PR head branch for accepted failing status tasks");
          }

          if (hasDocsTask && !docsTaskOutcome) {
            throw new Error("Agent did not report documentation task outcome");
          }

          if (hasDocsTask && !branchMoved && docsTaskOutcome?.outcome !== "no_change") {
            throw new Error("Agent did not update the PR head branch for required documentation tasks");
          }

          if (hasConflicts && !branchMoved) {
            throw new Error("Conflict resolution was not pushed to the PR head branch");
          }

          if (hasDocsTask && docsTaskOutcome?.outcome === "no_change") {
            const docsUpdatedPR = await this.storage.updatePR(pr.id, {
              docsAssessment: {
                headSha: pullSummary.headSha,
                status: "not_needed",
                summary: docsTaskOutcome.summary,
                assessedAt: new Date().toISOString(),
              },
            });
            if (docsUpdatedPR) {
              pr = docsUpdatedPR;
            }
          }

          headShaForFollowUp = localHeadSha;

          await queueLog(pr.id, "info", "Verified git branch state after agent run", {
            phase: "verify.git",
            metadata: {
              initialHeadSha: pullSummary.headSha,
              localHeadSha,
              remoteHeadSha,
              branchMoved,
              localCommitCreated,
              remoteName,
              docsTaskOutcome: docsTaskOutcome?.outcome ?? null,
            },
          });

          if (docsTaskOutcome) {
            await queueLog(pr.id, "info", `Documentation task outcome: ${docsTaskOutcome.outcome} - ${docsTaskOutcome.summary}`, {
              phase: "verify.docs",
              metadata: {
                outcome: docsTaskOutcome.outcome,
                branchMoved,
              },
            });
          }
        } finally {
          try {
            await queueLog(pr.id, "info", "Cleaning up worktree", {
              phase: "cleanup",
            });
            await removePrWorktree({
              repoCacheDir,
              worktreePath,
              runCommand: this.runtime.runCommand,
            });
            await queueLog(pr.id, "info", "Worktree cleanup complete", {
              phase: "cleanup",
            });
          } catch (cleanupError) {
            const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            await queueLog(pr.id, "error", `Worktree cleanup failed: ${cleanupMessage}`, {
              phase: "cleanup",
            });
          }
        }
      } else {
        await queueLog(
          pr.id,
          "info",
          `Babysitter found ${followUpTasks.length} accepted feedback item(s) awaiting GitHub follow-up`,
          {
            phase: "run",
            metadata: {
              followUpTasks: followUpTasks.length,
              agent,
            },
          },
        );
      }

      if (shouldRunCIHealingAgent && healingSession) {
        const targetFingerprints = healableHealingFailures.map((failure) => failure.fingerprint);

        await queueLog(pr.id, "info", `Launching dedicated CI healing attempt for ${targetFingerprints.length} fingerprint(s)`, {
          phase: "healing.run",
          metadata: {
            healingSessionId: healingSession.id,
            targetFingerprints,
          },
        });

        healingSession = await healingManager.markRepairing(healingSession.id, {
          currentHeadSha: pullSummary.headSha,
          latestFingerprint: targetFingerprints[0] ?? healingSession.latestFingerprint,
        });

        const githubToken = await this.github.resolveGitHubAuthToken(config);
        const healingAgentEnv = githubToken
          ? {
              ...process.env,
              GITHUB_TOKEN: githubToken,
              GH_TOKEN: githubToken,
            }
          : undefined;

        healingAttemptResult = await this.runtime.runCIHealingRepairAttempt?.({
          prNumber: pr.number,
          repoFullName: pullSummary.repoFullName,
          repoCloneUrl: pullSummary.repoCloneUrl,
          headRepoFullName: pullSummary.headRepoFullName,
          headRepoCloneUrl: pullSummary.headRepoCloneUrl,
          headRef: pullSummary.headRef,
          baseRef: pullSummary.baseRef,
          headSha: pullSummary.headSha,
          title: pullSummary.title,
          url: pullSummary.url,
          author: pullSummary.author,
          branch: pr.branch,
          agent,
          failures: healableHealingFailures,
          runId: `${runId}-ci-healing`,
          rootDir: getCodeFactoryPaths().rootDir,
          env: healingAgentEnv,
        }) ?? null;

        if (!healingAttemptResult) {
          throw new Error("CI healing runtime is unavailable");
        }

        const healingAttempt = await this.storage.createHealingAttempt({
          sessionId: healingSession.id,
          attemptNumber: healingSession.attemptCount,
          inputSha: pullSummary.headSha,
          outputSha: healingAttemptResult.accepted ? healingAttemptResult.verification.remoteHeadSha : null,
          status: healingAttemptResult.accepted ? "awaiting_ci" : "failed",
          endedAt: healingAttemptResult.accepted ? null : new Date().toISOString(),
          agent,
          promptDigest: healingAttemptResult.promptDigest,
          targetFingerprints: healingAttemptResult.targetFingerprints,
          summary: healingAttemptResult.summary,
          improvementScore: null,
          error: healingAttemptResult.rejectionReason,
        });
        healingAttemptRecordId = healingAttempt.id;

        healingAttemptMade = true;

        if (healingAttemptResult.accepted) {
          healingSession = await healingManager.markAwaitingCi(healingSession.id, {
            currentHeadSha: healingAttemptResult.verification.remoteHeadSha,
            latestFingerprint: healingAttemptResult.targetFingerprints[0] ?? healingSession.latestFingerprint,
          });
          branchMoved = healingAttemptResult.verification.pushedNewSha;
          if (branchMoved) {
            await this.storage.incrementUsageCounter("fixesMadeCount");
          }
          headShaForFollowUp = healingAttemptResult.verification.remoteHeadSha;
          remoteNameForLogs = healingAttemptResult.remoteName;
        } else {
          healingSession = await healingManager.markEscalated(
            healingSession.id,
            healingAttemptResult.rejectionReason ?? "CI healing attempt failed",
            {
              currentHeadSha: pullSummary.headSha,
              latestFingerprint: healingAttemptResult.targetFingerprints[0] ?? healingSession.latestFingerprint,
            },
          );
        }
      }

      await updateRunRecord({
        phase: "run.reconcile",
      });

      for (const item of followUpTasks) {
        const shouldPostFollowUp = !hasAuditTrail(item, pr.feedbackItems);
        const shouldResolveThread = shouldResolveReviewConversation(markResolved(item));

        if (shouldPostFollowUp) {
          await queueLog(pr.id, "info", `Posting GitHub follow-up for ${item.id}${shouldResolveThread ? " and resolving conversation" : ""}`, {
            phase: "github.followup",
            metadata: {
              feedbackId: item.id,
              replyKind: item.replyKind,
              resolve: shouldResolveThread,
            },
          });

          const body = buildFeedbackFollowUpBody(
            headShaForFollowUp,
            item,
            includeRepositoryLinksInGitHubComments,
            githubCommentAppName,
            agentSummaries.get(item.auditToken),
          );
          await this.github.postFollowUpForFeedbackItem(octokit, parsedPr, item, body, { resolve: shouldResolveThread });
        } else if (shouldResolveThread) {
          // Reply already exists but the conversation thread was not resolved
          // yet (e.g. previous run posted the reply but failed before
          // resolving). Resolve it now to keep conversations tidy.
          if (!item.threadId) {
            await queueLog(pr.id, "warn", `Cannot resolve review thread for ${item.id}: thread ID unavailable (skipping)`, {
              phase: "github.followup",
              metadata: { feedbackId: item.id },
            });
            continue;
          }

          await this.github.resolveReviewThread(octokit, parsedPr, item.threadId);
        }

        await queueLog(pr.id, "info", `GitHub follow-up complete for ${item.id}`, {
          phase: "github.followup",
          metadata: {
            feedbackId: item.id,
            replyKind: item.replyKind,
            posted: shouldPostFollowUp,
            resolved: shouldResolveThread,
          },
        });

        await updateItemStatus(item.id, STATUS_MESSAGES.resolved(headShaForFollowUp));
      }

      pr = await this.syncFeedbackForPR(pr.id, {
        runId,
        logStart: true,
        phase: "verify.sync",
      });

      const auditTrailErrors = collectAuditTrailErrors({
        pr,
        followUpTasks,
        runStartedAtMs: auditWindowStartMs,
      });
      if (auditTrailErrors.length > 0) {
        throw new GitHubIntegrationError(
          `GitHub audit trail verification failed: ${auditTrailErrors.join("; ")}`,
          502,
        );
      }

      await queueLog(pr.id, "info", "GitHub audit trail verified", {
        phase: "verify.github",
        metadata: {
          verifiedComments: followUpTasks.length,
          remoteName: remoteNameForLogs,
          branchMoved,
        },
      });

      if (followUpTasks.length > 0) {
        const resolvedIds = new Set(followUpTasks.map((item) => item.id));
        const resolvedItems = pr.feedbackItems.map((item) =>
          resolvedIds.has(item.id) ? markResolved(item) : item,
        );
        const resolvedCounters = countDecisions(resolvedItems);
        const resolvedPR = await this.storage.updatePR(pr.id, {
          feedbackItems: resolvedItems,
          accepted: resolvedCounters.accepted,
          rejected: resolvedCounters.rejected,
          flagged: resolvedCounters.flagged,
        });
        if (resolvedPR) {
          pr = resolvedPR;
        }
      }

      // Post-push CI monitoring: if the app pushed changes, poll for CI
      // results on the new commit and alert the user if failures persist.
      if (branchMoved && headShaForFollowUp) {
        await queueLog(pr.id, "info", "Waiting for CI/CD checks on new commit...", {
          phase: "verify.ci",
          metadata: { headSha: headShaForFollowUp },
        });

        const ciResult = await this.pollForCICompletion(
          octokit,
          parsedRepo,
          parsedPr,
          headShaForFollowUp,
          pr.id,
          queueLog,
        );

        if (ciResult.status === "failure") {
          const failureDetails = ciResult.failures.map((f) => `${f.context}: ${f.description}`).join("; ");
          await queueLog(pr.id, "warn", `CI/CD still failing after agent fix: ${failureDetails}`, {
            phase: "verify.ci",
            metadata: {
              failures: ciResult.failures,
              failureSummary: ciResult.failureSummary ?? summarizeCIFailures(ciResult.failures),
              headSha: headShaForFollowUp,
            },
          });

          // Alert the user by posting a comment on the PR.
          try {
            const appName = formatAppName(githubCommentAppName, includeRepositoryLinksInGitHubComments);
            const footer = formatIncludedAppCommentFooter(
              includeRepositoryLinksInGitHubComments,
              githubCommentAppName,
            );
            const alertBody = [
              appName ? `## \u26a0\ufe0f ${appName} CI Alert` : "## \u26a0\ufe0f CI Alert",
              "",
              `The babysitter pushed changes (commit \`${headShaForFollowUp.slice(0, 7)}\`), but CI/CD checks are still failing:`,
              "",
              ...ciResult.failures.map((f) => `- **${f.context}**: ${f.description}${f.targetUrl ? ` ([details](${f.targetUrl}))` : ""}`),
              "",
              "Manual investigation may be required.",
              ...(footer ? ["", footer] : []),
            ].join("\n");
            await this.github.postPRComment(octokit, parsedPr, alertBody);
          } catch (error) {
            await logBestEffortFailure(
              pr.id,
              "verify.ci",
              `Failed to post CI failure alert comment: ${summarizeUnknownError(error)}`,
            );
          }

          await this.storage.updatePR(pr.id, {
            testsPassed: false,
            lastChecked: new Date().toISOString(),
          });

          if (healingAttemptMade && healingAttemptResult && healingAttemptRecordId && healingSession) {
            healingSession = await healingManager.markVerifying(healingSession.id, {
              currentHeadSha: headShaForFollowUp,
            });

            const postHealingObservedAt = this.now().toISOString();
            const postHealingSnapshots = this.github.fetchCheckSnapshotsForRef
              ? await this.github.fetchCheckSnapshotsForRef(octokit, parsedRepo, pr.id, headShaForFollowUp)
              : ciResult.failures.map((status) => ({
                  id: `${status.context}:${status.description}:${headShaForFollowUp}`,
                  prId: pr.id,
                  sha: headShaForFollowUp,
                  provider: "github.commit_status",
                  context: status.context,
                  status: "failure",
                  conclusion: null,
                  description: status.description,
                  targetUrl: status.targetUrl,
                  observedAt: postHealingObservedAt,
                }));
            const postHealingFailingSnapshots = postHealingSnapshots.filter((snapshot) => isFailingCheckSnapshot(snapshot));
            const postHealingFailures = classifyCIFailures(postHealingFailingSnapshots);
            await persistCheckSnapshotsIfMissing(this.storage, postHealingFailingSnapshots);
            await persistFailureFingerprintsIfMissing(
              this.storage,
              healingSession.id,
              headShaForFollowUp,
              postHealingFailures,
            );

            const comparison = computeHealingImprovementScore(
              healingAttemptResult.targetFingerprints,
              postHealingFailures,
            );

            await this.storage.updateHealingAttempt(healingAttemptRecordId, {
              outputSha: headShaForFollowUp,
              status: "verified",
              endedAt: new Date().toISOString(),
              improvementScore: comparison.improvementScore,
              error: comparison.improvementScore > 0
                ? null
                : `CI failures remained unchanged or worsened after repair: ${failureDetails}`,
            });

            if (comparison.improvementScore > 0) {
              healingSession = await healingManager.markAwaitingRepairSlot(healingSession.id, {
                currentHeadSha: headShaForFollowUp,
                latestFingerprint: comparison.remainingTargetFingerprints[0] ?? postHealingFailures[0]?.fingerprint ?? null,
                lastImprovementScore: comparison.improvementScore,
              });
            } else {
              healingSession = await healingManager.markEscalated(
                healingSession.id,
                `CI failures remained unchanged or worsened after repair: ${failureDetails}`,
                {
                  currentHeadSha: headShaForFollowUp,
                  latestFingerprint: comparison.remainingTargetFingerprints[0] ?? postHealingFailures[0]?.fingerprint ?? null,
                  lastImprovementScore: comparison.improvementScore,
                },
              );
            }
          }
        } else if (ciResult.status === "success") {
          await queueLog(pr.id, "info", "All CI/CD checks passed on new commit", {
            phase: "verify.ci",
            metadata: { headSha: headShaForFollowUp },
          });
          await this.storage.updatePR(pr.id, {
            testsPassed: true,
            lastChecked: new Date().toISOString(),
          });

          if (healingAttemptMade && healingAttemptResult && healingAttemptRecordId && healingSession) {
            healingSession = await healingManager.markVerifying(healingSession.id, {
              currentHeadSha: headShaForFollowUp,
            });
            await this.storage.updateHealingAttempt(healingAttemptRecordId, {
              outputSha: headShaForFollowUp,
              status: "verified",
              endedAt: new Date().toISOString(),
              improvementScore: Math.max(2, healingAttemptResult.targetFingerprints.length * 2),
              error: null,
            });
            healingSession = await healingManager.markHealed(healingSession.id, {
              currentHeadSha: headShaForFollowUp,
              latestFingerprint: null,
              lastImprovementScore: Math.max(2, healingAttemptResult.targetFingerprints.length * 2),
            });
          }
        } else {
          // Timed out waiting for CI — log it and move on.
          await queueLog(pr.id, "info", "CI/CD checks did not complete within polling window; will re-check on next cycle", {
            phase: "verify.ci",
            metadata: { headSha: headShaForFollowUp },
          });
        }
      }

      await this.storage.updatePR(pr.id, {
        status: "watching",
        lastChecked: new Date().toISOString(),
      });
      await queueLog(pr.id, "info", "Babysitter run complete", {
        phase: "run",
        metadata: { remoteName: remoteNameForLogs, branchMoved },
      });
      await updateRunRecord({
        status: "completed",
        phase: "run.completed",
        lastError: null,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const currentPr = await this.storage.getPR(prId);
      const isGitHubError = error instanceof GitHubIntegrationError;
      const isNonCritical = isGitHubError && branchMoved;
      let finalMessage = message;
      let rethrowError: unknown = error;

      if (currentPr) {
        // Determine if this is a non-critical GitHub integration failure
        // (e.g. couldn't post a comment or resolve a thread) vs a real
        // agent/processing failure. GitHub errors that happen *after* the
        // app successfully pushed code are warnings, not failures.
        const logLevel = isNonCritical ? "warn" : "error";
        const logPrefix = isNonCritical ? "Babysitter warning" : "Babysitter error";
        const errorMetadata = repoCacheTelemetry(error);

        await queueLog(currentPr.id, logLevel, `${logPrefix}: ${message}`, {
          phase: "run",
          metadata: errorMetadata,
        });

        const shouldRunCodeOwnerFallback = Boolean(
          options?.rethrowOnFailure
          && !recoveryMode
          && !forcedFixPrompt
          && !isNonCritical
          && !isAgentUnavailableError(error),
        );

        if (shouldRunCodeOwnerFallback) {
          try {
            const fallback = await runCodeOwnerFallbackAfterFailure({
              pr: currentPr,
              failureMessage: message,
            });
            await updateRunRecord({
              status: "completed",
              phase: "code-owner-fallback.completed",
              resolvedAgent: fallback.agent,
              prompt: fallback.prompt,
              metadata: {
                ...(runRecord.metadata ?? {}),
                defaultFailure: message,
                codeOwnerFallback: {
                  ...(isRecord(runRecord.metadata?.codeOwnerFallback) ? runRecord.metadata.codeOwnerFallback : {}),
                  status: "completed",
                  agent: fallback.agent,
                  timeoutMs: CODE_OWNER_FALLBACK_TIMEOUT_MS,
                  completedAt: this.now().toISOString(),
                },
              },
              lastError: null,
            });
            await this.storage.updatePR(currentPr.id, {
              status: "watching",
              lastChecked: this.now().toISOString(),
            });
            return;
          } catch (fallbackError) {
            const fallbackMessage = summarizeUnknownError(fallbackError);
            finalMessage = `${message}; code-owner fallback failed: ${fallbackMessage}`;
            rethrowError = new Error(finalMessage);
            await queueLog(currentPr.id, "error", `Code-owner fallback failed: ${fallbackMessage}`, {
              phase: "code-owner-fallback",
            });
            await updateRunRecord({
              phase: "code-owner-fallback.failed",
              metadata: {
                ...(runRecord.metadata ?? {}),
                codeOwnerFallback: {
                  ...(isRecord(runRecord.metadata?.codeOwnerFallback) ? runRecord.metadata.codeOwnerFallback : {}),
                  status: "failed",
                  failedAt: this.now().toISOString(),
                  error: fallbackMessage,
                },
              },
            });
          }
        }

        if (followUpTasks.length > 0) {
          const affectedIds = new Set(followUpTasks.map((item) => item.id));
          const updatedItems = currentPr.feedbackItems.map((item) => {
            if (!affectedIds.has(item.id)) return item;
            if (isNonCritical) {
              return markWarning(item, `GitHub comment could not be posted: ${message}`);
            }
            return markFailed(item, finalMessage);
          });
          const updatedCounters = countDecisions(updatedItems);
          await this.storage.updatePR(currentPr.id, {
            feedbackItems: updatedItems,
            accepted: updatedCounters.accepted,
            rejected: updatedCounters.rejected,
            flagged: updatedCounters.flagged,
            status: isNonCritical ? "watching" : "error",
            lastChecked: this.now().toISOString(),
          });
        } else {
          await this.storage.updatePR(currentPr.id, {
            status: isNonCritical ? "watching" : "error",
            lastChecked: this.now().toISOString(),
          });
        }
      }

      await updateRunRecord({
        status: "failed",
        phase: runRecord.status === "failed"
          ? runRecord.phase
          : runRecord.phase.startsWith("code-owner-fallback")
            ? "code-owner-fallback.failed"
            : "run.failed",
        lastError: finalMessage,
      });
      log.warn({ err: finalMessage, prId }, "Babysitter failure");
      if (error instanceof Error && error.stack) {
        log.debug({ stack: error.stack, prId }, "Babysitter failure stack");
      }
      if (options?.rethrowOnFailure && !isDependencyPreflightFailureMessage(message)) {
        throw rethrowError;
      }
    } finally {
      await logQueue;
      this.inProgress.delete(prId);
    }
  }
}
