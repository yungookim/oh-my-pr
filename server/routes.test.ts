import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import express, { type Express } from "express";
import { registerRoutes } from "./routes";
import { MemStorage } from "./memoryStorage";

async function getJson(app: Express, pathname: string): Promise<{
  status: number;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new PassThrough(), {
      method: "GET",
      url: pathname,
      originalUrl: pathname,
      headers: {},
      connection: { remoteAddress: "127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
      httpVersion: "1.1",
    });

    const headers = new Map<string, string | string[] | number>();
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 200,
      locals: {},
      req,
      app,
      setHeader(name: string, value: string | string[] | number) {
        headers.set(name.toLowerCase(), value);
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase());
      },
      writeHead(statusCode: number, reasonOrHeaders?: string | Record<string, unknown>, headersArg?: Record<string, unknown>) {
        this.statusCode = statusCode;
        const maybeHeaders = typeof reasonOrHeaders === "object" && reasonOrHeaders !== null
          ? reasonOrHeaders
          : headersArg;
        if (maybeHeaders) {
          for (const [name, value] of Object.entries(maybeHeaders)) {
            this.setHeader(name, value as string);
          }
        }
        return this;
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          this.write(chunk);
        }
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: this.statusCode,
            body: raw ? JSON.parse(raw) : null,
          });
        } catch (error) {
          reject(error);
        }
      },
    };

    Object.setPrototypeOf(req, app.request);
    Object.setPrototypeOf(res, app.response);
    (req as typeof req & { res: unknown }).res = res;

    app.handle(req as never, res as never, (error: unknown) => {
      if (error) {
        reject(error);
      }
    });
  });
}

async function startApp(storage: MemStorage): Promise<Express> {
  const app = express();
  app.use(express.json());

  const server = createServer(app);
  await registerRoutes(server, app, {
    storage,
    startWatcher: false,
  });
  return app;
}

test("GET /api/healing-sessions returns persisted healing sessions", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 52,
    title: "Healing route",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/healing-route",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/52",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  const session = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "abc123",
    currentHeadSha: "abc123",
    state: "awaiting_repair_slot",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: "github.check_run:typescript:build",
    attemptCount: 0,
    lastImprovementScore: null,
  });

  const app = await startApp(storage);
  const response = await getJson(app, "/api/healing-sessions");
  assert.equal(response.status, 200);
  const sessions = response.body as Array<{ id: string; prId: string; state: string }>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, session.id);
  assert.equal(sessions[0]?.prId, pr.id);
  assert.equal(sessions[0]?.state, "awaiting_repair_slot");
});

test("GET /api/healing-sessions/:id returns a specific session and 404s when missing", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 53,
    title: "Healing detail route",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/healing-detail",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/53",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  const session = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "def456",
    currentHeadSha: "def456",
    state: "blocked",
    endedAt: new Date().toISOString(),
    blockedReason: "External CI failure",
    escalationReason: null,
    latestFingerprint: "github.check_run:missing-secret:deploy",
    attemptCount: 0,
    lastImprovementScore: null,
  });

  const app = await startApp(storage);
  const okResponse = await getJson(app, `/api/healing-sessions/${session.id}`);
  assert.equal(okResponse.status, 200);
  const payload = okResponse.body as { id: string; state: string; blockedReason: string | null };
  assert.equal(payload.id, session.id);
  assert.equal(payload.state, "blocked");
  assert.equal(payload.blockedReason, "External CI failure");

  const missingResponse = await getJson(app, "/api/healing-sessions/does-not-exist");
  assert.equal(missingResponse.status, 404);
  const missingPayload = missingResponse.body as { error: string };
  assert.equal(missingPayload.error, "Healing session not found");
});
