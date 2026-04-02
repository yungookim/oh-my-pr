import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";
import { registerRoutes } from "./routes";

async function seedPR(storage: MemStorage): Promise<string> {
  const pr = await storage.addPR({
    number: 42,
    title: "feat: add widget",
    repo: "acme/widgets",
    branch: "feat/widget",
    author: "alice",
    url: "https://github.com/acme/widgets/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  return pr.id;
}

async function createHarness() {
  const storage = new MemStorage();
  const backgroundJobQueue = new BackgroundJobQueue(storage);
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);

  await registerRoutes(server, app, {
    storage,
    backgroundJobQueue,
    startBackgroundServices: false,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral test server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    storage,
    baseUrl,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

test("POST /api/prs/:id/questions enqueues a durable answer_pr_question job", async () => {
  const harness = await createHarness();
  const prId = await seedPR(harness.storage);

  try {
    const response = await fetch(`${harness.baseUrl}/api/prs/${prId}/questions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "What changed?" }),
    });

    assert.equal(response.status, 201);
    const created = await response.json() as { id: string; status: string };
    assert.equal(created.status, "pending");

    const questions = await harness.storage.getQuestions(prId);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].status, "pending");
    assert.equal(questions[0].answer, null);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "answer_pr_question",
      status: "queued",
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].targetId, created.id);
    assert.equal(jobs[0].payload.prId, prId);
  } finally {
    await harness.close();
  }
});
