import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "@octokit/rest";
import type { Config, ReleaseRun } from "@shared/schema";
import type { ReleaseAgentPullSummary, ReleaseEvaluationDecision } from "./releaseAgent";
import { BackgroundJobQueue, buildBackgroundJobDedupeKey } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";
import { ReleaseManager, type ReleaseGitHubService } from "./releaseManager";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubToken: "",
    codingAgent: "claude",
    maxTurns: 15,
    batchWindowMs: 300000,
    pollIntervalMs: 120000,
    maxChangesPerRun: 20,
    autoResolveMergeConflicts: true,
    autoCreateReleases: true,
    watchedRepos: [],
    trustedReviewers: [],
    ignoredBots: ["dependabot[bot]", "codecov[bot]", "github-actions[bot]"],
    ...overrides,
  };
}

function makePublishedRelease(tagName = "v1.3.0") {
  return {
    id: 123,
    url: `https://github.com/yungookim/oh-my-pr/releases/tag/${tagName}`,
    tagName,
    name: tagName,
  };
}

function makeMergedSummary(overrides: Partial<ReleaseAgentPullSummary> = {}): ReleaseAgentPullSummary {
  return {
    number: 71,
    title: "Release automation",
    url: "https://github.com/yungookim/oh-my-pr/pull/71",
    author: "octocat",
    repo: "yungookim/oh-my-pr",
    mergedAt: "2026-03-28T15:00:00.000Z",
    mergeSha: "abc123",
    ...overrides,
  };
}

function makeGitHubService(overrides: Partial<ReleaseGitHubService> = {}): ReleaseGitHubService {
  return {
    buildOctokit: async () => ({}) as Octokit,
    findLatestSemverReleaseTag: async () => "v1.2.3",
    bumpReleaseTag: (latestTag, bump) => {
      if (latestTag !== "v1.2.3") {
        throw new Error(`unexpected latest tag: ${latestTag}`);
      }
      if (bump === "major") return "v2.0.0";
      if (bump === "minor") return "v1.3.0";
      return "v1.2.4";
    },
    listMergedPullsForReleaseCandidate: async (_octokit, _repo, options) => [
      makeMergedSummary({
        number: 70,
        title: "Earlier merged change",
        mergedAt: "2026-03-28T14:00:00.000Z",
        mergeSha: "def456",
      }),
      options.triggerPr,
    ],
    findReleaseByTag: async () => null,
    createGitHubRelease: async (_octokit, _repo, params) => makePublishedRelease(params.tagName),
    ...overrides,
  };
}

function makeReleaseRun(overrides: Partial<ReleaseRun> = {}): ReleaseRun {
  const now = "2026-03-28T18:00:00.000Z";
  return {
    id: "release-run-1",
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    triggerPrNumber: 74,
    triggerPrTitle: "Retryable release",
    triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/74",
    triggerMergeSha: "retry-sha",
    triggerMergedAt: now,
    status: "error",
    decisionReason: null,
    recommendedBump: null,
    proposedVersion: null,
    releaseTitle: null,
    releaseNotes: null,
    includedPrs: [],
    targetSha: "retry-sha",
    githubReleaseId: null,
    githubReleaseUrl: null,
    error: "temporary GitHub failure",
    completedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createQueuedManager(params?: {
  storage?: MemStorage;
  github?: Partial<ReleaseGitHubService>;
  evaluateRelease?: () => Promise<ReleaseEvaluationDecision>;
}) {
  const storage = params?.storage ?? new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const manager = new ReleaseManager(storage, {
    github: makeGitHubService(params?.github),
    evaluateRelease: params?.evaluateRelease,
    scheduleBackgroundJob: queue.enqueue.bind(queue),
  });

  return { storage, queue, manager };
}

test("ReleaseManager enqueues a durable release job and still executes the release flow", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  let createCalls = 0;
  const { manager } = createQueuedManager({
    storage,
    github: {
      createGitHubRelease: async (_octokit, _repo, params) => {
        createCalls += 1;
        assert.equal(params.tagName, "v1.3.0");
        assert.equal(params.targetCommitish, "abc123");
        return makePublishedRelease(params.tagName);
      },
    },
    evaluateRelease: async (): Promise<ReleaseEvaluationDecision> => ({
      shouldRelease: true,
      reason: "User-facing release automation",
      bump: "minor",
      title: "Automated release management",
      notes: "## Highlights\n- Adds automated releases.",
    }),
  });

  const created = await manager.enqueueMergedPullReleaseEvaluation({
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    triggerPrNumber: 71,
    triggerPrTitle: "Release automation",
    triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/71",
    triggerMergeSha: "abc123",
    triggerMergedAt: "2026-03-28T15:00:00.000Z",
  });

  const queuedJobs = await storage.listBackgroundJobs({
    kind: "process_release_run",
    status: "queued",
  });
  assert.equal(queuedJobs.length, 1);
  assert.equal(queuedJobs[0].targetId, created.id);
  assert.equal(queuedJobs[0].dedupeKey, buildBackgroundJobDedupeKey("process_release_run", created.id));
  assert.equal(await manager.waitForIdle(), true);

  const processed = await manager.processReleaseRun(created.id);
  const stored = await storage.getReleaseRun(created.id);

  assert.ok(processed);
  assert.ok(stored);
  assert.equal(stored.status, "published");
  assert.equal(stored.recommendedBump, "minor");
  assert.equal(stored.proposedVersion, "v1.3.0");
  assert.equal(stored.githubReleaseUrl, "https://github.com/yungookim/oh-my-pr/releases/tag/v1.3.0");
  assert.equal(stored.includedPrs.length, 2);
  assert.equal(createCalls, 1);
});

test("ReleaseManager reuses an active release row and the durable process job", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  let evaluateCalls = 0;
  const { manager } = createQueuedManager({
    storage,
    evaluateRelease: async (): Promise<ReleaseEvaluationDecision> => {
      evaluateCalls += 1;
      return {
        shouldRelease: true,
        reason: "Worth a patch release",
        bump: "patch",
        title: "Patch release",
        notes: "Patch notes",
      };
    },
  });

  const first = await manager.enqueueMergedPullReleaseEvaluation({
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    triggerPrNumber: 73,
    triggerPrTitle: "Bug fix",
    triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/73",
    triggerMergeSha: "same-sha",
    triggerMergedAt: "2026-03-28T17:00:00.000Z",
  });
  const second = await manager.enqueueMergedPullReleaseEvaluation({
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    triggerPrNumber: 73,
    triggerPrTitle: "Bug fix",
    triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/73",
    triggerMergeSha: "same-sha",
    triggerMergedAt: "2026-03-28T17:00:00.000Z",
  });

  const jobs = await storage.listBackgroundJobs({
    kind: "process_release_run",
    status: "queued",
  });
  const runs = await storage.listReleaseRuns();

  assert.equal(first.id, second.id);
  assert.equal(runs.length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].targetId, first.id);
  assert.equal(evaluateCalls, 0);
  assert.equal(await manager.waitForIdle(), true);
});

test("ReleaseManager retryReleaseRun resets state and enqueues the durable process job", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  const queuedRun = await storage.createReleaseRun(makeReleaseRun());
  const { manager } = createQueuedManager({ storage });

  const retried = await manager.retryReleaseRun(queuedRun.id);
  const jobs = await storage.listBackgroundJobs({
    kind: "process_release_run",
    status: "queued",
  });
  const stored = await storage.getReleaseRun(queuedRun.id);

  assert.ok(retried);
  assert.ok(stored);
  assert.equal(retried?.status, "detected");
  assert.equal(retried?.error, null);
  assert.equal(retried?.completedAt, null);
  assert.equal(stored.status, "detected");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].targetId, queuedRun.id);
  assert.equal(jobs[0].dedupeKey, buildBackgroundJobDedupeKey("process_release_run", queuedRun.id));
  assert.equal(await manager.waitForIdle(), true);
});

test("ReleaseManager logs release job scheduling failures", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  const schedulingError = new Error("queue unavailable");
  const manager = new ReleaseManager(storage, {
    github: makeGitHubService(),
    scheduleBackgroundJob: async () => {
      throw schedulingError;
    },
  });

  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    const created = await manager.enqueueMergedPullReleaseEvaluation({
      repo: "yungookim/oh-my-pr",
      baseBranch: "main",
      triggerPrNumber: 75,
      triggerPrTitle: "Queue failure logging",
      triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/75",
      triggerMergeSha: "queue-failure-sha",
      triggerMergedAt: "2026-03-28T19:00:00.000Z",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], `Failed to schedule release run ${created.id}:`);
    assert.equal(logged[0][1], schedulingError);
  } finally {
    console.error = originalConsoleError;
  }
});
