import assert from "node:assert/strict";
import test from "node:test";
import { CancelBackgroundJobError } from "./backgroundJobDispatcher";
import { createBackgroundJobHandlers } from "./backgroundJobHandlers";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";
import type { DeploymentHealingManager } from "./deploymentHealingManager";

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

test("answer_pr_question handler delegates for non-terminal questions", async () => {
  const storage = new MemStorage();
  const prId = await seedPR(storage);
  const question = await storage.addQuestion(prId, "What changed?");
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "answer_pr_question",
    question.id,
    `answer_pr_question:${question.id}`,
    { prId },
  );
  const calls: Array<{ prId: string; questionId: string; question: string; preferredAgent: string }> = [];

  const handlers = createBackgroundJobHandlers({
    storage,
    questionAnswerer: async (params) => {
      calls.push({
        prId: params.prId,
        questionId: params.questionId,
        question: params.question,
        preferredAgent: params.preferredAgent,
      });
    },
  });

  await handlers.answer_pr_question!(job);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    prId,
    questionId: question.id,
    question: "What changed?",
    preferredAgent: "claude",
  });
});

test("sync_watched_repos handler delegates to the babysitter", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue("sync_watched_repos", "runtime:1", "sync_watched_repos", {});
  let syncCalls = 0;

  const handlers = createBackgroundJobHandlers({
    storage,
    babysitter: {
      runQueuedBabysitPR: async () => undefined,
      syncAndBabysitTrackedRepos: async () => {
        syncCalls += 1;
      },
    },
  });

  await handlers.sync_watched_repos!(job);

  assert.equal(syncCalls, 1);
});

test("babysit_pr handler delegates to the babysitter with the queued preferred agent", async () => {
  const storage = new MemStorage();
  const prId = await seedPR(storage);
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "babysit_pr",
    prId,
    `babysit_pr:${prId}`,
    { preferredAgent: "codex" },
  );
  const calls: Array<{ prId: string; preferredAgent: string }> = [];

  const handlers = createBackgroundJobHandlers({
    storage,
    babysitter: {
      syncAndBabysitTrackedRepos: async () => undefined,
      runQueuedBabysitPR: async (queuedPrId, preferredAgent) => {
        calls.push({ prId: queuedPrId, preferredAgent });
      },
    },
  });

  await handlers.babysit_pr!(job);

  assert.deepEqual(calls, [{
    prId,
    preferredAgent: "codex",
  }]);
});

test("babysit_pr handler cancels jobs whose PR row is missing", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "babysit_pr",
    "missing-pr",
    "babysit_pr:missing-pr",
    { preferredAgent: "claude" },
  );

  const handlers = createBackgroundJobHandlers({
    storage,
    babysitter: {
      syncAndBabysitTrackedRepos: async () => undefined,
      runQueuedBabysitPR: async () => undefined,
    },
  });

  await assert.rejects(
    handlers.babysit_pr!(job),
    (error: unknown) => error instanceof CancelBackgroundJobError
      && error.message.includes("missing-pr"),
  );
});

test("answer_pr_question handler no-ops for terminal questions", async () => {
  const storage = new MemStorage();
  const prId = await seedPR(storage);
  const question = await storage.addQuestion(prId, "What changed?");
  await storage.updateQuestion(question.id, {
    status: "answered",
    answer: "Already answered",
    answeredAt: "2026-04-02T12:00:00.000Z",
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "answer_pr_question",
    question.id,
    `answer_pr_question:${question.id}`,
    { prId },
  );
  let called = false;

  const handlers = createBackgroundJobHandlers({
    storage,
    questionAnswerer: async () => {
      called = true;
    },
  });

  await handlers.answer_pr_question!(job);

  assert.equal(called, false);
});

test("answer_pr_question handler cancels jobs whose question row is missing", async () => {
  const storage = new MemStorage();
  const handlers = createBackgroundJobHandlers({ storage });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "answer_pr_question",
    "missing-question",
    "answer_pr_question:missing-question",
    { prId: "missing-pr" },
  );

  await assert.rejects(
    handlers.answer_pr_question!(job),
    (error: unknown) => error instanceof CancelBackgroundJobError
      && error.message.includes("missing-question"),
  );
});

test("generate_social_changelog handler no-ops for terminal rows", async () => {
  const storage = new MemStorage();
  const changelog = await storage.createSocialChangelog({
    date: "2026-04-02",
    triggerCount: 5,
    prSummaries: [],
    content: "done",
    status: "done",
    error: null,
    completedAt: "2026-04-02T12:00:00.000Z",
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "generate_social_changelog",
    changelog.id,
    `generate_social_changelog:${changelog.id}`,
    {},
  );
  let called = false;

  const handlers = createBackgroundJobHandlers({
    storage,
    socialChangelogGenerator: async () => {
      called = true;
    },
  });

  await handlers.generate_social_changelog!(job);

  assert.equal(called, false);
});

test("generate_social_changelog handler cancels jobs whose row is missing", async () => {
  const storage = new MemStorage();
  const handlers = createBackgroundJobHandlers({ storage });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "generate_social_changelog",
    "missing-changelog",
    "generate_social_changelog:missing-changelog",
    {},
  );

  await assert.rejects(
    handlers.generate_social_changelog!(job),
    (error: unknown) => error instanceof CancelBackgroundJobError
      && error.message.includes("missing-changelog"),
  );
});

test("generate_social_changelog handler delegates for non-terminal rows", async () => {
  const storage = new MemStorage();
  const changelog = await storage.createSocialChangelog({
    date: "2026-04-02",
    triggerCount: 5,
    prSummaries: [{
      number: 42,
      title: "feat: add widget",
      url: "https://github.com/acme/widgets/pull/42",
      author: "alice",
      repo: "acme/widgets",
    }],
    content: null,
    status: "generating",
    error: null,
    completedAt: null,
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "generate_social_changelog",
    changelog.id,
    `generate_social_changelog:${changelog.id}`,
    {},
  );
  const calls: Array<{ changelogId: string; date: string; preferredAgent: string }> = [];

  const handlers = createBackgroundJobHandlers({
    storage,
    socialChangelogGenerator: async (params) => {
      calls.push({
        changelogId: params.changelogId,
        date: params.date,
        preferredAgent: params.preferredAgent,
      });
    },
  });

  await handlers.generate_social_changelog!(job);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    changelogId: changelog.id,
    date: "2026-04-02",
    preferredAgent: "claude",
  });
});

test("heal_deployment handler is registered when deploymentHealingManager is provided", () => {
  const storage = new MemStorage();
  const handlers = createBackgroundJobHandlers({
    storage,
    deploymentHealingManager: {} as unknown as DeploymentHealingManager,
  });
  assert.ok(handlers.heal_deployment);
});

test("heal_deployment handler passes an authenticated clone URL to deployment repair when GitHub auth is available", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    deploymentCheckDelayMs: 0,
    deploymentCheckTimeoutMs: 1,
    deploymentCheckPollIntervalMs: 0,
  });

  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "heal_deployment",
    "acme/widgets:merge-sha",
    "heal_deployment:acme/widgets:merge-sha",
    {
      repo: "acme/widgets",
      platform: "railway",
      mergeSha: "merge-sha",
      triggerPrNumber: 42,
      triggerPrTitle: "feat: add widget",
      triggerPrUrl: "https://github.com/acme/widgets/pull/42",
      baseBranch: "main",
    },
  );

  const transitionCalls: Array<{ sessionId: string; state: string; updates: Record<string, unknown> | undefined }> = [];
  let receivedCloneUrl: string | null = null;

  const handlers = createBackgroundJobHandlers({
    storage,
    deploymentHealingManager: {
      ensureSession: async () => ({ id: "session-1" }),
      transitionTo: async (sessionId, state, updates) => {
        transitionCalls.push({ sessionId, state, updates });
        return { id: sessionId, state, ...updates } as never;
      },
    } as unknown as DeploymentHealingManager,
    deps: {
      buildOctokitFn: async () => ({}) as never,
      createAdapterFn: () => ({
        platform: "railway",
        getDeploymentStatus: async () => ({
          state: "error",
          deploymentId: "dep_123",
          url: null,
          error: "deployment failed",
        }),
        getDeploymentLogs: async () => "deployment failed",
      }),
      resolveGitHubAuthTokenFn: async () => "ghs_123",
      runDeploymentHealingRepairFn: async (input) => {
        receivedCloneUrl = input.repoCloneUrl;
        return {
          accepted: false,
          rejectionReason: "no-op",
          summary: "No-op",
          fixBranch: "deploy-fix/railway-1",
          agentResult: { code: 0, stdout: "", stderr: "" },
        };
      },
    },
  });

  await handlers.heal_deployment!(job);

  assert.equal(receivedCloneUrl, "https://x-access-token:ghs_123@github.com/acme/widgets.git");
  assert.deepEqual(
    transitionCalls.map((call) => call.state),
    ["failed", "fixing", "escalated"],
  );
});

test("process_release_run handler delegates to ReleaseManager for active rows", async () => {
  const storage = new MemStorage();
  const releaseRun = await storage.createReleaseRun({
    repo: "acme/widgets",
    baseBranch: "main",
    triggerPrNumber: 42,
    triggerPrTitle: "feat: add widget",
    triggerPrUrl: "https://github.com/acme/widgets/pull/42",
    triggerMergeSha: "merge-sha",
    triggerMergedAt: "2026-04-02T12:00:00.000Z",
    status: "detected",
    decisionReason: null,
    recommendedBump: null,
    proposedVersion: null,
    releaseTitle: null,
    releaseNotes: null,
    includedPrs: [],
    targetSha: "merge-sha",
    githubReleaseId: null,
    githubReleaseUrl: null,
    error: null,
    completedAt: null,
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "process_release_run",
    releaseRun.id,
    `process_release_run:${releaseRun.id}`,
    {},
  );
  const processedIds: string[] = [];

  const handlers = createBackgroundJobHandlers({
    storage,
    releaseManager: {
      processReleaseRun: async (id) => {
        processedIds.push(id);
        return releaseRun;
      },
    },
  });

  await handlers.process_release_run!(job);

  assert.deepEqual(processedIds, [releaseRun.id]);
});
