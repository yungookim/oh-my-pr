import type { Express } from "express";
import type { Server } from "http";
import { z } from "zod";
import { addPRSchema, askQuestionSchema, configSchema } from "@shared/schema";
import { storage } from "./storage";
import { PRBabysitter } from "./babysitter";
import { applyEvaluationDecision, applyFlagDecision, applyManualDecision } from "./feedbackLifecycle";
import { createWatcherScheduler } from "./watcherScheduler";
import { answerPRQuestion } from "./prQuestionAgent";
import { ReleaseManager } from "./releaseManager";
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

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  const releaseManager = new ReleaseManager(storage, {
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
  });
  const babysitter = new PRBabysitter(storage, undefined, undefined, releaseManager);
  let watcherTimer: NodeJS.Timeout | null = null;
  let watcherIntervalMs = 0;

  const watcherScheduler = createWatcherScheduler(
    () => babysitter.syncAndBabysitTrackedRepos(),
    (error) => {
      console.error("Repository babysitter watcher failed", error);
    },
  );
  const runWatcher = watcherScheduler.run;

  const getRuntimeSnapshot = async () => {
    const state = await storage.getRuntimeState();
    return {
      ...state,
      activeRuns: babysitter.getActiveRunCount(),
    };
  };

  const refreshWatcherSchedule = async () => {
    const config = await storage.getConfig();
    const interval = Math.max(10000, config.pollIntervalMs || 120000);

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

  await refreshWatcherSchedule();
  void babysitter.resumeInterruptedRuns();
  void runWatcher();

  httpServer.on("close", () => {
    if (watcherTimer) {
      clearInterval(watcherTimer);
      watcherTimer = null;
    }
  });

  app.get("/api/runtime", async (_req, res) => {
    res.json(await getRuntimeSnapshot());
  });

  app.post("/api/runtime/drain", async (req, res) => {
    try {
      const payload = z.object({
        enabled: z.boolean(),
        reason: z.string().optional(),
        waitForIdle: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600000).optional(),
      }).parse(req.body);

      const updated = await storage.updateRuntimeState({
        drainMode: payload.enabled,
        drainRequestedAt: payload.enabled ? new Date().toISOString() : null,
        drainReason: payload.enabled ? payload.reason ?? null : null,
      });

      if (payload.enabled && payload.waitForIdle) {
        const drained = await babysitter.waitForIdle(payload.timeoutMs ?? 120000);
        const snapshot = await getRuntimeSnapshot();
        return res.status(drained ? 200 : 202).json({
          ...updated,
          ...snapshot,
          drained,
        });
      }

      const snapshot = await getRuntimeSnapshot();
      res.json({
        ...updated,
        ...snapshot,
      });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0].message });
      }

      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── PRs ────────────────────────────────────────────────────

  app.get("/api/repos", async (_req, res) => {
    const config = await storage.getConfig();
    const prs = await storage.getPRs();

    const repos = Array.from(new Set([
      ...config.watchedRepos,
      ...prs.map((pr) => pr.repo),
    ]))
      .sort((a, b) => a.localeCompare(b));

    res.json(repos);
  });

  app.post("/api/repos", async (req, res) => {
    try {
      const repoInput = z.object({ repo: z.string().min(1) }).parse(req.body).repo;
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        return res.status(400).json({ error: "Invalid repository. Use owner/repo or https://github.com/owner/repo" });
      }

      const canonical = formatRepoSlug(parsedRepo);
      const config = await storage.getConfig();

      if (!config.watchedRepos.includes(canonical)) {
        await storage.updateConfig({
          watchedRepos: [...config.watchedRepos, canonical].sort((a, b) => a.localeCompare(b)),
        });
      }

      void runWatcher();
      res.status(201).json({ repo: canonical });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0].message });
      }

      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/repos/sync", async (_req, res) => {
    const runtime = await storage.getRuntimeState();
    if (runtime.drainMode) {
      return res.status(409).json({ error: "Drain mode is enabled. Sync-triggered runs are blocked until drain mode is disabled." });
    }

    try {
      await watcherScheduler.runAndReportErrors();
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/prs", async (_req, res) => {
    const prs = await storage.getPRs();
    res.json(prs);
  });

  app.get("/api/prs/archived", async (_req, res) => {
    const prs = await storage.getArchivedPRs();
    res.json(prs);
  });

  app.get("/api/prs/:id", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });
    res.json(pr);
  });

  app.post("/api/prs", async (req, res) => {
    try {
      const { url } = addPRSchema.parse(req.body);
      const parsed = parsePRUrl(url);

      if (!parsed) {
        return res
          .status(400)
          .json({ error: "Invalid GitHub PR URL. Expected: https://github.com/owner/repo/pull/123" });
      }

      const repoSlug = `${parsed.owner}/${parsed.repo}`;
      const existing = await storage.getPRByRepoAndNumber(repoSlug, parsed.number);
      if (existing) {
        return res.status(200).json(existing);
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

      void babysitter.babysitPR(pr.id, config.codingAgent);

      res.status(201).json(pr);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0].message });
      }

      if (err instanceof GitHubIntegrationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }

      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/prs/:id", async (req, res) => {
    const removed = await storage.removePR(req.params.id);
    if (!removed) return res.status(404).json({ error: "PR not found" });
    res.json({ ok: true });
  });

  app.post("/api/prs/:id/fetch", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });

    await storage.updatePR(pr.id, { status: "processing", lastChecked: new Date().toISOString() });
    await storage.addLog(pr.id, "info", "Syncing GitHub comments/reviews...");

    try {
      const updated = await babysitter.syncFeedbackForPR(pr.id);
      res.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await storage.updatePR(pr.id, { status: "error", lastChecked: new Date().toISOString() });
      await storage.addLog(pr.id, "error", `Fetch failed: ${message}`);
      if (error instanceof GitHubIntegrationError) {
        return res.status(error.statusCode).json({ error: message });
      }
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/prs/:id/triage", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });

    await storage.updatePR(pr.id, { status: "processing" });
    await storage.addLog(pr.id, "info", "Triaging feedback...");

    const triaged = pr.feedbackItems.map((item) => {
      if (item.decision) return item;

      const body = item.body.toLowerCase();
      if (body.includes("lgtm") || body.includes("looks good")) {
        return applyEvaluationDecision(item, false, "Acknowledgement, no code change requested");
      }

      if (body.includes("please") || body.includes("should") || body.includes("fix") || body.includes("error") || body.includes("fail")) {
        return { ...applyEvaluationDecision(item, true, "Likely actionable request"), action: item.body };
      }

      return applyFlagDecision(item, "Unclear actionability, flagged for manual review");
    });

    const accepted = triaged.filter((i) => i.decision === "accept").length;
    const rejected = triaged.filter((i) => i.decision === "reject").length;
    const flagged = triaged.filter((i) => i.decision === "flag").length;

    const updated = await storage.updatePR(pr.id, {
      feedbackItems: triaged,
      accepted,
      rejected,
      flagged,
      status: "watching",
    });

    await storage.addLog(pr.id, "info", `Triage complete: ${accepted} accept, ${rejected} reject, ${flagged} flag`);
    res.json(updated);
  });

  app.post("/api/prs/:id/apply", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });
    const runtime = await storage.getRuntimeState();
    if (runtime.drainMode) {
      return res.status(409).json({ error: "Drain mode is enabled. Manual runs are blocked until drain mode is disabled." });
    }

    const config = await storage.getConfig();
    await storage.updatePR(pr.id, { status: "processing" });
    await storage.addLog(pr.id, "info", `Launching autonomous babysitter run using ${config.codingAgent}`);

    await babysitter.babysitPR(pr.id, config.codingAgent);

    const updated = await storage.getPR(pr.id);
    if (!updated) {
      return res.status(500).json({ error: "PR disappeared after apply run" });
    }

    res.json(updated);
  });

  app.post("/api/prs/:id/babysit", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });
    const runtime = await storage.getRuntimeState();
    if (runtime.drainMode) {
      return res.status(409).json({ error: "Drain mode is enabled. Manual runs are blocked until drain mode is disabled." });
    }

    const config = await storage.getConfig();
    await storage.addLog(pr.id, "info", `Manual babysitter trigger using ${config.codingAgent}`);
    await babysitter.babysitPR(pr.id, config.codingAgent);

    const updated = await storage.getPR(pr.id);
    if (!updated) {
      return res.status(500).json({ error: "PR disappeared after babysit run" });
    }

    res.json(updated);
  });

  app.patch("/api/prs/:id/feedback/:feedbackId", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });

    const { decision } = req.body;
    if (!["accept", "reject", "flag"].includes(decision)) {
      return res.status(400).json({ error: "Invalid decision" });
    }

    const feedbackItems = pr.feedbackItems.map((item) =>
      item.id === req.params.feedbackId
        ? applyManualDecision(item, decision as "accept" | "reject" | "flag")
        : item,
    );

    const accepted = feedbackItems.filter((i) => i.decision === "accept").length;
    const rejected = feedbackItems.filter((i) => i.decision === "reject").length;
    const flagged = feedbackItems.filter((i) => i.decision === "flag").length;

    const updated = await storage.updatePR(pr.id, { feedbackItems, accepted, rejected, flagged });
    res.json(updated);
  });

  app.post("/api/prs/:id/feedback/:feedbackId/retry", async (req, res) => {
    const result = await babysitter.retryFeedbackItem(req.params.id, req.params.feedbackId);
    if (result.kind === "pr_not_found") {
      return res.status(404).json({ error: "PR not found" });
    }

    if (result.kind === "feedback_not_found") {
      return res.status(404).json({ error: "Feedback item not found" });
    }

    if (result.kind === "feedback_not_retryable") {
      return res.status(400).json({ error: "Only failed or warning items can be retried" });
    }

    await storage.addLog(req.params.id, "info", `Feedback item ${req.params.feedbackId} queued for retry`);

    const config = await storage.getConfig();
    void babysitter.babysitPR(req.params.id, config.codingAgent);

    res.json(result.updated);
  });

  // ── PR Questions ─────────────────────────────────────────

  app.get("/api/prs/:id/questions", async (req, res) => {
    const pr = await storage.getPR(req.params.id);
    if (!pr) return res.status(404).json({ error: "PR not found" });

    const questions = await storage.getQuestions(pr.id);
    res.json(questions);
  });

  app.post("/api/prs/:id/questions", async (req, res) => {
    try {
      const pr = await storage.getPR(req.params.id);
      if (!pr) return res.status(404).json({ error: "PR not found" });

      const { question } = askQuestionSchema.parse(req.body);
      const entry = await storage.addQuestion(pr.id, question);

      const config = await storage.getConfig();
      void answerPRQuestion({
        storage,
        prId: pr.id,
        questionId: entry.id,
        question,
        preferredAgent: config.codingAgent,
      });

      res.status(201).json(entry);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0].message });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── Logs ───────────────────────────────────────────────────

  app.get("/api/logs", async (req, res) => {
    const prId = req.query.prId as string | undefined;
    const logs = await storage.getLogs(prId);
    res.json(logs);
  });

  // ── Onboarding ─────────────────────────────────────────────

  app.get("/api/onboarding/status", async (_req, res) => {
    const config = await storage.getConfig();
    const status = await checkOnboardingStatus(config, config.watchedRepos);
    res.json(status);
  });

  app.post("/api/onboarding/install-review", async (req, res) => {
    try {
      const { repo, tool } = z.object({
        repo: z.string().min(1),
        tool: z.enum(["claude", "codex"]),
      }).parse(req.body);

      const config = await storage.getConfig();
      const result = await installCodeReviewWorkflow(config, repo, tool);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0].message });
      }
      if (err instanceof GitHubIntegrationError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── Config ─────────────────────────────────────────────────

  app.get("/api/config", async (_req, res) => {
    const config = await storage.getConfig();
    res.json({
      ...config,
      githubToken: config.githubToken ? "***" + config.githubToken.slice(-4) : "",
    });
  });

  // ── Social media changelogs ─────────────────────────────────────────────

  app.get("/api/changelogs", async (_req, res) => {
    try {
      const changelogs = await storage.getSocialChangelogs();
      res.json(changelogs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/changelogs/:id", async (req, res) => {
    try {
      const changelog = await storage.getSocialChangelog(req.params.id);
      if (!changelog) {
        return res.status(404).json({ error: "Changelog not found" });
      }
      res.json(changelog);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── Release runs ────────────────────────────────────────────────────────

  app.get("/api/releases", async (_req, res) => {
    try {
      const releases = await storage.listReleaseRuns();
      res.json(releases);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/releases/:id", async (req, res) => {
    try {
      const release = await storage.getReleaseRun(req.params.id);
      if (!release) {
        return res.status(404).json({ error: "Release run not found" });
      }
      res.json(release);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/releases/:id/retry", async (req, res) => {
    try {
      const release = await releaseManager.retryReleaseRun(req.params.id);
      if (!release) {
        return res.status(404).json({ error: "Release run not found" });
      }
      res.json(release);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.patch("/api/config", async (req, res) => {
    try {
      const updates = configSchema.partial().parse(req.body);
      const updated = await storage.updateConfig(updates);
      await refreshWatcherSchedule();

      res.json({
        ...updated,
        githubToken: updated.githubToken ? "***" + updated.githubToken.slice(-4) : "",
      });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0].message });
      }

      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return httpServer;
}
