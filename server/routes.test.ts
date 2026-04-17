import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import type { NewPR } from "@shared/schema";
import { MemStorage } from "./memoryStorage";
import { registerRoutes } from "./routes";

async function seedPR(storage: MemStorage, overrides: Partial<NewPR> = {}) {
  return storage.addPR({
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
    ...overrides,
  });
}

async function createHarness(storage = new MemStorage()) {
  const app = express();
  app.use(express.json());

  const server = createServer(app);
  await registerRoutes(server, app, {
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral test server address");
  }

  return {
    storage,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      server.closeAllConnections?.();
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
  const pr = await seedPR(harness.storage);

  try {
    const response = await fetch(`${harness.baseUrl}/api/prs/${pr.id}/questions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "What changed?" }),
    });

    assert.equal(response.status, 201);
    const created = await response.json() as { id: string; status: string };
    assert.equal(created.status, "pending");

    const questions = await harness.storage.getQuestions(pr.id);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].status, "pending");
    assert.equal(questions[0].answer, null);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "answer_pr_question",
      status: "queued",
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].targetId, created.id);
    assert.equal(jobs[0].payload.prId, pr.id);
  } finally {
    await harness.close();
  }
});

test("POST /api/prs/:id/babysit enqueues a durable babysit_pr job", async () => {
  const harness = await createHarness();
  const pr = await seedPR(harness.storage);

  try {
    const response = await fetch(`${harness.baseUrl}/api/prs/${pr.id}/babysit`, {
      method: "POST",
    });

    assert.equal(response.status, 200);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "babysit_pr",
      status: "queued",
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].targetId, pr.id);
    assert.equal(jobs[0].payload.preferredAgent, "claude");
  } finally {
    await harness.close();
  }
});

test("POST /api/repos/sync enqueues a durable sync_watched_repos job", async () => {
  const harness = await createHarness();

  try {
    const response = await fetch(`${harness.baseUrl}/api/repos/sync`, {
      method: "POST",
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean };
    assert.equal(body.ok, true);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "sync_watched_repos",
      status: "queued",
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].targetId, "runtime:1");
    assert.equal(jobs[0].dedupeKey, "sync_watched_repos");
  } finally {
    await harness.close();
  }
});

test("GET/PATCH /api/repos/settings exposes repo-level release settings", async () => {
  const harness = await createHarness();
  await harness.storage.updateConfig({
    watchedRepos: ["acme/widgets"],
  });

  try {
    const initialResponse = await fetch(`${harness.baseUrl}/api/repos/settings`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as Array<{
      repo: string;
      autoCreateReleases: boolean;
    }>;
    assert.deepEqual(initial, [{
      repo: "acme/widgets",
      autoCreateReleases: true,
    }]);

    const updateResponse = await fetch(`${harness.baseUrl}/api/repos/settings`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repo: "acme/widgets",
        autoCreateReleases: false,
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json() as {
      repo: string;
      autoCreateReleases: boolean;
    };
    assert.deepEqual(updated, {
      repo: "acme/widgets",
      autoCreateReleases: false,
    });

    const persisted = await harness.storage.getRepoSettings("acme/widgets");
    assert.deepEqual(persisted, {
      repo: "acme/widgets",
      autoCreateReleases: false,
    });
  } finally {
    await harness.close();
  }
});

test("GET /api/healing-sessions returns persisted healing sessions", async () => {
  const harness = await createHarness();

  try {
    const pr = await seedPR(harness.storage, {
      number: 52,
      title: "Healing route",
      repo: "alex-morgan-o/lolodex",
      branch: "feature/healing-route",
      author: "octocat",
      url: "https://github.com/alex-morgan-o/lolodex/pull/52",
    });
    const session = await harness.storage.createHealingSession({
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

    const response = await fetch(`${harness.baseUrl}/api/healing-sessions`);
    assert.equal(response.status, 200);
    const sessions = await response.json() as Array<{ id: string; prId: string; state: string }>;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, session.id);
    assert.equal(sessions[0]?.prId, pr.id);
    assert.equal(sessions[0]?.state, "awaiting_repair_slot");
  } finally {
    await harness.close();
  }
});

test("GET /api/healing-sessions/:id returns a specific session and 404s when missing", async () => {
  const harness = await createHarness();

  try {
    const pr = await seedPR(harness.storage, {
      number: 53,
      title: "Healing detail route",
      repo: "alex-morgan-o/lolodex",
      branch: "feature/healing-detail",
      author: "octocat",
      url: "https://github.com/alex-morgan-o/lolodex/pull/53",
    });
    const session = await harness.storage.createHealingSession({
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

    const okResponse = await fetch(`${harness.baseUrl}/api/healing-sessions/${session.id}`);
    assert.equal(okResponse.status, 200);
    const payload = await okResponse.json() as { id: string; state: string; blockedReason: string | null };
    assert.equal(payload.id, session.id);
    assert.equal(payload.state, "blocked");
    assert.equal(payload.blockedReason, "External CI failure");

    const missingResponse = await fetch(`${harness.baseUrl}/api/healing-sessions/does-not-exist`);
    assert.equal(missingResponse.status, 404);
    const missingPayload = await missingResponse.json() as { error: string };
    assert.equal(missingPayload.error, "Healing session not found");
  } finally {
    await harness.close();
  }
});
