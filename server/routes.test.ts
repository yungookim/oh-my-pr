import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import type { Octokit } from "@octokit/rest";
import type { AppUpdateStatus, FeedbackItem, NewPR } from "@shared/schema";
import type { ReleaseAgentPullSummary, ReleaseEvaluationDecision } from "./releaseAgent";
import { ReleaseManager, type ReleaseGitHubService } from "./releaseManager";
import { MemStorage } from "./memoryStorage";
import type { RouteDependencies } from "./routes";
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

async function createHarness(storage = new MemStorage(), dependencies: Partial<RouteDependencies> = {}) {
  const app = express();
  app.use(express.json());

  const server = createServer(app);
  await registerRoutes(server, app, {
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    ...dependencies,
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

function makeMergedSummary(overrides: Partial<ReleaseAgentPullSummary> = {}): ReleaseAgentPullSummary {
  return {
    number: 42,
    title: "Manual release",
    url: "https://github.com/acme/widgets/pull/42",
    author: "alice",
    repo: "acme/widgets",
    mergedAt: "2026-04-24T12:00:00.000Z",
    mergeSha: "manual-release-sha",
    ...overrides,
  };
}

function makeFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "feedback-1",
    author: "reviewer",
    body: "Please fix this",
    bodyHtml: "<p>Please fix this</p>",
    replyKind: "review_thread",
    sourceId: "review-comment-1",
    sourceNodeId: "node-1",
    sourceUrl: "https://github.com/acme/widgets/pull/42#discussion_r1",
    threadId: "thread-1",
    threadResolved: false,
    auditToken: "audit-1",
    file: "src/widget.ts",
    line: 12,
    type: "review_comment",
    createdAt: "2026-05-03T17:00:00.000Z",
    decision: "accept",
    decisionReason: null,
    action: "Fix the widget",
    status: "failed",
    statusReason: "codex health check timed out after 30000ms",
    ...overrides,
  };
}

function makeReleaseManagerForRoutes(
  storage: MemStorage,
  overrides: Partial<ReleaseGitHubService> = {},
): ReleaseManager {
  const github: ReleaseGitHubService = {
    buildOctokit: async () => ({}) as Octokit,
    getDefaultBranch: async () => "main",
    findLatestSemverReleaseTag: async () => "v1.2.3",
    bumpReleaseTag: () => "v1.2.4",
    listUnreleasedMergedPulls: async () => [makeMergedSummary()],
    listMergedPullsForReleaseCandidate: async () => [makeMergedSummary()],
    findReleaseByTag: async () => null,
    createGitHubRelease: async (_octokit, _repo, params) => ({
      id: 123,
      url: `https://github.com/acme/widgets/releases/tag/${params.tagName}`,
      tagName: params.tagName,
      name: params.name,
    }),
    ...overrides,
  };

  return new ReleaseManager(storage, {
    github,
    evaluateRelease: async (): Promise<ReleaseEvaluationDecision> => ({
      shouldRelease: true,
      reason: "Manual release requested",
      bump: "patch",
      title: "Manual release",
      notes: "Manual release notes",
    }),
  });
}

test("GET/PATCH /api/config masks and persists ordered github tokens", async () => {
  const harness = await createHarness();

  try {
    const patchResponse = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubTokens: ["ghs_alpha1234", "ghs_beta5678"] }),
    });

    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json() as { githubTokens: string[]; githubToken: string };
    assert.deepEqual(patched.githubTokens, ["***1234", "***5678"]);
    assert.equal(patched.githubToken, "***1234");

    const stored = await harness.storage.getConfig();
    assert.deepEqual(stored.githubTokens, ["ghs_alpha1234", "ghs_beta5678"]);

    const getResponse = await fetch(`${harness.baseUrl}/api/config`);
    assert.equal(getResponse.status, 200);
    const fetched = await getResponse.json() as { githubTokens: string[]; githubToken: string };
    assert.deepEqual(fetched.githubTokens, ["***1234", "***5678"]);
    assert.equal(fetched.githubToken, "***1234");
  } finally {
    await harness.close();
  }
});

test("PATCH /api/config preserves masked github tokens when reordering", async () => {
  const harness = await createHarness();

  try {
    await harness.storage.updateConfig({
      githubTokens: ["ghs_alpha1234", "ghs_beta5678"],
    });

    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubTokens: ["***5678", "***1234", "ghs_gamma9999"] }),
    });

    assert.equal(response.status, 200);
    const patched = await response.json() as { githubTokens: string[] };
    assert.deepEqual(patched.githubTokens, ["***5678", "***1234", "***9999"]);

    const stored = await harness.storage.getConfig();
    assert.deepEqual(stored.githubTokens, ["ghs_beta5678", "ghs_alpha1234", "ghs_gamma9999"]);
  } finally {
    await harness.close();
  }
});

test("PATCH /api/config accepts legacy single githubToken updates", async () => {
  const harness = await createHarness();

  try {
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "ghs_legacy9999" }),
    });

    assert.equal(response.status, 200);
    const patched = await response.json() as { githubTokens: string[]; githubToken: string };
    assert.deepEqual(patched.githubTokens, ["***9999"]);
    assert.equal(patched.githubToken, "***9999");

    const stored = await harness.storage.getConfig();
    assert.deepEqual(stored.githubTokens, ["ghs_legacy9999"]);
  } finally {
    await harness.close();
  }
});

test("GET /api/usage exposes only anonymous aggregate usage", async () => {
  const harness = await createHarness();

  try {
    await harness.storage.incrementUsageCounter("appOpenCount", 1, "2026-06-07T12:00:00.000Z");
    await harness.storage.incrementUsageCounter("trackedPrCount", 2, "2026-06-07T13:00:00.000Z");
    await harness.storage.incrementUsageCounter("fixesMadeCount", 1, "2026-06-08T01:00:00.000Z");

    const response = await fetch(`${harness.baseUrl}/api/usage`);
    assert.equal(response.status, 200);

    const usage = await response.json() as Record<string, unknown>;
    assert.deepEqual(usage, {
      totals: {
        appOpenCount: 1,
        trackedPrCount: 2,
        mergedPrCount: 0,
        fixesMadeCount: 1,
      },
      daily: [
        {
          date: "2026-06-07",
          appOpenCount: 1,
          trackedPrCount: 2,
          mergedPrCount: 0,
          fixesMadeCount: 0,
        },
        {
          date: "2026-06-08",
          appOpenCount: 0,
          trackedPrCount: 0,
          mergedPrCount: 0,
          fixesMadeCount: 1,
        },
      ],
    });
    assert.equal("repo" in usage, false);
    assert.equal("url" in usage, false);
    assert.equal("userId" in usage, false);
  } finally {
    await harness.close();
  }
});

test("GET /api/usage returns an app-aware error when usage summary fails", async () => {
  const harness = await createHarness();

  try {
    harness.storage.getUsageSummary = async () => {
      throw new Error("usage summary unavailable");
    };

    const response = await fetch(`${harness.baseUrl}/api/usage`);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "usage summary unavailable",
    });
  } finally {
    await harness.close();
  }
});

test("POST /api/usage/app-open increments anonymous app open usage", async () => {
  const harness = await createHarness();

  try {
    const response = await fetch(`${harness.baseUrl}/api/usage/app-open`, {
      method: "POST",
    });

    assert.equal(response.status, 200);
    const usage = await response.json() as {
      totals: { appOpenCount: number };
      daily: Array<{ appOpenCount: number }>;
    };
    assert.equal(usage.totals.appOpenCount, 1);
    assert.equal(usage.daily.length, 1);
    assert.equal(usage.daily[0]?.appOpenCount, 1);
  } finally {
    await harness.close();
  }
});

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

test("POST /api/prs/:id/questions reports drain reason and does not queue an answer job", async () => {
  const harness = await createHarness();
  const pr = await seedPR(harness.storage);
  await harness.storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-05-03T17:32:41.034Z",
    drainReason: "Agent health check failed for codex: codex health check timed out after 30000ms",
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/prs/${pr.id}/questions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "What changed?" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? "", /manual runs are blocked/i);
    assert.match(body.error ?? "", /codex health check timed out/i);

    const questions = await harness.storage.getQuestions(pr.id);
    assert.equal(questions.length, 0);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "answer_pr_question",
      status: "queued",
    });
    assert.equal(jobs.length, 0);
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

for (const endpoint of ["apply", "babysit"] as const) {
  test(`POST /api/prs/:id/${endpoint} reports drain reason and records blocked manual attempt`, async () => {
    const harness = await createHarness();
    const pr = await seedPR(harness.storage);
    await harness.storage.updateRuntimeState({
      drainMode: true,
      drainRequestedAt: "2026-05-03T17:32:41.034Z",
      drainReason: "Agent health check failed for codex: codex health check timed out after 30000ms",
    });

    try {
      const response = await fetch(`${harness.baseUrl}/api/prs/${pr.id}/${endpoint}`, {
        method: "POST",
      });

      assert.equal(response.status, 409);
      const body = await response.json() as { error?: string };
      assert.match(body.error ?? "", /manual runs are blocked/i);
      assert.match(body.error ?? "", /codex health check timed out/i);

      const jobs = await harness.storage.listBackgroundJobs({
        kind: "babysit_pr",
        status: "queued",
      });
      assert.equal(jobs.length, 0);

      const logs = await harness.storage.getLogs(pr.id);
      assert.ok(logs.some((log) =>
        log.level === "warn"
        && log.phase === "run"
        && log.message.includes("Manual babysitter run blocked because drain mode is enabled")
        && log.message.includes("codex health check timed out")
      ));
    } finally {
      await harness.close();
    }
  });
}

test("POST /api/prs/:id/feedback/:feedbackId/retry reports drain reason and does not queue a babysit job", async () => {
  const feedback = makeFeedbackItem();
  const harness = await createHarness();
  const pr = await seedPR(harness.storage, {
    feedbackItems: [feedback],
  });
  await harness.storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-05-03T17:32:41.034Z",
    drainReason: "Agent health check failed for codex: codex health check timed out after 30000ms",
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/prs/${pr.id}/feedback/${feedback.id}/retry`, {
      method: "POST",
    });

    assert.equal(response.status, 409);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? "", /manual runs are blocked/i);
    assert.match(body.error ?? "", /codex health check timed out/i);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "babysit_pr",
      status: "queued",
    });
    assert.equal(jobs.length, 0);

    const updated = await harness.storage.getPR(pr.id);
    assert.equal(updated?.feedbackItems[0]?.status, "failed");
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

test("POST /api/repos/sync enqueues sync_watched_repos while drain mode is enabled", async () => {
  const harness = await createHarness();
  await harness.storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-05-02T10:00:00.000Z",
    drainReason: "maintenance",
  });

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

test("GET /api/activities lists failed, in-progress, and queued jobs", async () => {
  const harness = await createHarness();
  const pr = await seedPR(harness.storage, {
    title: "fix activity menu",
    repo: "acme/widgets",
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
  });

  try {
    const runningJob = await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: pr.id,
      dedupeKey: `babysit_pr:${pr.id}`,
      payload: { preferredAgent: "claude" },
      availableAt: "2026-04-26T10:00:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:01:00.000Z",
    });

    const queuedJob = await harness.storage.enqueueBackgroundJob({
      kind: "sync_watched_repos",
      targetId: "runtime:1",
      dedupeKey: "sync_watched_repos",
      availableAt: "2026-04-26T10:02:00.000Z",
    });

    const failedJob = await harness.storage.enqueueBackgroundJob({
      kind: "answer_pr_question",
      targetId: "question-1",
      dedupeKey: "answer_pr_question:question-1",
      payload: { prId: pr.id },
      availableAt: "2026-04-26T10:03:00.000Z",
    });
    const claimedFailed = await harness.storage.claimNextBackgroundJob({
      workerId: "worker-2",
      leaseToken: "lease-2",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:03:30.000Z",
      kinds: ["answer_pr_question"],
    });
    assert.equal(claimedFailed?.id, failedJob.id);
    await harness.storage.failBackgroundJob(
      failedJob.id,
      "lease-2",
      "question agent timed out",
      "2026-04-26T10:04:00.000Z",
    );

    const response = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      failed: Array<{
        id: string;
        kind: string;
        status: string;
        label: string;
        detail: string | null;
        targetId: string;
        lastError: string | null;
      }>;
      inProgress: Array<{
        id: string;
        kind: string;
        status: string;
        label: string;
        detail: string | null;
        targetId: string;
        targetUrl: string | null;
      }>;
      queued: Array<{
        id: string;
        kind: string;
        status: string;
        label: string;
        detail: string | null;
        targetId: string;
      }>;
    };

    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0]?.id, failedJob.id);
    assert.equal(body.failed[0]?.kind, "answer_pr_question");
    assert.equal(body.failed[0]?.status, "failed");
    assert.equal(body.failed[0]?.label, "Answering question for PR #77");
    assert.equal(body.failed[0]?.detail, "acme/widgets - fix activity menu");
    assert.equal(body.failed[0]?.targetId, "question-1");
    assert.equal(body.failed[0]?.lastError, "question agent timed out");

    assert.equal(body.inProgress.length, 1);
    assert.equal(body.inProgress[0]?.id, runningJob.id);
    assert.equal(body.inProgress[0]?.kind, "babysit_pr");
    assert.equal(body.inProgress[0]?.status, "in_progress");
    assert.equal(body.inProgress[0]?.label, "Babysitting PR #77");
    assert.equal(body.inProgress[0]?.detail, "acme/widgets - fix activity menu");
    assert.equal(body.inProgress[0]?.targetId, pr.id);
    assert.equal(body.inProgress[0]?.targetUrl, pr.url);

    assert.equal(body.queued.length, 1);
    assert.equal(body.queued[0]?.id, queuedJob.id);
    assert.equal(body.queued[0]?.kind, "sync_watched_repos");
    assert.equal(body.queued[0]?.status, "queued");
    assert.equal(body.queued[0]?.label, "Sync watched repositories");
    assert.equal(body.queued[0]?.targetId, "runtime:1");
  } finally {
    await harness.close();
  }
});

test("GET /api/activities batches PR activity metadata", async () => {
  const harness = await createHarness();
  const firstPr = await seedPR(harness.storage, {
    title: "fix activity menu",
    repo: "acme/widgets",
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
  });
  const secondPr = await seedPR(harness.storage, {
    title: "answer follow-up",
    repo: "acme/widgets",
    number: 78,
    url: "https://github.com/acme/widgets/pull/78",
  });

  try {
    await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: firstPr.id,
      dedupeKey: `babysit_pr:${firstPr.id}`,
      payload: { preferredAgent: "claude" },
    });
    await harness.storage.enqueueBackgroundJob({
      kind: "answer_pr_question",
      targetId: "question-1",
      dedupeKey: "answer_pr_question:question-1",
      payload: { prId: secondPr.id },
    });

    const getPR = harness.storage.getPR.bind(harness.storage);
    harness.storage.getPR = async (id: string) => {
      throw new Error(`unexpected per-job PR lookup for ${id}`);
    };

    const response = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      queued: Array<{
        label: string;
        detail: string | null;
        targetUrl: string | null;
      }>;
    };

    assert.deepEqual(
      body.queued.map((item) => [item.label, item.detail, item.targetUrl]),
      [
        ["Babysitting PR #77", "acme/widgets - fix activity menu", firstPr.url],
        ["Answering question for PR #78", "acme/widgets - answer follow-up", secondPr.url],
      ],
    );
    harness.storage.getPR = getPR;
  } finally {
    await harness.close();
  }
});

test("GET /api/activities hides failed babysitter jobs for archived PRs", async () => {
  const harness = await createHarness();
  const archivedPr = await seedPR(harness.storage, {
    title: "already merged",
    repo: "acme/widgets",
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
    status: "archived",
  });
  const activePr = await seedPR(harness.storage, {
    title: "still open",
    repo: "acme/widgets",
    number: 78,
    url: "https://github.com/acme/widgets/pull/78",
  });

  try {
    const archivedJob = await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: archivedPr.id,
      dedupeKey: `babysit_pr:${archivedPr.id}`,
      payload: { preferredAgent: "claude" },
      availableAt: "2026-04-26T10:00:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-archived",
      leaseToken: "lease-archived",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:01:00.000Z",
    });
    await harness.storage.failBackgroundJob(
      archivedJob.id,
      "lease-archived",
      "agent timed out",
      "2026-04-26T10:02:00.000Z",
    );

    const activeJob = await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: activePr.id,
      dedupeKey: `babysit_pr:${activePr.id}`,
      payload: { preferredAgent: "claude" },
      availableAt: "2026-04-26T10:03:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-active",
      leaseToken: "lease-active",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:03:00.000Z",
    });
    await harness.storage.failBackgroundJob(
      activeJob.id,
      "lease-active",
      "agent timed out",
      "2026-04-26T10:04:00.000Z",
    );

    const response = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      failed: Array<{ id: string; targetId: string }>;
    };

    assert.deepEqual(body.failed.map((item) => item.id), [activeJob.id]);
    assert.equal(body.failed[0]?.targetId, activePr.id);
  } finally {
    await harness.close();
  }
});

test("GET /api/activities hides failed question jobs for archived PRs", async () => {
  const harness = await createHarness();
  const archivedPr = await seedPR(harness.storage, {
    title: "closed follow-up",
    repo: "acme/widgets",
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
    status: "archived",
  });

  try {
    const questionJob = await harness.storage.enqueueBackgroundJob({
      kind: "answer_pr_question",
      targetId: "question-archived",
      dedupeKey: "answer_pr_question:question-archived",
      payload: { prId: archivedPr.id },
      availableAt: "2026-04-26T10:00:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-question",
      leaseToken: "lease-question",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:01:00.000Z",
      kinds: ["answer_pr_question"],
    });
    await harness.storage.failBackgroundJob(
      questionJob.id,
      "lease-question",
      "question agent timed out",
      "2026-04-26T10:02:00.000Z",
    );

    const response = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      failed: Array<{ id: string }>;
    };

    assert.equal(body.failed.length, 0);
  } finally {
    await harness.close();
  }
});

test("GET /api/activities warns when a babysitter job fails from agent authentication", async () => {
  const harness = await createHarness();
  const pr = await seedPR(harness.storage, {
    title: "fix auth warning",
    repo: "acme/widgets",
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
  });

  try {
    const job = await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: pr.id,
      dedupeKey: `babysit_pr:${pr.id}`,
      payload: { preferredAgent: "claude" },
      availableAt: "2026-04-26T10:00:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:01:00.000Z",
    });
    await harness.storage.failBackgroundJob(
      job.id,
      "lease-1",
      "claude evaluation failed (1): Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid authentication credentials\"}}",
      "2026-04-26T10:02:00.000Z",
    );
    await harness.storage.updatePR(pr.id, {
      status: "error",
      lastChecked: "2026-04-26T10:02:00.000Z",
    });

    const response = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      warnings?: Array<{
        id: string;
        severity: string;
        title: string;
        message: string;
        fixSteps: string[];
        targetId: string;
        targetUrl: string | null;
      }>;
    };

    assert.ok(Array.isArray(body.warnings));
    assert.equal(body.warnings.length, 1);
    assert.equal(body.warnings[0]?.id, job.id);
    assert.equal(body.warnings[0]?.severity, "warning");
    assert.equal(body.warnings[0]?.title, "Claude authentication failed");
    assert.match(body.warnings[0]?.message ?? "", /PR #77/);
    assert.match(body.warnings[0]?.message ?? "", /acme\/widgets/);
    assert.deepEqual(body.warnings[0]?.fixSteps, [
      "Run `claude auth login` on this machine.",
      "Restart oh-my-pr if it was launched before you refreshed credentials.",
      "Rerun the babysitter for this PR.",
    ]);
    assert.equal(body.warnings[0]?.targetId, pr.id);
    assert.equal(body.warnings[0]?.targetUrl, pr.url);
  } finally {
    await harness.close();
  }
});

test("GET /api/activities warns when a babysitter job fails from Codex session permissions", async () => {
  const harness = await createHarness();
  const pr = await seedPR(harness.storage, {
    title: "fix codex warning",
    repo: "acme/widgets",
    number: 78,
    url: "https://github.com/acme/widgets/pull/78",
  });

  try {
    const job = await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: pr.id,
      dedupeKey: `babysit_pr:${pr.id}`,
      payload: { preferredAgent: "codex" },
      availableAt: "2026-04-26T10:00:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:01:00.000Z",
    });
    await harness.storage.failBackgroundJob(
      job.id,
      "lease-1",
      "Agent health check failed for codex: codex health check failed: Error: thread/start: Codex cannot access session files at /Users/dgyk/.codex/sessions (permission denied)",
      "2026-04-26T10:02:00.000Z",
    );
    await harness.storage.updatePR(pr.id, {
      status: "error",
      lastChecked: "2026-04-26T10:02:00.000Z",
    });

    const response = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      warnings?: Array<{
        title: string;
        fixSteps: string[];
      }>;
    };

    assert.equal(body.warnings?.[0]?.title, "Codex authentication failed");
    assert.deepEqual(body.warnings?.[0]?.fixSteps, [
      "Run `codex login` on this machine.",
      "Check ownership and permissions for ~/.codex, especially ~/.codex/sessions, so oh-my-pr can access Codex session files.",
      "Restart oh-my-pr if it was launched before you refreshed credentials.",
      "Rerun the babysitter for this PR.",
    ]);
  } finally {
    await harness.close();
  }
});

for (const agent of [
  { preferredAgent: "codex", label: "Codex", installName: "Codex", prNumber: 78 },
  { preferredAgent: "claude", label: "Claude", installName: "Claude Code", prNumber: 79 },
] as const) {
  test(`GET /api/activities explains PATH repair when ${agent.label} CLI is missing`, async () => {
    const harness = await createHarness();
    const pr = await seedPR(harness.storage, {
      title: `fix ${agent.preferredAgent} warning`,
      repo: "acme/widgets",
      number: agent.prNumber,
      url: `https://github.com/acme/widgets/pull/${agent.prNumber}`,
    });

    try {
      const job = await harness.storage.enqueueBackgroundJob({
        kind: "babysit_pr",
        targetId: pr.id,
        dedupeKey: `babysit_pr:${pr.id}`,
        payload: { preferredAgent: agent.preferredAgent },
        availableAt: "2026-04-26T11:00:00.000Z",
      });
      await harness.storage.claimNextBackgroundJob({
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseExpiresAt: "2026-04-26T11:10:00.000Z",
        now: "2026-04-26T11:01:00.000Z",
      });
      await harness.storage.failBackgroundJob(
        job.id,
        "lease-1",
        `Configured coding agent ${agent.preferredAgent} CLI is not installed`,
        "2026-04-26T11:02:00.000Z",
      );
      await harness.storage.updatePR(pr.id, {
        status: "error",
        lastChecked: "2026-04-26T11:02:00.000Z",
      });

      const response = await fetch(`${harness.baseUrl}/api/activities`);
      assert.equal(response.status, 200);
      const body = await response.json() as {
        warnings?: Array<{
          title: string;
          fixSteps: string[];
        }>;
      };

      assert.equal(body.warnings?.[0]?.title, `${agent.label} CLI not installed`);
      assert.deepEqual(body.warnings?.[0]?.fixSteps, [
        `Install the ${agent.installName} CLI on this machine.`,
        `If ${agent.label} is already installed, make sure oh-my-pr can find it on PATH. The app checks its process PATH, then \`$SHELL -lc "command -v ${agent.preferredAgent}"\`.`,
        "For nvm installs, add the active Node bin directory to a login-shell startup file such as ~/.zprofile; for example: export PATH=\"$HOME/.nvm/versions/node/<version>/bin:$PATH\".",
        `Verify with \`command -v ${agent.preferredAgent}\` and \`$SHELL -lc "command -v ${agent.preferredAgent}"\`.`,
        "Restart oh-my-pr after installing.",
        "Rerun the babysitter for this PR.",
      ]);
    } finally {
      await harness.close();
    }
  });
}

test("DELETE /api/activities/failed clears only failed activity jobs", async () => {
  const harness = await createHarness();
  const pr = await seedPR(harness.storage, {
    title: "clear failed activity",
    repo: "acme/widgets",
    number: 77,
    url: "https://github.com/acme/widgets/pull/77",
  });

  try {
    const failedJob = await harness.storage.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: pr.id,
      dedupeKey: `babysit_pr:${pr.id}`,
      payload: { preferredAgent: "claude" },
      availableAt: "2026-04-26T10:00:00.000Z",
    });
    await harness.storage.claimNextBackgroundJob({
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-04-26T10:10:00.000Z",
      now: "2026-04-26T10:01:00.000Z",
    });
    await harness.storage.failBackgroundJob(
      failedJob.id,
      "lease-1",
      "agent timed out",
      "2026-04-26T10:02:00.000Z",
    );

    const queuedJob = await harness.storage.enqueueBackgroundJob({
      kind: "sync_watched_repos",
      targetId: "runtime:1",
      dedupeKey: "sync_watched_repos",
      availableAt: "2026-04-26T10:03:00.000Z",
    });

    const response = await fetch(`${harness.baseUrl}/api/activities/failed`, {
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { cleared: number };
    assert.equal(body.cleared, 1);

    const activitiesResponse = await fetch(`${harness.baseUrl}/api/activities`);
    assert.equal(activitiesResponse.status, 200);
    const activities = await activitiesResponse.json() as {
      failed: Array<{ id: string }>;
      queued: Array<{ id: string }>;
    };
    assert.equal(activities.failed.length, 0);
    assert.equal(activities.queued.length, 1);
    assert.equal(activities.queued[0]?.id, queuedJob.id);
  } finally {
    await harness.close();
  }
});

test("POST /api/repos/release queues a manual release run for the requested repo", async () => {
  const storage = new MemStorage();
  const harness = await createHarness(storage, {
    releaseManager: makeReleaseManagerForRoutes(storage),
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/repos/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "https://github.com/acme/widgets" }),
    });

    assert.equal(response.status, 201);
    const body = await response.json() as {
      repo: string;
      source?: string;
      triggerPrNumber: number;
      triggerMergeSha: string;
    };
    assert.equal(body.repo, "acme/widgets");
    assert.equal(body.source, "manual");
    assert.equal(body.triggerPrNumber, 42);
    assert.equal(body.triggerMergeSha, "manual-release-sha");
  } finally {
    await harness.close();
  }
});

test("POST /api/repos/release reports drain reason and does not queue release work", async () => {
  const storage = new MemStorage();
  const harness = await createHarness(storage, {
    releaseManager: makeReleaseManagerForRoutes(storage),
  });
  await harness.storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-05-03T17:32:41.034Z",
    drainReason: "Agent health check failed for codex: codex health check timed out after 30000ms",
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/repos/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "acme/widgets" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? "", /manual runs are blocked/i);
    assert.match(body.error ?? "", /codex health check timed out/i);

    const releaseRuns = await harness.storage.listReleaseRuns();
    assert.equal(releaseRuns.length, 0);

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "process_release_run",
      status: "queued",
    });
    assert.equal(jobs.length, 0);
  } finally {
    await harness.close();
  }
});

test("POST /api/repos/release returns 409 when the repo has no unreleased merged PRs", async () => {
  const storage = new MemStorage();
  const harness = await createHarness(storage, {
    releaseManager: makeReleaseManagerForRoutes(storage, {
      listUnreleasedMergedPulls: async () => [],
    }),
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/repos/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "acme/widgets" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json() as { error: string };
    assert.match(body.error, /No unreleased merged pull requests found for acme\/widgets/);
  } finally {
    await harness.close();
  }
});

test("POST /api/releases/:id/retry reports drain reason and does not queue release work", async () => {
  const storage = new MemStorage();
  const harness = await createHarness(storage, {
    releaseManager: makeReleaseManagerForRoutes(storage),
  });
  const release = await storage.createReleaseRun({
    repo: "acme/widgets",
    baseBranch: "main",
    triggerPrNumber: 42,
    triggerPrTitle: "Manual release",
    triggerPrUrl: "https://github.com/acme/widgets/pull/42",
    triggerMergeSha: "manual-release-sha",
    triggerMergedAt: "2026-04-24T12:00:00.000Z",
    source: "manual",
    status: "error",
    decisionReason: "Manual release requested",
    recommendedBump: "patch",
    proposedVersion: "v1.2.4",
    releaseTitle: "Manual release",
    releaseNotes: "Manual release notes",
    includedPrs: [],
    targetSha: null,
    githubReleaseId: null,
    githubReleaseUrl: null,
    error: "release agent failed",
    completedAt: null,
  });
  await harness.storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-05-03T17:32:41.034Z",
    drainReason: "Agent health check failed for codex: codex health check timed out after 30000ms",
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/releases/${release.id}/retry`, {
      method: "POST",
    });

    assert.equal(response.status, 409);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? "", /manual runs are blocked/i);
    assert.match(body.error ?? "", /codex health check timed out/i);

    const updated = await harness.storage.getReleaseRun(release.id);
    assert.equal(updated?.status, "error");

    const jobs = await harness.storage.listBackgroundJobs({
      kind: "process_release_run",
      status: "queued",
    });
    assert.equal(jobs.length, 0);
  } finally {
    await harness.close();
  }
});

test("GET/PATCH /api/repos/settings exposes repo-level settings", async () => {
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
      ownPrsOnly: boolean;
    }>;
    assert.deepEqual(initial, [{
      repo: "acme/widgets",
      autoCreateReleases: false,
      ownPrsOnly: true,
    }]);

    const updateResponse = await fetch(`${harness.baseUrl}/api/repos/settings`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repo: "acme/widgets",
        autoCreateReleases: false,
        ownPrsOnly: false,
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json() as {
      repo: string;
      autoCreateReleases: boolean;
      ownPrsOnly: boolean;
    };
    assert.deepEqual(updated, {
      repo: "acme/widgets",
      autoCreateReleases: false,
      ownPrsOnly: false,
    });

    const persisted = await harness.storage.getRepoSettings("acme/widgets");
    assert.deepEqual(persisted, {
      repo: "acme/widgets",
      autoCreateReleases: false,
      ownPrsOnly: false,
    });
  } finally {
    await harness.close();
  }
});

test("PATCH /api/repos/settings can update only ownPrsOnly", async () => {
  const harness = await createHarness();
  await harness.storage.updateRepoSettings("acme/widgets", {
    autoCreateReleases: false,
    ownPrsOnly: true,
  });

  try {
    const updateResponse = await fetch(`${harness.baseUrl}/api/repos/settings`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repo: "acme/widgets",
        ownPrsOnly: false,
      }),
    });
    assert.equal(updateResponse.status, 200);

    const updated = await updateResponse.json() as {
      repo: string;
      autoCreateReleases: boolean;
      ownPrsOnly: boolean;
    };
    assert.deepEqual(updated, {
      repo: "acme/widgets",
      autoCreateReleases: false,
      ownPrsOnly: false,
    });
  } finally {
    await harness.close();
  }
});

test("DELETE /api/repos unwatches a repository without deleting existing PRs", async () => {
  const harness = await createHarness();
  await harness.storage.updateConfig({
    watchedRepos: ["acme/api", "acme/widgets"],
  });
  await harness.storage.updateRepoSettings("acme/widgets", {
    autoCreateReleases: true,
    ownPrsOnly: false,
  });
  const pr = await seedPR(harness.storage);

  try {
    const response = await fetch(`${harness.baseUrl}/api/repos`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repo: "https://github.com/acme/widgets",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      repo: "acme/widgets",
    });

    const config = await harness.storage.getConfig();
    assert.deepEqual(config.watchedRepos, ["acme/api"]);

    const settingsResponse = await fetch(`${harness.baseUrl}/api/repos/settings`);
    assert.equal(settingsResponse.status, 200);
    assert.deepEqual(await settingsResponse.json(), [{
      repo: "acme/api",
      autoCreateReleases: false,
      ownPrsOnly: true,
    }]);

    assert.deepEqual(await harness.storage.getPR(pr.id), pr);
  } finally {
    await harness.close();
  }
});

test("GET /api/app-update exposes the app update check result", async () => {
  const originalVersion = process.env.APP_VERSION;
  process.env.APP_VERSION = "1.0.0";
  const expected: AppUpdateStatus = {
    currentVersion: "1.0.0",
    latestVersion: "v1.1.0",
    latestReleaseUrl: "https://github.com/yungookim/oh-my-pr/releases/tag/v1.1.0",
    updateAvailable: true,
  };
  const harness = await createHarness(new MemStorage(), {
    appUpdateChecker: async (currentVersion) => ({
      ...expected,
      currentVersion,
    }),
  });

  try {
    const response = await fetch(`${harness.baseUrl}/api/app-update`);
    assert.equal(response.status, 200);
    const payload = await response.json() as AppUpdateStatus;
    assert.deepEqual(payload, expected);
  } finally {
    process.env.APP_VERSION = originalVersion;
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
