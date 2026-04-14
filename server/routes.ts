import type { Express, Response } from "express";
import type { Server } from "http";
import { z } from "zod";
import { configSchema } from "@shared/schema";
import {
  createAppRuntime,
  type AppRuntime,
  type AppRuntimeDependencies,
  isAppRuntimeError,
} from "./appRuntime";
import { GitHubIntegrationError } from "./github";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendAppAwareError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.errors[0]?.message ?? "Invalid request" });
    return;
  }

  if (error instanceof GitHubIntegrationError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  if (isAppRuntimeError(error)) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: getErrorMessage(error) });
}

function maskConfig<T extends { githubToken: string }>(config: T): T {
  return {
    ...config,
    githubToken: config.githubToken ? `***${config.githubToken.slice(-4)}` : "",
  };
}

export type RouteDependencies = AppRuntimeDependencies & {
  runtime?: AppRuntime;
};

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  dependencies: RouteDependencies = {},
): Promise<Server> {
  const runtime = dependencies.runtime ?? createAppRuntime(dependencies);
  await runtime.start();

  httpServer.on("close", () => {
    runtime.stop();
  });

  app.get("/api/runtime", async (_req, res) => {
    res.json(await runtime.getRuntimeSnapshot());
  });

  app.post("/api/runtime/drain", async (req, res) => {
    try {
      const payload = z.object({
        enabled: z.boolean(),
        reason: z.string().optional(),
        waitForIdle: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600000).optional(),
      }).parse(req.body);

      const updated = await runtime.setDrainMode(payload);
      if (payload.enabled && payload.waitForIdle && updated.drained === false) {
        return res.status(202).json(updated);
      }

      res.json(updated);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/repos", async (_req, res) => {
    res.json(await runtime.listRepos());
  });

  app.post("/api/repos", async (req, res) => {
    try {
      const { repo } = z.object({ repo: z.string().min(1) }).parse(req.body);
      res.status(201).json(await runtime.addRepo(repo));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/repos/sync", async (_req, res) => {
    try {
      res.json(await runtime.syncRepos());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/prs", async (_req, res) => {
    res.json(await runtime.listPRs("active"));
  });

  app.get("/api/prs/archived", async (_req, res) => {
    res.json(await runtime.listPRs("archived"));
  });

  app.get("/api/prs/:id", async (req, res) => {
    const pr = await runtime.getPR(req.params.id);
    if (!pr) {
      return res.status(404).json({ error: "PR not found" });
    }

    res.json(pr);
  });

  app.post("/api/prs", async (req, res) => {
    try {
      res.status(201).json(await runtime.addPR(req.body?.url));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.delete("/api/prs/:id", async (req, res) => {
    try {
      res.json(await runtime.removePR(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/prs/:id/watch", async (req, res) => {
    try {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      res.json(await runtime.setPRWatchEnabled(req.params.id, enabled));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/fetch", async (req, res) => {
    try {
      res.json(await runtime.fetchPRFeedback(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/triage", async (req, res) => {
    try {
      res.json(await runtime.triagePR(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/apply", async (req, res) => {
    try {
      res.json(await runtime.applyPR(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/babysit", async (req, res) => {
    try {
      res.json(await runtime.babysitPR(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/prs/:id/feedback/:feedbackId", async (req, res) => {
    try {
      const { decision } = z.object({
        decision: z.enum(["accept", "reject", "flag"]),
      }).parse(req.body);

      res.json(await runtime.setFeedbackDecision(req.params.id, req.params.feedbackId, decision));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/feedback/:feedbackId/retry", async (req, res) => {
    try {
      res.json(await runtime.retryFeedback(req.params.id, req.params.feedbackId));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/prs/:id/questions", async (req, res) => {
    try {
      res.json(await runtime.listPRQuestions(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/questions", async (req, res) => {
    try {
      res.status(201).json(await runtime.askQuestion(req.params.id, req.body?.question));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/logs", async (req, res) => {
    const prId = typeof req.query.prId === "string" ? req.query.prId : undefined;
    res.json(await runtime.listLogs(prId));
  });

  app.get("/api/onboarding/status", async (_req, res) => {
    try {
      res.json(await runtime.getOnboardingStatus());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/onboarding/install-review", async (req, res) => {
    try {
      const { repo, tool } = z.object({
        repo: z.string().min(1),
        tool: z.enum(["claude", "codex"]),
      }).parse(req.body);

      res.json(await runtime.installReviewWorkflow(repo, tool));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/healing-sessions", async (_req, res) => {
    try {
      res.json(await runtime.listHealingSessions());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/healing-sessions/:id", async (req, res) => {
    try {
      res.json(await runtime.getHealingSession(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/deployment-healing-sessions", async (req, res) => {
    try {
      const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
      res.json(await runtime.listDeploymentHealingSessions(repo));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/deployment-healing-sessions/:id", async (req, res) => {
    try {
      res.json(await runtime.getDeploymentHealingSession(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/config", async (_req, res) => {
    res.json(maskConfig(await runtime.getConfig()));
  });

  app.get("/api/changelogs", async (_req, res) => {
    try {
      res.json(await runtime.listSocialChangelogs());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/changelogs/:id", async (req, res) => {
    try {
      res.json(await runtime.getSocialChangelog(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/releases", async (_req, res) => {
    try {
      res.json(await runtime.listReleaseRuns());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/releases/:id", async (req, res) => {
    try {
      res.json(await runtime.getReleaseRun(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/releases/:id/retry", async (req, res) => {
    try {
      res.json(await runtime.retryReleaseRun(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/config", async (req, res) => {
    try {
      const updates = configSchema.partial().parse(req.body);
      res.json(maskConfig(await runtime.updateConfig(updates)));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  return httpServer;
}
