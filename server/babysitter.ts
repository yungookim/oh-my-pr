import { randomUUID } from "crypto";
import type { FeedbackItem, PR } from "@shared/schema";
import type { IStorage } from "./storage";
import {
  applyFixesWithAgent,
  evaluateFixNecessityWithAgent,
  resolveAgent,
  runCommand,
  type CodingAgent,
} from "./agentRunner";
import {
  buildOctokit,
  fetchFeedbackItemsForPR,
  fetchPullSummary,
  formatRepoSlug,
  listFailingStatuses,
  listOpenPullsForRepo,
  parseRepoSlug,
  postFollowUpForFeedbackItem,
  resolveReviewThread,
  resolveGitHubAuthToken,
  type GitHubPullSummary,
  type ParsedPRUrl,
} from "./github";
import { getCodeFactoryPaths } from "./paths";
import { preparePrWorktree, removePrWorktree } from "./repoWorkspace";

const DEFAULT_GIT_USER_NAME = "PR Babysitter";
const DEFAULT_GIT_USER_EMAIL = "pr-babysitter@local";

type GitHubService = {
  buildOctokit: typeof buildOctokit;
  fetchFeedbackItemsForPR: typeof fetchFeedbackItemsForPR;
  fetchPullSummary: typeof fetchPullSummary;
  listFailingStatuses: typeof listFailingStatuses;
  listOpenPullsForRepo: typeof listOpenPullsForRepo;
  postFollowUpForFeedbackItem: typeof postFollowUpForFeedbackItem;
  resolveReviewThread: typeof resolveReviewThread;
  resolveGitHubAuthToken: typeof resolveGitHubAuthToken;
};

type BabysitterRuntime = {
  applyFixesWithAgent: typeof applyFixesWithAgent;
  evaluateFixNecessityWithAgent: typeof evaluateFixNecessityWithAgent;
  resolveAgent: typeof resolveAgent;
  runCommand: typeof runCommand;
};

const defaultGitHubService: GitHubService = {
  buildOctokit,
  fetchFeedbackItemsForPR,
  fetchPullSummary,
  listFailingStatuses,
  listOpenPullsForRepo,
  postFollowUpForFeedbackItem,
  resolveReviewThread,
  resolveGitHubAuthToken,
};

const defaultBabysitterRuntime: BabysitterRuntime = {
  applyFixesWithAgent,
  evaluateFixNecessityWithAgent,
  resolveAgent,
  runCommand,
};

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

    // Preserve triage decisions and action annotations across refreshes.
    return {
      ...item,
      decision: previous.decision,
      decisionReason: previous.decisionReason,
      action: previous.action,
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

function buildAgentFixPrompt(params: {
  pr: PR;
  pullSummary: GitHubPullSummary;
  remoteName: string;
  commentTasks: FeedbackItem[];
  statusTasks: { context: string; description: string; targetUrl: string | null }[];
}): string {
  const { pr, pullSummary, remoteName, commentTasks, statusTasks } = params;

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

  return [
    `You are acting as an autonomous PR babysitter for ${pr.repo} PR #${pr.number}.`,
    `PR URL: ${pr.url}`,
    `Base repository: ${pullSummary.repoFullName}`,
    `Head repository: ${pullSummary.headRepoFullName}`,
    `Head branch: ${pullSummary.headRef}`,
    `Head remote: ${remoteName}`,
    "You are running inside an isolated app-owned worktree under ~/.codefactory.",
    "Make only targeted changes that resolve the approved tasks.",
    "Do not wait for user input, confirmation, or approval at any point.",
    "Do not rewrite unrelated files.",
    "Use the available git tooling in this environment.",
    "GitHub follow-up replies and review-thread resolution will be handled by the babysitter after your run.",
    "If a task is invalid after inspection, explain it in your final response and include the exact audit token.",
    "",
    "Approved review-comment tasks:",
    commentSection,
    "",
    "Approved status-check tasks:",
    statusSection,
    "",
    "When done:",
    "1) Run the relevant verification for your changes.",
    `2) If you changed code, commit it and push it to ${remoteName} HEAD:${pullSummary.headRef}.`,
    "3) Summarize every addressed or blocked feedback item in your final response and include the exact audit token for each item.",
    "4) Summarize the code changes, verification, and git actions you completed.",
  ].join("\n");
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

  if (!hasAuditTrail(item, feedbackItems)) {
    return true;
  }

  return item.replyKind === "review_thread" && !item.threadResolved;
}

function collectGitHubFollowUpTasks(pr: PR): FeedbackItem[] {
  return pr.feedbackItems.filter((item) => needsGitHubFollowUp(item, pr.feedbackItems));
}

function buildFeedbackFollowUpBody(headSha: string, auditToken: string): string {
  const shortSha = headSha.trim() ? headSha.trim().slice(0, 7) : "";
  const summary = shortSha
    ? `Addressed in commit \`${shortSha}\` by the latest babysitter run.`
    : "Addressed in the latest babysitter run.";

  return [
    summary,
    "",
    auditToken,
  ].join("\n");
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function summarizeCommandFailure(result: Awaited<ReturnType<typeof runCommand>>): string {
  return result.stderr.trim() || result.stdout.trim() || "no output";
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

export class PRBabysitter {
  private readonly storage: IStorage;
  private readonly inProgress = new Set<string>();
  private readonly github: GitHubService;
  private readonly runtime: BabysitterRuntime;

  constructor(
    storage: IStorage,
    github: GitHubService = defaultGitHubService,
    runtime: BabysitterRuntime = defaultBabysitterRuntime,
  ) {
    this.storage = storage;
    this.github = github;
    this.runtime = runtime;
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
    const config = await this.storage.getConfig();
    const octokit = await this.github.buildOctokit(config);

    const tracked = await this.storage.getPRs();
    const repoCandidates = new Set<string>([
      ...tracked.map((pr) => pr.repo),
      ...config.watchedRepos,
    ]);

    const repos = Array.from(repoCandidates)
      .map((repo) => parseRepoSlug(repo))
      .filter((repo): repo is NonNullable<typeof repo> => Boolean(repo));

    for (const repo of repos) {
      const repoSlug = formatRepoSlug(repo);

      let openPulls;
      try {
        openPulls = await this.github.listOpenPullsForRepo(octokit, repo);
      } catch (error) {
        console.error(`Failed to list open PRs for ${repoSlug}`, error);
        continue;
      }

      for (const pull of openPulls) {
        let local = await this.storage.getPRByRepoAndNumber(repoSlug, pull.number);
        if (!local) {
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

        await this.storage.addLog(local.id, "info", "Watcher queued autonomous babysitter run", {
          phase: "watcher",
          metadata: { repo: repoSlug },
        });
        await this.babysitPR(local.id, config.codingAgent as CodingAgent);
      }
    }
  }

  async babysitPR(prId: string, preferredAgent: CodingAgent): Promise<void> {
    if (this.inProgress.has(prId)) {
      const pr = await this.storage.getPR(prId);
      if (pr) {
        await this.storage.addLog(pr.id, "warn", "Babysitter run skipped because another run is already in progress", {
          phase: "run",
        });
      }
      return;
    }

    this.inProgress.add(prId);
    const runId = randomUUID();
    const auditWindowStartMs = Math.floor(Date.now() / 1000) * 1000 - 1000;
    let logQueue = Promise.resolve();

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
	          console.error("Babysitter log write failed", logError);
	        });

      return logQueue;
    };

    const createChunkLogger = (
      currentPrId: string,
      phase: string,
      stream: "stdout" | "stderr",
      level: "info" | "warn",
    ) => {
      let buffer = "";

      return {
        onChunk: (chunk: string) => {
          const drained = drainChunkLines(buffer, chunk);
          buffer = drained.buffer;
          for (const line of drained.lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            void queueLog(currentPrId, level, `[${stream}] ${trimmed}`, {
              phase,
              metadata: { stream },
            });
          }
        },
        flush: async () => {
          const trimmed = buffer.trim();
          if (!trimmed) return;
          buffer = "";
          await queueLog(currentPrId, level, `[${stream}] ${trimmed}`, {
            phase,
            metadata: { stream },
          });
        },
      };
    };

    const runLoggedCommand = async (params: {
      currentPrId: string;
      command: string;
      args: string[];
      cwd?: string;
      timeoutMs?: number;
      phase: string;
      successMessage: string;
    }) => {
      const { currentPrId, command, args, cwd, timeoutMs, phase, successMessage } = params;

      await queueLog(currentPrId, "info", `Running ${formatCommand(command, args)}`, {
        phase,
      });

      const stdoutLogger = createChunkLogger(currentPrId, phase, "stdout", "info");
      const stderrLogger = createChunkLogger(currentPrId, phase, "stderr", "warn");

      const result = await this.runtime.runCommand(command, args, {
        cwd,
        timeoutMs,
        onStdoutChunk: stdoutLogger.onChunk,
        onStderrChunk: stderrLogger.onChunk,
      });

      await stdoutLogger.flush();
      await stderrLogger.flush();

      if (result.code === 0) {
        await queueLog(currentPrId, "info", successMessage, {
          phase,
          metadata: { command: formatCommand(command, args), code: result.code },
        });
      } else {
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

    try {
      await this.storage.updatePR(prId, {
        status: "processing",
        lastChecked: new Date().toISOString(),
      });
      await queueLog(prId, "info", `Babysitter run started using preferred agent ${preferredAgent}`, {
        phase: "run",
        metadata: { preferredAgent },
      });

      let pr = await this.syncFeedbackForPR(prId, {
        runId,
        logStart: true,
        phase: "sync",
      });
      const config = await this.storage.getConfig();
      const agent = await this.runtime.resolveAgent(preferredAgent);
      const parsedRepo = parseRepoSlug(pr.repo);

      if (!parsedRepo) {
        throw new Error(`Invalid repository slug: ${pr.repo}`);
      }

      await queueLog(pr.id, "info", `Resolved coding agent to ${agent}`, {
        phase: "run",
      });

      const octokit = await this.github.buildOctokit(config);
      const parsedPr: ParsedPRUrl = {
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        number: pr.number,
      };

      const pullSummary = await this.github.fetchPullSummary(octokit, parsedPr);
      const failingStatuses = await this.github.listFailingStatuses(octokit, parsedRepo, pullSummary.headSha);

      const pendingComments = pr.feedbackItems.filter((item) => item.decision === null);
      await queueLog(pr.id, "info", `Evaluating ${pendingComments.length} pending feedback item(s)`, {
        phase: "evaluate.comments",
      });

      const commentTasks: FeedbackItem[] = [];
      const commentDecisions = new Map<string, { decision: "accept" | "reject" | "flag"; reason: string }>();

      for (const item of pendingComments) {
        await queueLog(pr.id, "info", `Inspecting feedback from ${item.author}`, {
          phase: "evaluate.comments",
          metadata: {
            feedbackId: item.id,
            file: item.file,
            line: item.line,
          },
        });

        const evaluation = await this.runtime.evaluateFixNecessityWithAgent({
          agent,
          cwd: process.cwd(),
          prompt: buildCommentEvaluationPrompt({ pr, item }),
        });

        if (evaluation.needsFix) {
          commentTasks.push(item);
          commentDecisions.set(item.id, { decision: "accept", reason: evaluation.reason });
          await queueLog(pr.id, "info", `Accepted feedback ${item.id}: ${evaluation.reason}`, {
            phase: "evaluate.comments",
            metadata: { feedbackId: item.id, decision: "accept" },
          });
        } else {
          commentDecisions.set(item.id, { decision: "reject", reason: evaluation.reason });
          await queueLog(pr.id, "info", `Rejected feedback ${item.id}: ${evaluation.reason}`, {
            phase: "evaluate.comments",
            metadata: { feedbackId: item.id, decision: "reject" },
          });
        }
      }

      const statusTasks: { context: string; description: string; targetUrl: string | null }[] = [];
      await queueLog(pr.id, "info", `Evaluating ${failingStatuses.length} failing status check(s)`, {
        phase: "evaluate.status",
      });
      for (const status of failingStatuses) {
        const evaluation = await this.runtime.evaluateFixNecessityWithAgent({
          agent,
          cwd: process.cwd(),
          prompt: buildStatusEvaluationPrompt({
            pr,
            context: status.context,
            description: status.description,
            targetUrl: status.targetUrl,
          }),
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

      if (commentDecisions.size > 0) {
        const updatedItems = pr.feedbackItems.map((item) => {
          const decision = commentDecisions.get(item.id);
          if (!decision) return item;

          return {
            ...item,
            decision: decision.decision,
            decisionReason: decision.reason,
            action: decision.decision === "accept" ? item.body : null,
          };
        });

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

      const followUpTasks = collectGitHubFollowUpTasks(pr);

      if (commentTasks.length === 0 && statusTasks.length === 0 && followUpTasks.length === 0) {
        await queueLog(pr.id, "info", `Babysitter checked PR #${pr.number}; no necessary fixes identified`, {
          phase: "run",
        });
        await this.storage.updatePR(pr.id, {
          status: "watching",
          lastChecked: new Date().toISOString(),
        });
        return;
      }

      let headShaForFollowUp = pullSummary.headSha;
      let branchMoved = false;
      let remoteNameForLogs: string | null = null;

      if (commentTasks.length > 0 || statusTasks.length > 0) {
        await queueLog(
          pr.id,
          "info",
          `Babysitter preparing fix run with ${commentTasks.length} comment task(s), ${statusTasks.length} status task(s), and ${followUpTasks.length} GitHub follow-up task(s) using ${agent}`,
          {
            phase: "run",
            metadata: {
              commentTasks: commentTasks.length,
              statusTasks: statusTasks.length,
              followUpTasks: followUpTasks.length,
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

          const agentStdout = createChunkLogger(pr.id, "agent", "stdout", "info");
          const agentStderr = createChunkLogger(pr.id, "agent", "stderr", "warn");
          const githubToken = await this.github.resolveGitHubAuthToken(config);
          const agentEnv = githubToken
            ? {
                ...process.env,
                GITHUB_TOKEN: githubToken,
                GH_TOKEN: githubToken,
              }
            : undefined;
          await queueLog(pr.id, "info", `Launching ${agent} in autonomous mode`, {
            phase: "agent",
            metadata: { githubAuth: Boolean(githubToken) },
          });

          const applyResult = await this.runtime.applyFixesWithAgent({
            agent,
            cwd: worktreePath,
            prompt: buildAgentFixPrompt({
              pr,
              pullSummary,
              remoteName,
              commentTasks,
              statusTasks,
            }),
            env: agentEnv,
            onStdoutChunk: agentStdout.onChunk,
            onStderrChunk: agentStderr.onChunk,
          });
          await agentStdout.flush();
          await agentStderr.flush();

          if (applyResult.code !== 0) {
            throw new Error(`Agent apply failed (${applyResult.code}): ${applyResult.stderr || applyResult.stdout}`);
          }
          await queueLog(pr.id, "info", `${agent} completed successfully`, {
            phase: "agent",
            metadata: { code: applyResult.code },
          });

          const status = await runLoggedCommand({
            currentPrId: pr.id,
            command: "git",
            args: ["status", "--porcelain"],
            cwd: worktreePath,
            timeoutMs: 5000,
            phase: "verify.git.status",
            successMessage: "Collected worktree git status",
          });
          if (status.code !== 0) {
            throw new Error(`git status failed: ${status.stderr || status.stdout}`);
          }

          if (status.stdout.trim()) {
            throw new Error(`Agent left uncommitted changes in the worktree: ${status.stdout.trim()}`);
          }
          await queueLog(pr.id, "info", "Worktree is clean after agent run", {
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
          const remoteHeadSha = remoteHead.stdout.trim();
          branchMoved = remoteHeadSha !== pullSummary.headSha;
          const localCommitCreated = localHeadSha !== pullSummary.headSha;

          if (localCommitCreated && remoteHeadSha !== localHeadSha) {
            throw new Error("Agent created a local commit but did not push it to the PR head branch");
          }

          if (statusTasks.length > 0 && !branchMoved) {
            throw new Error("Agent did not update the PR head branch for accepted failing status tasks");
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
            },
          });
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

      for (const item of followUpTasks) {
        const shouldPostFollowUp = !hasAuditTrail(item, pr.feedbackItems);
        const shouldResolveThread = item.replyKind === "review_thread" && !item.threadResolved;

        if (shouldPostFollowUp) {
          await queueLog(pr.id, "info", `Posting GitHub follow-up for ${item.id}`, {
            phase: "github.followup",
            metadata: {
              feedbackId: item.id,
              replyKind: item.replyKind,
            },
          });

          const body = buildFeedbackFollowUpBody(headShaForFollowUp, item.auditToken);
          await this.github.postFollowUpForFeedbackItem(octokit, parsedPr, item, body);
        }

        if (shouldResolveThread) {
          if (!item.threadId) {
            throw new Error(`Missing review thread metadata for ${item.id}`);
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
        throw new Error(`GitHub audit trail verification failed: ${auditTrailErrors.join("; ")}`);
      }

      await queueLog(pr.id, "info", "GitHub audit trail verified", {
        phase: "verify.github",
        metadata: {
          verifiedComments: followUpTasks.length,
          remoteName: remoteNameForLogs,
          branchMoved,
        },
      });

      await this.storage.updatePR(pr.id, {
        status: "watching",
        lastChecked: new Date().toISOString(),
      });
      await queueLog(pr.id, "info", "Babysitter run complete", {
        phase: "run",
        metadata: { remoteName: remoteNameForLogs, branchMoved },
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pr = await this.storage.getPR(prId);
      if (pr) {
        await queueLog(pr.id, "error", `Babysitter error: ${message}`, {
          phase: "run",
        });
        await this.storage.updatePR(pr.id, { status: "error", lastChecked: new Date().toISOString() });
      }
      console.error("Babysitter failure", error);
    } finally {
      await logQueue;
      this.inProgress.delete(prId);
    }
  }
}
