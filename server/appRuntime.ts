import { EventEmitter } from "node:events";
import type {
  ActivityItem,
  ActivitySnapshot,
  BackgroundJob,
  Config,
  DeploymentHealingSession,
  HealingSession,
  LogEntry,
  OperatorWarning,
  PR,
  PRQuestion,
  ReleaseRun,
  RuntimeState,
  SocialChangelog,
  WatchedRepo,
} from "@shared/schema";
import { z } from "zod";
import { addPRSchema, askQuestionSchema } from "@shared/schema";
import type { IStorage } from "./storage";
import { getDefaultStorage } from "./storage";
import { PRBabysitter } from "./babysitter";
import { detectAgentUnavailability, type AgentUnavailabilityKind } from "./agentRunner";
import { applyEvaluationDecision, applyFlagDecision } from "./feedbackLifecycle";
import { applyManualFeedbackDecision } from "./manualFeedback";
import { childLogger } from "./logger";

const log = childLogger("runtime");
import { createBackgroundJobHandlers } from "./backgroundJobHandlers";
import { BackgroundJobDispatcher } from "./backgroundJobDispatcher";
import { BackgroundJobQueue, buildBackgroundJobDedupeKey } from "./backgroundJobQueue";
import { buildActivityPayload, readActivityPayload } from "./activityPayload";
import { createWatcherScheduler, type WatcherScheduler } from "./watcherScheduler";
import { ReleaseManager } from "./releaseManager";
import type { ReleaseAgentPullSummary } from "./releaseAgent";
import { DeploymentHealingManager } from "./deploymentHealingManager";
import {
  buildOctokit,
  checkOnboardingStatus,
  createGitHubRelease,
  fetchPullSummary,
  formatRepoSlug,
  getDefaultBranchForRepo,
  getLatestSemverTagForRepo,
  GitHubIntegrationError,
  installCodeReviewWorkflow,
  listReleasesForRepo,
  listUnreleasedMergedPulls,
  type MergedPRSummary,
  parsePRUrl,
  parseRepoSlug,
  resolveNextSemverTag,
} from "./github";

export class AppRuntimeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AppRuntimeError";
    this.statusCode = statusCode;
  }
}

export type AppRuntimeDependencies = {
  storage?: IStorage;
  backgroundJobQueue?: BackgroundJobQueue;
  backgroundJobDispatcher?: BackgroundJobDispatcher;
  releaseManager?: ReleaseManager;
  deploymentHealingManager?: DeploymentHealingManager;
  babysitter?: PRBabysitter;
  watcherScheduler?: WatcherScheduler;
  startBackgroundServices?: boolean;
  startWatcher?: boolean;
};

export type RuntimeSnapshot = RuntimeState & {
  activeRuns: number;
};

export type DrainModeParams = {
  enabled: boolean;
  reason?: string;
  waitForIdle?: boolean;
  timeoutMs?: number;
};

export type AppRuntime = {
  start(): Promise<void>;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getRuntimeSnapshot(): Promise<RuntimeSnapshot>;
  setDrainMode(input: DrainModeParams): Promise<RuntimeSnapshot & { drained?: boolean }>;
  listActivities(): Promise<ActivitySnapshot>;
  clearFailedActivities(): Promise<{ cleared: number }>;
  listRepos(): Promise<string[]>;
  listRepoSettings(): Promise<WatchedRepo[]>;
  addRepo(repoInput: string): Promise<{ repo: string }>;
  updateRepoSettings(repoInput: string, updates: Partial<Omit<WatchedRepo, "repo">>): Promise<WatchedRepo>;
  syncRepos(): Promise<{ ok: true }>;
  createManualRelease(repoInput: string): Promise<ReleaseRun>;
  listPRs(view?: "active" | "archived"): Promise<PR[]>;
  getPR(id: string): Promise<PR | null>;
  addPR(url: string): Promise<PR>;
  removePR(id: string): Promise<{ ok: true }>;
  setWatchEnabled(id: string, enabled: boolean): Promise<PR>;
  setPRWatchEnabled(id: string, enabled: boolean): Promise<PR>;
  fetchPRFeedback(id: string): Promise<PR>;
  triagePR(id: string): Promise<PR>;
  applyPR(id: string): Promise<PR>;
  queueBabysit(id: string): Promise<PR>;
  babysitPR(id: string): Promise<PR>;
  setFeedbackDecision(prId: string, feedbackId: string, decision: "accept" | "reject" | "flag"): Promise<PR>;
  retryFeedback(prId: string, feedbackId: string): Promise<PR>;
  listPRQuestions(prId: string): Promise<PRQuestion[]>;
  askQuestion(prId: string, question: string): Promise<PRQuestion>;
  listLogs(prId?: string): Promise<LogEntry[]>;
  getOnboardingStatus(): Promise<unknown>;
  installReviewWorkflow(repo: string, tool: "claude" | "codex"): Promise<unknown>;
  listHealingSessions(): Promise<HealingSession[]>;
  getHealingSession(id: string): Promise<HealingSession>;
  listDeploymentHealingSessions(repo?: string): Promise<DeploymentHealingSession[]>;
  getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession>;
  getConfig(): Promise<Config>;
  updateConfig(updates: Partial<Config>): Promise<Config>;
  listSocialChangelogs(): Promise<SocialChangelog[]>;
  getSocialChangelog(id: string): Promise<SocialChangelog>;
  listReleaseRuns(): Promise<ReleaseRun[]>;
  getReleaseRun(id: string): Promise<ReleaseRun>;
  retryReleaseRun(id: string): Promise<ReleaseRun>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertFound<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new AppRuntimeError(404, message);
  }

  return value;
}

function fallbackJobLabel(job: BackgroundJob): string {
  switch (job.kind) {
    case "sync_watched_repos":
      return "Sync watched repositories";
    case "babysit_pr":
      return "Babysitting PR";
    case "process_release_run":
      return "Processing release";
    case "answer_pr_question":
      return "Answering PR question";
    case "generate_social_changelog":
      return "Social changelog generation removed";
    case "heal_deployment":
      return "Healing deployment";
  }
}

type ActivityDescription = Pick<ActivityItem, "label" | "detail" | "targetUrl">;

type ActivityDescriptionContext = {
  prsById: Map<string, PR>;
  releaseRunsById: Map<string, ReleaseRun>;
  socialChangelogsById: Map<string, SocialChangelog>;
  deploymentHealingSessionsByTarget: Map<string, DeploymentHealingSession>;
};

function readJobStringPayload(job: BackgroundJob, key: string): string | null {
  const value = job.payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

type AgentLabel = "Claude" | "Codex";

type AgentAvailabilityFailure = {
  agentLabel: AgentLabel;
  kind: AgentUnavailabilityKind;
  fixSteps: string[];
};

function buildCliMissingFixSteps(agentLabel: AgentLabel, command: "claude" | "codex"): string[] {
  return [
    `Install the ${agentLabel === "Claude" ? "Claude Code" : "Codex"} CLI on this machine.`,
    `If ${agentLabel} is already installed, make sure oh-my-pr can find it on PATH. The app checks its process PATH, then \`$SHELL -lc "command -v ${command}"\`.`,
    "For nvm installs, add the active Node bin directory to a login-shell startup file such as ~/.zprofile; for example: export PATH=\"$HOME/.nvm/versions/node/<version>/bin:$PATH\".",
    `Verify with \`command -v ${command}\` and \`$SHELL -lc "command -v ${command}"\`.`,
    "Restart oh-my-pr after installing.",
    "Rerun the babysitter for this PR.",
  ];
}

const AGENT_FIX_STEPS: Record<AgentLabel, Record<AgentUnavailabilityKind, string[]>> = {
  Claude: {
    auth: [
      "Run `claude auth login` on this machine.",
      "Restart oh-my-pr if it was launched before you refreshed credentials.",
      "Rerun the babysitter for this PR.",
    ],
    cli_missing: buildCliMissingFixSteps("Claude", "claude"),
    unknown_agent: [
      "Open Settings and choose a supported coding agent.",
      "Restart oh-my-pr if the agent setting was changed outside the app.",
      "Rerun the babysitter for this PR.",
    ],
  },
  Codex: {
    auth: [
      "Run `codex login` on this machine.",
      "Check ownership and permissions for ~/.codex, especially ~/.codex/sessions, so oh-my-pr can access Codex session files.",
      "Restart oh-my-pr if it was launched before you refreshed credentials.",
      "Rerun the babysitter for this PR.",
    ],
    cli_missing: buildCliMissingFixSteps("Codex", "codex"),
    unknown_agent: [
      "Open Settings and choose a supported coding agent.",
      "Restart oh-my-pr if the agent setting was changed outside the app.",
      "Rerun the babysitter for this PR.",
    ],
  },
};

function buildAgentAvailabilityFailure(
  agentLabel: AgentLabel,
  kind: AgentUnavailabilityKind,
): AgentAvailabilityFailure {
  return {
    agentLabel,
    kind,
    fixSteps: AGENT_FIX_STEPS[agentLabel][kind],
  };
}

function detectAgentLabelFromError(error: string): AgentLabel | null {
  const lower = error.toLowerCase();
  if (lower.includes("claude evaluation failed") || lower.includes("claude apply failed")) {
    return "Claude";
  }
  if (lower.includes("codex evaluation failed") || lower.includes("codex apply failed")) {
    return "Codex";
  }
  return null;
}

function classifyAgentAvailabilityFailure(job: BackgroundJob): AgentAvailabilityFailure | null {
  if (job.kind !== "babysit_pr" || !job.lastError) {
    return null;
  }

  const kind = detectAgentUnavailability(job.lastError);
  if (!kind) {
    return null;
  }

  const agentLabel = detectAgentLabelFromError(job.lastError);
  if (agentLabel) {
    return buildAgentAvailabilityFailure(agentLabel, kind);
  }

  const preferredAgent = readJobStringPayload(job, "preferredAgent");
  if (preferredAgent === "claude") {
    return buildAgentAvailabilityFailure("Claude", kind);
  }
  if (preferredAgent === "codex") {
    return buildAgentAvailabilityFailure("Codex", kind);
  }

  return null;
}

export function mapMergedPullsToReleaseSummaries(pulls: MergedPRSummary[]): ReleaseAgentPullSummary[] {
  return pulls.flatMap((pull) => {
    const mergeSha = pull.mergeCommitSha?.trim();
    if (!mergeSha) {
      return [];
    }

    return [{
      number: pull.number,
      title: pull.title,
      url: pull.url,
      author: pull.author,
      repo: pull.repo,
      mergedAt: pull.mergedAt,
      mergeSha,
    }];
  });
}

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
  const storage = dependencies.storage ?? getDefaultStorage();
  const events = new EventEmitter();
  const backgroundJobQueue = dependencies.backgroundJobQueue ?? new BackgroundJobQueue(storage);
  // eslint-disable-next-line prefer-const -- circular dep: closure references this before it can be initialized
  let backgroundJobDispatcher!: BackgroundJobDispatcher;

  const scheduleBackgroundJob = async (...args: Parameters<BackgroundJobQueue["enqueue"]>) => {
    const job = await backgroundJobQueue.enqueue(...args);
    backgroundJobDispatcher.wake();
    return job;
  };

  const deploymentHealingManager = dependencies.deploymentHealingManager ?? new DeploymentHealingManager(storage);
  const releaseManager = dependencies.releaseManager ?? new ReleaseManager(storage, {
    github: {
      buildOctokit,
      getDefaultBranch: getDefaultBranchForRepo,
      findLatestSemverReleaseTag: getLatestSemverTagForRepo,
      bumpReleaseTag: resolveNextSemverTag,
      listUnreleasedMergedPulls: async (octokit, repo, options) => {
        const merged = await listUnreleasedMergedPulls(octokit, repo, {
          baseRef: options.baseBranch,
        });

        return mapMergedPullsToReleaseSummaries(merged);
      },
      listMergedPullsForReleaseCandidate: async (octokit, repo, options) => {
        const merged = await listUnreleasedMergedPulls(octokit, repo, {
          baseRef: options.baseBranch,
        });
        const cutoffMs = Date.parse(options.untilMergedAt);

        return mapMergedPullsToReleaseSummaries(
          merged.filter((pull) => !Number.isFinite(cutoffMs) || Date.parse(pull.mergedAt) <= cutoffMs),
        );
      },
      findReleaseByTag: async (octokit, repo, tagName) => {
        const releases = await listReleasesForRepo(octokit, repo);
        const existing = releases.find((release) => !release.draft && release.tagName === tagName);
        if (!existing) {
          return null;
        }

        return {
          id: existing.id,
          url: existing.htmlUrl,
          tagName: existing.tagName,
          name: existing.name,
        };
      },
      createGitHubRelease: async (octokit, repo, params) => {
        const created = await createGitHubRelease(octokit, repo, {
          tagName: params.tagName,
          targetCommitish: params.targetCommitish,
          name: params.name,
          body: params.body,
        });

        return {
          id: created.id,
          url: created.htmlUrl,
          tagName: created.tagName,
          name: created.name,
        };
      },
    },
    scheduleBackgroundJob,
  });

  const babysitter = dependencies.babysitter ?? new PRBabysitter(
    storage,
    undefined,
    undefined,
    releaseManager,
    scheduleBackgroundJob,
    deploymentHealingManager,
  );

  backgroundJobDispatcher = dependencies.backgroundJobDispatcher ?? new BackgroundJobDispatcher({
    storage,
    queue: backgroundJobQueue,
    handlers: createBackgroundJobHandlers({
      storage,
      babysitter,
      releaseManager,
      deploymentHealingManager,
    }),
    onReclaimedJobs: (jobs) => {
      for (const job of jobs) {
        if (job.kind !== "babysit_pr") {
          continue;
        }

        void storage.addLog(job.targetId, "warn", `Reclaimed expired background job ${job.id} for PR ${job.targetId}`, {
          phase: "background.job",
          metadata: {
            jobId: job.id,
            kind: job.kind,
            leaseOwner: job.leaseOwner,
            leaseExpiresAt: job.leaseExpiresAt,
            attemptCount: job.attemptCount,
          },
        }).catch((error) => {
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Failed to log reclaimed background job",
          );
        });
      }
    },
  });

  let watcherTimer: NodeJS.Timeout | null = null;
  let watcherIntervalMs = 0;
  const watcherScheduler = dependencies.watcherScheduler ?? createWatcherScheduler(
    async () => {
      await scheduleBackgroundJob(
        "sync_watched_repos",
        "runtime:1",
        buildBackgroundJobDedupeKey("sync_watched_repos", "runtime:1"),
      );
    },
    (error) => {
      void storage.updateRuntimeState({
        watcherLastError: error instanceof Error ? error.message : String(error),
      });
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Repository babysitter watcher failed",
      );
    },
  );
  const runWatcher = watcherScheduler.run;

  const startBackgroundServices = dependencies.startBackgroundServices ?? true;
  const startWatcher = dependencies.startWatcher ?? startBackgroundServices;
  let started = false;

  const notifyChange = () => {
    events.emit("change");
  };

  const getRuntimeSnapshot = async (): Promise<RuntimeSnapshot> => {
    const state = await storage.getRuntimeState();
    return {
      ...state,
      activeRuns: backgroundJobDispatcher.getActiveRunCount(),
    };
  };

  const buildActivityDescriptionContext = async (jobs: BackgroundJob[]): Promise<ActivityDescriptionContext> => {
    const prIds = new Set<string>();
    const releaseRunIds = new Set<string>();
    const socialChangelogIds = new Set<string>();
    const deploymentHealingTargets = new Set<string>();

    for (const job of jobs) {
      if (job.kind === "babysit_pr") {
        prIds.add(job.targetId);
      } else if (job.kind === "answer_pr_question") {
        const prId = readJobStringPayload(job, "prId");
        if (prId) {
          prIds.add(prId);
        }
      } else if (job.kind === "process_release_run") {
        releaseRunIds.add(job.targetId);
      } else if (job.kind === "generate_social_changelog") {
        socialChangelogIds.add(job.targetId);
      } else if (job.kind === "heal_deployment") {
        deploymentHealingTargets.add(job.targetId);
      }
    }

    const [activePrs, archivedPrs, releaseRuns, socialChangelogs, deploymentHealingSessions] = await Promise.all([
      prIds.size > 0 ? storage.getPRs() : Promise.resolve([]),
      prIds.size > 0 ? storage.getArchivedPRs() : Promise.resolve([]),
      releaseRunIds.size > 0 ? storage.listReleaseRuns() : Promise.resolve([]),
      socialChangelogIds.size > 0 ? storage.getSocialChangelogs() : Promise.resolve([]),
      deploymentHealingTargets.size > 0 ? storage.listDeploymentHealingSessions() : Promise.resolve([]),
    ]);

    const deploymentHealingSessionsByTarget = new Map<string, DeploymentHealingSession>();
    for (const session of deploymentHealingSessions) {
      deploymentHealingSessionsByTarget.set(session.id, session);
      deploymentHealingSessionsByTarget.set(`${session.repo}:${session.mergeSha}`, session);
    }

    return {
      prsById: new Map([...activePrs, ...archivedPrs].map((pr) => [pr.id, pr])),
      releaseRunsById: new Map(releaseRuns.map((run) => [run.id, run])),
      socialChangelogsById: new Map(socialChangelogs.map((changelog) => [changelog.id, changelog])),
      deploymentHealingSessionsByTarget,
    };
  };

  const describeActivityJob = (job: BackgroundJob, context: ActivityDescriptionContext): ActivityDescription => {
    const payloadDescription = readActivityPayload(job.payload);
    if (payloadDescription) {
      return payloadDescription;
    }

    if (job.kind === "sync_watched_repos") {
      return {
        label: "Sync watched repositories",
        detail: null,
        targetUrl: null,
      };
    }

    if (job.kind === "babysit_pr") {
      const pr = context.prsById.get(job.targetId);
      if (pr) {
        return {
          label: `Babysitting PR #${pr.number}`,
          detail: `${pr.repo} - ${pr.title}`,
          targetUrl: pr.url,
        };
      }
    }

    if (job.kind === "answer_pr_question") {
      const prId = readJobStringPayload(job, "prId");
      const pr = prId ? context.prsById.get(prId) : undefined;
      if (pr) {
        return {
          label: `Answering question for PR #${pr.number}`,
          detail: `${pr.repo} - ${pr.title}`,
          targetUrl: pr.url,
        };
      }
    }

    if (job.kind === "process_release_run") {
      const run = context.releaseRunsById.get(job.targetId);
      if (run) {
        return {
          label: `Processing release for ${run.repo}`,
          detail: `PR #${run.triggerPrNumber} - ${run.triggerPrTitle}`,
          targetUrl: run.triggerPrUrl,
        };
      }
    }

    if (job.kind === "generate_social_changelog") {
      const changelog = context.socialChangelogsById.get(job.targetId);
      if (changelog) {
        return {
          label: "Social changelog generation removed",
          detail: `${changelog.date} - ${changelog.triggerCount} merged PRs`,
          targetUrl: null,
        };
      }
    }

    if (job.kind === "heal_deployment") {
      const session = context.deploymentHealingSessionsByTarget.get(job.targetId);
      if (session) {
        return {
          label: `Healing ${session.platform} deployment`,
          detail: `${session.repo} PR #${session.triggerPrNumber} - ${session.triggerPrTitle}`,
          targetUrl: session.triggerPrUrl,
        };
      }
    }

    return {
      label: fallbackJobLabel(job),
      detail: job.targetId,
      targetUrl: null,
    };
  };

  const mapActivityJob = (job: BackgroundJob, context: ActivityDescriptionContext): ActivityItem => {
    const description = describeActivityJob(job, context);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status === "leased" ? "in_progress" : job.status === "failed" ? "failed" : "queued",
      label: description.label,
      detail: description.detail,
      targetId: job.targetId,
      targetUrl: description.targetUrl,
      queuedAt: job.createdAt,
      availableAt: job.availableAt,
      startedAt: job.heartbeatAt,
      updatedAt: job.updatedAt,
      attemptCount: job.attemptCount,
      lastError: job.lastError,
    };
  };

  const isFailedActivityForArchivedPR = (job: BackgroundJob, context: ActivityDescriptionContext): boolean => {
    if (job.kind === "babysit_pr") {
      return context.prsById.get(job.targetId)?.status === "archived";
    }

    if (job.kind === "answer_pr_question") {
      const prId = readJobStringPayload(job, "prId");
      return prId ? context.prsById.get(prId)?.status === "archived" : false;
    }

    return false;
  };

  const mapOperatorWarning = (job: BackgroundJob, context: ActivityDescriptionContext): OperatorWarning | null => {
    const failure = classifyAgentAvailabilityFailure(job);
    if (!failure) {
      return null;
    }

    const pr = context.prsById.get(job.targetId);
    if (!pr || pr.status !== "error") {
      return null;
    }

    const titleSuffix = failure.kind === "auth" ? "authentication failed" : "CLI not installed";
    const reason = failure.kind === "auth"
      ? "local agent credentials are invalid or expired"
      : "the agent CLI is not installed on this machine";

    return {
      id: job.id,
      severity: "warning",
      title: `${failure.agentLabel} ${titleSuffix}`,
      message: `Babysitter could not run ${failure.agentLabel} for PR #${pr.number} in ${pr.repo} because ${reason}.`,
      fixSteps: failure.fixSteps,
      targetId: job.targetId,
      targetUrl: pr.url,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  };

  const waitForBackgroundIdle = async (timeoutMs: number): Promise<boolean> => {
    const [dispatcherIdle, babysitterIdle, releaseIdle] = await Promise.all([
      backgroundJobDispatcher.waitForIdle(timeoutMs),
      babysitter.waitForIdle(timeoutMs),
      releaseManager.waitForIdle(timeoutMs),
    ]);

    return dispatcherIdle && babysitterIdle && releaseIdle;
  };

  const refreshWatcherSchedule = async () => {
    const config = await storage.getConfig();
    const interval = Math.max(10_000, config.pollIntervalMs || 120_000);

    if (watcherTimer && watcherIntervalMs === interval) {
      return;
    }

    if (watcherTimer) {
      clearInterval(watcherTimer);
      watcherTimer = null;
    }

    watcherIntervalMs = interval;
    watcherTimer = setInterval(() => {
      const heartbeatAt = new Date().toISOString();
      void storage.updateRuntimeState({
        watcherHeartbeatAt: heartbeatAt,
        watcherIntervalMs,
      });
      log.info({ pollIntervalMs: watcherIntervalMs }, "Repository watcher heartbeat");
      void runWatcher();
    }, interval);
    const startedAt = new Date().toISOString();
    await storage.updateRuntimeState({
      watcherStartedAt: startedAt,
      watcherHeartbeatAt: startedAt,
      watcherCompletedAt: null,
      watcherLastError: null,
      watcherIntervalMs: interval,
    });
    log.info({ pollIntervalMs: interval }, "Repository watcher started");
  };

  const queueBabysitWithAgent = async (pr: PR, preferredAgent: Config["codingAgent"]) => {
    await scheduleBackgroundJob(
      "babysit_pr",
      pr.id,
      buildBackgroundJobDedupeKey("babysit_pr", pr.id),
      {
        preferredAgent,
        ...buildActivityPayload({
          label: `Babysitting PR #${pr.number}`,
          detail: `${pr.repo} - ${pr.title}`,
          targetUrl: pr.url,
        }),
      },
    );
  };

  const buildManualDrainBlockMessage = (runtimeState: RuntimeState): string => {
    const base = "Drain mode is enabled. Manual runs are blocked until drain mode is disabled.";
    return runtimeState.drainReason ? `${base} Reason: ${runtimeState.drainReason}` : base;
  };

  const rejectManualRunDuringDrain = async (
    runtimeState: RuntimeState,
    options: {
      pr?: PR;
      logMessageBase?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<never> => {
    const message = buildManualDrainBlockMessage(runtimeState);
    const logMessageBase = options.logMessageBase ?? "Manual run blocked because drain mode is enabled";
    const logMessage = runtimeState.drainReason
      ? `${logMessageBase}. Reason: ${runtimeState.drainReason}`
      : `${logMessageBase}.`;
    const metadata = {
      drainReason: runtimeState.drainReason,
      drainRequestedAt: runtimeState.drainRequestedAt,
      ...options.metadata,
    };

    if (options.pr) {
      await storage.addLog(options.pr.id, "warn", logMessage, {
        phase: "run",
        metadata,
      });
      notifyChange();
    } else {
      log.warn(metadata, logMessageBase);
    }

    throw new AppRuntimeError(409, message);
  };

  const runtime: AppRuntime = {
    async start() {
      if (started) {
        return;
      }

      started = true;

      if (startBackgroundServices) {
        await backgroundJobDispatcher.start();
      }

      if (startWatcher) {
        await refreshWatcherSchedule();
        void babysitter.resumeInterruptedRuns();
        void runWatcher();
      }
    },

    stop() {
      started = false;
      backgroundJobDispatcher.stop();
      if (watcherTimer) {
        clearInterval(watcherTimer);
        watcherTimer = null;
        void storage.updateRuntimeState({
          watcherCompletedAt: new Date().toISOString(),
        });
        log.info({ pollIntervalMs: watcherIntervalMs }, "Repository watcher stopped");
      }
    },

    subscribe(listener) {
      events.on("change", listener);
      return () => {
        events.off("change", listener);
      };
    },

    getRuntimeSnapshot,

    async listActivities() {
      const [failedJobs, leasedJobs, queuedJobs] = await Promise.all([
        storage.listBackgroundJobs({ status: "failed" }),
        storage.listBackgroundJobs({ status: "leased" }),
        storage.listBackgroundJobs({ status: "queued" }),
      ]);

      const descriptionContext = await buildActivityDescriptionContext([...failedJobs, ...leasedJobs, ...queuedJobs]);
      const visibleFailedJobs = failedJobs.filter((job) => !isFailedActivityForArchivedPR(job, descriptionContext));
      const failedWarningJobs = visibleFailedJobs.filter((job) => classifyAgentAvailabilityFailure(job));
      const failed = visibleFailedJobs.map((job) => mapActivityJob(job, descriptionContext));
      const inProgress = leasedJobs.map((job) => mapActivityJob(job, descriptionContext));
      const queued = queuedJobs.map((job) => mapActivityJob(job, descriptionContext));
      const warnings = failedWarningJobs
        .map((job) => mapOperatorWarning(job, descriptionContext))
        .filter((warning): warning is OperatorWarning => Boolean(warning))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 5);

      return {
        failed,
        inProgress,
        queued,
        warnings,
        generatedAt: new Date().toISOString(),
      };
    },

    async clearFailedActivities() {
      const cleared = await storage.clearFailedBackgroundJobs();
      if (cleared > 0) {
        notifyChange();
      }
      return { cleared };
    },

    async setDrainMode(input) {
      const updated = await storage.updateRuntimeState({
        drainMode: input.enabled,
        drainRequestedAt: input.enabled ? new Date().toISOString() : null,
        drainReason: input.enabled ? input.reason ?? null : null,
      });

      if (input.enabled) {
        log.warn({
          drainRequestedAt: updated.drainRequestedAt,
          drainReason: updated.drainReason,
          waitForIdle: Boolean(input.waitForIdle),
        }, "Drain mode enabled");
      } else {
        log.info("Drain mode disabled");
      }

      if (input.enabled && input.waitForIdle) {
        const drained = await waitForBackgroundIdle(input.timeoutMs ?? 120_000);
        const snapshot = await getRuntimeSnapshot();
        notifyChange();
        return {
          ...updated,
          ...snapshot,
          drained,
        };
      }

      const snapshot = await getRuntimeSnapshot();
      notifyChange();
      return {
        ...updated,
        ...snapshot,
      };
    },

    async listRepos() {
      const config = await storage.getConfig();
      const prs = await storage.getPRs();

      return Array.from(new Set([
        ...config.watchedRepos,
        ...prs.map((pr) => pr.repo),
      ])).sort((a, b) => a.localeCompare(b));
    },

    async listRepoSettings() {
      const [configuredRepos, prs] = await Promise.all([
        storage.listRepoSettings(),
        storage.getPRs(),
      ]);
      const byRepo = new Map(configuredRepos.map((repo) => [repo.repo, repo]));

      for (const pr of prs) {
        if (!byRepo.has(pr.repo)) {
          byRepo.set(pr.repo, {
            repo: pr.repo,
            autoCreateReleases: false,
            ownPrsOnly: true,
          });
        }
      }

      return Array.from(byRepo.values()).sort((a, b) => a.repo.localeCompare(b.repo));
    },

    async addRepo(repoInput) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const config = await storage.getConfig();
      if (!config.watchedRepos.includes(canonical)) {
        await storage.updateConfig({
          watchedRepos: [...config.watchedRepos, canonical].sort((a, b) => a.localeCompare(b)),
        });
      }

      void runWatcher();
      notifyChange();
      return { repo: canonical };
    },

    async updateRepoSettings(repoInput, updates) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const updated = await storage.updateRepoSettings(canonical, updates);
      notifyChange();
      return updated;
    },

    async syncRepos() {
      await watcherScheduler.runAndReportErrors();
      notifyChange();
      return { ok: true as const };
    },

    async createManualRelease(repoInput) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          logMessageBase: "Manual release run blocked because drain mode is enabled",
          metadata: { repo: canonical },
        });
      }

      const release = await releaseManager.enqueueManualRepoRelease(canonical);
      if (!release) {
        throw new AppRuntimeError(409, `No unreleased merged pull requests found for ${canonical}`);
      }

      notifyChange();
      return release;
    },

    async listPRs(view = "active") {
      if (view === "archived") {
        return storage.getArchivedPRs();
      }

      return storage.getPRs();
    },

    async getPR(id) {
      return (await storage.getPR(id)) ?? null;
    },

    async addPR(url) {
      let parsedUrl: string;
      try {
        ({ url: parsedUrl } = addPRSchema.parse({ url }));
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppRuntimeError(400, error.errors[0]?.message ?? "Invalid PR URL");
        }
        throw error;
      }
      const parsed = parsePRUrl(parsedUrl);

      if (!parsed) {
        throw new AppRuntimeError(400, "Invalid GitHub PR URL. Expected: https://github.com/owner/repo/pull/123");
      }

      const repoSlug = `${parsed.owner}/${parsed.repo}`;
      const existing = await storage.getPRByRepoAndNumber(repoSlug, parsed.number);
      if (existing) {
        return existing;
      }

      const config = await storage.getConfig();
      const octokit = await buildOctokit(config);
      const summary = await fetchPullSummary(octokit, parsed);

      const pr = await storage.addPR({
        number: parsed.number,
        title: summary.title,
        repo: repoSlug,
        branch: summary.branch,
        author: summary.author,
        url: summary.url,
        status: "watching",
        feedbackItems: [],
        accepted: 0,
        rejected: 0,
        flagged: 0,
        testsPassed: null,
        lintPassed: null,
        lastChecked: null,
      });

      await storage.addLog(pr.id, "info", `Registered PR #${parsed.number} from ${repoSlug}`);
      await storage.addLog(pr.id, "info", `Repository ${repoSlug} added to auto-babysit watch list`);

      if (!config.watchedRepos.includes(repoSlug)) {
        await storage.updateConfig({
          watchedRepos: [...config.watchedRepos, repoSlug].sort((a, b) => a.localeCompare(b)),
        });
      }

      await queueBabysitWithAgent(pr, config.codingAgent);
      notifyChange();
      return pr;
    },

    async removePR(id) {
      const removed = await storage.removePR(id);
      if (!removed) {
        throw new AppRuntimeError(404, "PR not found");
      }

      notifyChange();
      return { ok: true as const };
    },

    async setPRWatchEnabled(id, enabled) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const updated = await storage.updatePR(pr.id, { watchEnabled: enabled });
      const next = assertFound(updated, "PR not found");

      if (pr.watchEnabled !== enabled) {
        await storage.addLog(pr.id, "info", enabled ? "Background watch resumed" : "Background watch paused");
        if (enabled) {
          void runWatcher();
        }
      }

      notifyChange();
      return next;
    },

    async setWatchEnabled(id, enabled) {
      return runtime.setPRWatchEnabled(id, enabled);
    },

    async fetchPRFeedback(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");

      await storage.updatePR(pr.id, { status: "processing", lastChecked: new Date().toISOString() });
      await storage.addLog(pr.id, "info", "Syncing GitHub comments/reviews...");

      try {
        const updated = await babysitter.syncFeedbackForPR(pr.id);
        notifyChange();
        return updated;
      } catch (error) {
        const message = getErrorMessage(error);
        await storage.updatePR(pr.id, { status: "error", lastChecked: new Date().toISOString() });
        await storage.addLog(pr.id, "error", `Fetch failed: ${message}`);
        throw error;
      }
    },

    async triagePR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");

      await storage.updatePR(pr.id, { status: "processing" });
      await storage.addLog(pr.id, "info", "Triaging feedback...");

      const triaged = pr.feedbackItems.map((item) => {
        if (item.decision) {
          return item;
        }

        const body = item.body.toLowerCase();
        if (body.includes("lgtm") || body.includes("looks good")) {
          return applyEvaluationDecision(item, false, "Acknowledgement, no code change requested");
        }

        if (
          body.includes("please")
          || body.includes("should")
          || body.includes("fix")
          || body.includes("error")
          || body.includes("fail")
        ) {
          return { ...applyEvaluationDecision(item, true, "Likely actionable request"), action: item.body };
        }

        return applyFlagDecision(item, "Unclear actionability, flagged for manual review");
      });

      const accepted = triaged.filter((item) => item.decision === "accept").length;
      const rejected = triaged.filter((item) => item.decision === "reject").length;
      const flagged = triaged.filter((item) => item.decision === "flag").length;

      const updated = await storage.updatePR(pr.id, {
        feedbackItems: triaged,
        accepted,
        rejected,
        flagged,
        status: "watching",
      });

      await storage.addLog(pr.id, "info", `Triage complete: ${accepted} accept, ${rejected} reject, ${flagged} flag`);
      notifyChange();
      return assertFound(updated, "PR not found");
    },

    async applyPR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const runtime = await storage.getRuntimeState();
      if (runtime.drainMode) {
        await rejectManualRunDuringDrain(runtime, {
          pr,
          logMessageBase: "Manual babysitter run blocked because drain mode is enabled",
        });
      }

      const config = await storage.getConfig();
      await storage.updatePR(pr.id, { status: "processing" });
      await storage.addLog(pr.id, "info", `Launching autonomous babysitter run using ${config.codingAgent}`);
      await queueBabysitWithAgent(pr, config.codingAgent);

      const updated = await storage.getPR(pr.id);
      notifyChange();
      return assertFound(updated, "PR disappeared after apply run");
    },

    async babysitPR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const runtime = await storage.getRuntimeState();
      if (runtime.drainMode) {
        await rejectManualRunDuringDrain(runtime, {
          pr,
          logMessageBase: "Manual babysitter run blocked because drain mode is enabled",
        });
      }

      const config = await storage.getConfig();
      await storage.addLog(pr.id, "info", `Manual babysitter trigger using ${config.codingAgent}`);
      await queueBabysitWithAgent(pr, config.codingAgent);

      const updated = await storage.getPR(pr.id);
      notifyChange();
      return assertFound(updated, "PR disappeared after babysit run");
    },

    async queueBabysit(id) {
      return runtime.babysitPR(id);
    },

    async setFeedbackDecision(prId, feedbackId, decision) {
      const pr = assertFound(await storage.getPR(prId), "PR not found");
      const updated = await applyManualFeedbackDecision({
        storage,
        pr,
        feedbackId,
        decision,
      });
      notifyChange();
      return assertFound(updated, "PR not found");
    },

    async retryFeedback(prId, feedbackId) {
      const pr = assertFound(await storage.getPR(prId), "PR not found");
      const item = pr.feedbackItems.find((candidate) => candidate.id === feedbackId);
      if (!item) {
        throw new AppRuntimeError(404, "Feedback item not found");
      }

      if (item.status !== "failed" && item.status !== "warning") {
        throw new AppRuntimeError(400, "Only failed or warning items can be retried");
      }

      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          pr,
          logMessageBase: "Manual feedback retry blocked because drain mode is enabled",
          metadata: { feedbackId },
        });
      }

      const result = await babysitter.retryFeedbackItem(prId, feedbackId);
      if (result.kind === "pr_not_found") {
        throw new AppRuntimeError(404, "PR not found");
      }

      if (result.kind === "feedback_not_found") {
        throw new AppRuntimeError(404, "Feedback item not found");
      }

      if (result.kind === "feedback_not_retryable") {
        throw new AppRuntimeError(400, "Only failed or warning items can be retried");
      }

      await storage.addLog(prId, "info", `Feedback item ${feedbackId} queued for retry`);
      const config = await storage.getConfig();
      await queueBabysitWithAgent(result.updated, config.codingAgent);
      notifyChange();
      return result.updated;
    },

    async listPRQuestions(prId) {
      assertFound(await storage.getPR(prId), "PR not found");
      return storage.getQuestions(prId);
    },

    async askQuestion(prId, question) {
      const pr = assertFound(await storage.getPR(prId), "PR not found");
      let parsed: { question: string };
      try {
        parsed = askQuestionSchema.parse({ question });
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppRuntimeError(400, error.errors[0]?.message ?? "Invalid question");
        }
        throw error;
      }

      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          pr,
          logMessageBase: "Manual question run blocked because drain mode is enabled",
        });
      }

      const entry = await storage.addQuestion(prId, parsed.question);
      try {
        await scheduleBackgroundJob(
          "answer_pr_question",
          entry.id,
          buildBackgroundJobDedupeKey("answer_pr_question", entry.id),
          {
            prId,
            ...buildActivityPayload({
              label: `Answering question for PR #${pr.number}`,
              detail: `${pr.repo} - ${pr.title}`,
              targetUrl: pr.url,
            }),
          },
        );
      } catch (error) {
        const message = getErrorMessage(error);
        await storage.updateQuestion(entry.id, {
          status: "error",
          error: message.trim().slice(0, 2_000),
        });
        throw error;
      }

      notifyChange();
      return entry;
    },

    async listLogs(prId) {
      return storage.getLogs(prId);
    },

    async getOnboardingStatus() {
      const config = await storage.getConfig();
      return checkOnboardingStatus(config, config.watchedRepos);
    },

    async installReviewWorkflow(repo, tool) {
      const config = await storage.getConfig();
      return installCodeReviewWorkflow(config, repo, tool);
    },

    async listHealingSessions() {
      return storage.listHealingSessions();
    },

    async getHealingSession(id) {
      return assertFound(await storage.getHealingSession(id), "Healing session not found");
    },

    async listDeploymentHealingSessions(repo) {
      return storage.listDeploymentHealingSessions(repo ? { repo } : undefined);
    },

    async getDeploymentHealingSession(id) {
      return assertFound(
        await storage.getDeploymentHealingSession(id),
        "Deployment healing session not found",
      );
    },

    async getConfig() {
      return storage.getConfig();
    },

    async updateConfig(updates) {
      const updated = await storage.updateConfig(updates);
      if (startWatcher && started) {
        await refreshWatcherSchedule();
      }
      notifyChange();
      return updated;
    },

    async listSocialChangelogs() {
      return storage.getSocialChangelogs();
    },

    async getSocialChangelog(id) {
      return assertFound(await storage.getSocialChangelog(id), "Changelog not found");
    },

    async listReleaseRuns() {
      return storage.listReleaseRuns();
    },

    async getReleaseRun(id) {
      return assertFound(await storage.getReleaseRun(id), "Release run not found");
    },

    async retryReleaseRun(id) {
      const existing = assertFound(await storage.getReleaseRun(id), "Release run not found");
      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          logMessageBase: "Manual release retry blocked because drain mode is enabled",
          metadata: {
            releaseRunId: id,
            repo: existing.repo,
          },
        });
      }

      const release = await releaseManager.retryReleaseRun(id);
      if (!release) {
        throw new AppRuntimeError(404, "Release run not found");
      }

      notifyChange();
      return release;
    },
  };

  return runtime;
}

export function isAppRuntimeError(error: unknown): error is AppRuntimeError {
  return error instanceof AppRuntimeError;
}

export function isGitHubAwareError(error: unknown): error is GitHubIntegrationError | AppRuntimeError {
  return error instanceof GitHubIntegrationError || error instanceof AppRuntimeError;
}
