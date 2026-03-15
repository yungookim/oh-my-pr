import type { Express } from "express";
import type { Server } from "http";
import { z } from "zod";
import { addPRSchema, configSchema } from "@shared/schema";
import { storage } from "./storage";
import { PRBabysitter } from "./babysitter";
import { createWatcherScheduler } from "./watcherScheduler";
import {
  buildOctokit,
  fetchPullSummary,
  formatRepoSlug,
  GitHubIntegrationError,
  parsePRUrl,
  parseRepoSlug,
} from "./github";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  const babysitter = new PRBabysitter(storage);
  let watcherTimer: NodeJS.Timeout | null = null;
  let watcherIntervalMs = 0;

  const watcherScheduler = createWatcherScheduler(
    () => babysitter.syncAndBabysitTrackedRepos(),
    (error) => {
      console.error("Repository babysitter watcher failed", error);
    },
  );
  const runWatcher = watcherScheduler.run;

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
  void runWatcher();

  httpServer.on("close", () => {
    if (watcherTimer) {
      clearInterval(watcherTimer);
      watcherTimer = null;
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

  app.get("/api/prs", async (_req, res) => {
    const prs = await storage.getPRs();
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
        return {
          ...item,
          decision: "reject" as const,
          decisionReason: "Acknowledgement, no code change requested",
          action: null,
        };
      }

      if (body.includes("please") || body.includes("should") || body.includes("fix") || body.includes("error") || body.includes("fail")) {
        return {
          ...item,
          decision: "accept" as const,
          decisionReason: "Likely actionable request",
          action: item.body,
        };
      }

      return {
        ...item,
        decision: "flag" as const,
        decisionReason: "Unclear actionability, flagged for manual review",
        action: null,
      };
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
        ? { ...item, decision, decisionReason: "Manual override" }
        : item,
    );

    const accepted = feedbackItems.filter((i) => i.decision === "accept").length;
    const rejected = feedbackItems.filter((i) => i.decision === "reject").length;
    const flagged = feedbackItems.filter((i) => i.decision === "flag").length;

    const updated = await storage.updatePR(pr.id, { feedbackItems, accepted, rejected, flagged });
    res.json(updated);
  });

  // ── Logs ───────────────────────────────────────────────────

  app.get("/api/logs", async (req, res) => {
    const prId = req.query.prId as string | undefined;
    const logs = await storage.getLogs(prId);
    res.json(logs);
  });

  // ── Config ─────────────────────────────────────────────────

  app.get("/api/config", async (_req, res) => {
    const config = await storage.getConfig();
    res.json({
      ...config,
      githubToken: config.githubToken ? "***" + config.githubToken.slice(-4) : "",
    });
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
