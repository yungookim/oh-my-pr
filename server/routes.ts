import type { Express, Response } from "express";
import type { Server } from "http";
import { z } from "zod";
import { configSchema, usageSummarySchema } from "@shared/schema";
import type { Config } from "@shared/schema";
import {
  createAppRuntime,
  type AppRuntime,
  type AppRuntimeDependencies,
  isAppRuntimeError,
} from "./appRuntime";
import { createAppUpdateChecker, type AppUpdateChecker } from "./appUpdate";
import { GitHubIntegrationError } from "./github";
import {
  getKnownLogSources,
  readLogRecords,
  subscribeToLogs,
  type LogLevel,
  type LogRecord,
} from "./logger";

const VALID_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

type SseWritable = Pick<Response, "write">;

function parseLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") return undefined;
  return (VALID_LEVELS as string[]).includes(value) ? (value as LogLevel) : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const TOKEN_MASK_PREFIX = "***";

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

function maskToken(token: string): string {
  return token ? `${TOKEN_MASK_PREFIX}${token.slice(-4)}` : "";
}

function resolveMaskedGithubTokens(currentTokens: string[], requestedTokens: string[]): string[] {
  const existing = currentTokens.map((token) => ({
    token,
    masked: maskToken(token),
    used: false,
  }));

  return requestedTokens
    .map((requestedToken) => {
      const trimmed = requestedToken.trim();
      if (!trimmed) {
        return "";
      }

      if (trimmed.startsWith(TOKEN_MASK_PREFIX)) {
        const match = existing.find((entry) => !entry.used && entry.masked === trimmed);
        if (match) {
          match.used = true;
          return match.token;
        }
      }

      return trimmed;
    })
    .filter(Boolean);
}

export function writeServerLogSseEvent(res: SseWritable, record: LogRecord): boolean {
  return res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`) !== false;
}

function resolveConfigSecrets(current: Config, updates: Partial<Config>): Partial<Config> {
  const requestedTokens = updates.githubTokens
    ?? (updates.githubToken !== undefined ? [updates.githubToken] : undefined);
  if (requestedTokens === undefined) {
    return updates;
  }

  const { githubToken: _legacyGithubToken, ...rest } = updates;
  return {
    ...rest,
    githubTokens: resolveMaskedGithubTokens(current.githubTokens, requestedTokens),
  };
}

function maskConfig(config: Config): Config {
  const githubTokens = config.githubTokens.map(maskToken);
  return {
    ...config,
    githubTokens,
    githubToken: githubTokens[0] ?? "",
  };
}

export type RouteDependencies = AppRuntimeDependencies & {
  runtime?: AppRuntime;
  appUpdateChecker?: AppUpdateChecker;
};

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  dependencies: RouteDependencies = {},
): Promise<Server> {
  const runtime = dependencies.runtime ?? createAppRuntime(dependencies);
  const appUpdateChecker = dependencies.appUpdateChecker ?? createAppUpdateChecker();
  await runtime.start();

  httpServer.on("close", () => {
    runtime.stop();
  });

  app.get("/api/runtime", async (_req, res) => {
    res.json(await runtime.getRuntimeSnapshot());
  });

  app.get("/api/server-logs", (req, res) => {
    const records = readLogRecords({
      level: parseLevel(req.query.level),
      source: typeof req.query.source === "string" ? req.query.source : undefined,
      since: parsePositiveInt(req.query.since),
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      limit: parsePositiveInt(req.query.limit) ?? 500,
    });
    res.json({
      records,
      sources: getKnownLogSources(),
      latestSeq: records.length > 0 ? records[records.length - 1].seq : (parsePositiveInt(req.query.since) ?? 0),
    });
  });

  app.get("/api/server-logs/stream", (req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Defeat any compression middleware that may be added later — SSE must not buffer.
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    let unsubscribe = () => {};
    const heartbeat = setInterval(() => {
      if (res.write(`: heartbeat ${Date.now()}\n\n`) === false) cleanup();
    }, 20_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };

    const send = (record: LogRecord) => {
      if (!writeServerLogSseEvent(res, record)) cleanup();
    };

    // Replay any backlog the client missed, if `since` was provided.
    const since = parsePositiveInt(req.query.since);
    if (since !== undefined) {
      const backlog = readLogRecords({ since, limit: 1000 });
      for (const record of backlog) {
        send(record);
        if (closed) return;
      }
    }

    unsubscribe = subscribeToLogs(send);

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  app.get("/api/activities", async (_req, res) => {
    res.json(await runtime.listActivities());
  });

  app.delete("/api/activities/failed", async (_req, res) => {
    try {
      res.json(await runtime.clearFailedActivities());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
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

  app.get("/api/repos/settings", async (_req, res) => {
    res.json(await runtime.listRepoSettings());
  });

  app.post("/api/repos", async (req, res) => {
    try {
      const { repo } = z.object({ repo: z.string().min(1) }).parse(req.body);
      res.status(201).json(await runtime.addRepo(repo));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/repos/settings", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        autoCreateReleases: z.boolean().optional(),
        ownPrsOnly: z.boolean().optional(),
      }).refine(
        (value) => value.autoCreateReleases !== undefined || value.ownPrsOnly !== undefined,
        "At least one repository setting must be provided",
      ).parse(req.body);
      const { repo, ...updates } = payload;
      res.json(await runtime.updateRepoSettings(repo, updates));
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

  app.post("/api/repos/release", async (req, res) => {
    try {
      const { repo } = z.object({ repo: z.string().min(1) }).parse(req.body);
      res.status(201).json(await runtime.createManualRelease(repo));
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

  app.get("/api/usage", async (_req, res) => {
    try {
      res.json(usageSummarySchema.parse(await runtime.getUsageSummary()));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/usage/app-open", async (_req, res) => {
    try {
      res.json(usageSummarySchema.parse(await runtime.recordAppOpen()));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/app-update", async (_req, res) => {
    try {
      const currentVersion = process.env.APP_VERSION || "dev";
      res.json(await appUpdateChecker(currentVersion));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
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
      const current = await runtime.getConfig();
      res.json(maskConfig(await runtime.updateConfig(resolveConfigSecrets(current, updates))));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  return httpServer;
}
