import { EventEmitter } from "node:events";
import type {
  Config,
  DeploymentHealingSession,
  HealingSession,
  LogEntry,
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
import { applyEvaluationDecision, applyFlagDecision } from "./feedbackLifecycle";
import { applyManualFeedbackDecision } from "./manualFeedback";
import { createBackgroundJobHandlers } from "./backgroundJobHandlers";
import { BackgroundJobDispatcher } from "./backgroundJobDispatcher";
import { BackgroundJobQueue, buildBackgroundJobDedupeKey } from "./backgroundJobQueue";
import { createWatcherScheduler, type WatcherScheduler } from "./watcherScheduler";
import { ReleaseManager } from "./releaseManager";
import { DeploymentHealingManager } from "./deploymentHealingManager";
import {
  buildOctokit,
  checkOnboardingStatus,
  createGitHubRelease,
  fetchPullSummary,
  formatRepoSlug,
  getLatestSemverTagForRepo,
  GitHubIntegrationError,
  installCodeReviewWorkflow,
  listReleasesForRepo,
  listUnreleasedMergedPulls,
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
  listRepos(): Promise<string[]>;
  listRepoSettings(): Promise<WatchedRepo[]>;
  addRepo(repoInput: string): Promise<{ repo: string }>;
  updateRepoSettings(repoInput: string, updates: Partial<Omit<WatchedRepo, "repo">>): Promise<WatchedRepo>;
  syncRepos(): Promise<{ ok: true }>;
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
      findLatestSemverReleaseTag: getLatestSemverTagForRepo,
      bumpReleaseTag: resolveNextSemverTag,
      listMergedPullsForReleaseCandidate: async (octokit, repo, options) => {
        const merged = await listUnreleasedMergedPulls(octokit, repo, {
          baseRef: options.baseBranch,
        });
        const cutoffMs = Date.parse(options.untilMergedAt);

        return merged
          .filter((pull) => !Number.isFinite(cutoffMs) || Date.parse(pull.mergedAt) <= cutoffMs)
          .map((pull) => ({
            number: pull.number,
            title: pull.title,
            url: pull.url,
            author: pull.author,
            repo: pull.repo,
            mergedAt: pull.mergedAt,
            mergeSha: pull.mergeCommitSha ?? `${pull.repo}#${pull.number}`,
          }));
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
      console.error("Repository babysitter watcher failed", error);
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
      void runWatcher();
    }, interval);
  };

  const queueBabysitWithAgent = async (prId: string, preferredAgent: Config["codingAgent"]) => {
    await scheduleBackgroundJob(
      "babysit_pr",
      prId,
      buildBackgroundJobDedupeKey("babysit_pr", prId),
      { preferredAgent },
    );
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
      }
    },

    subscribe(listener) {
      events.on("change", listener);
      return () => {
        events.off("change", listener);
      };
    },

    getRuntimeSnapshot,

    async setDrainMode(input) {
      const updated = await storage.updateRuntimeState({
        drainMode: input.enabled,
        drainRequestedAt: input.enabled ? new Date().toISOString() : null,
        drainReason: input.enabled ? input.reason ?? null : null,
      });

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
            autoCreateReleases: true,
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
      const runtime = await storage.getRuntimeState();
      if (runtime.drainMode) {
        throw new AppRuntimeError(409, "Drain mode is enabled. Sync-triggered runs are blocked until drain mode is disabled.");
      }

      await watcherScheduler.runAndReportErrors();
      notifyChange();
      return { ok: true as const };
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

      await queueBabysitWithAgent(pr.id, config.codingAgent);
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
        throw new AppRuntimeError(409, "Drain mode is enabled. Manual runs are blocked until drain mode is disabled.");
      }

      const config = await storage.getConfig();
      await storage.updatePR(pr.id, { status: "processing" });
      await storage.addLog(pr.id, "info", `Launching autonomous babysitter run using ${config.codingAgent}`);
      await queueBabysitWithAgent(pr.id, config.codingAgent);

      const updated = await storage.getPR(pr.id);
      notifyChange();
      return assertFound(updated, "PR disappeared after apply run");
    },

    async babysitPR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const runtime = await storage.getRuntimeState();
      if (runtime.drainMode) {
        throw new AppRuntimeError(409, "Drain mode is enabled. Manual runs are blocked until drain mode is disabled.");
      }

      const config = await storage.getConfig();
      await storage.addLog(pr.id, "info", `Manual babysitter trigger using ${config.codingAgent}`);
      await queueBabysitWithAgent(pr.id, config.codingAgent);

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
      await queueBabysitWithAgent(prId, config.codingAgent);
      notifyChange();
      return result.updated;
    },

    async listPRQuestions(prId) {
      assertFound(await storage.getPR(prId), "PR not found");
      return storage.getQuestions(prId);
    },

    async askQuestion(prId, question) {
      assertFound(await storage.getPR(prId), "PR not found");
      let parsed: { question: string };
      try {
        parsed = askQuestionSchema.parse({ question });
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppRuntimeError(400, error.errors[0]?.message ?? "Invalid question");
        }
        throw error;
      }
      const entry = await storage.addQuestion(prId, parsed.question);

      try {
        await scheduleBackgroundJob(
          "answer_pr_question",
          entry.id,
          buildBackgroundJobDedupeKey("answer_pr_question", entry.id),
          { prId },
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
