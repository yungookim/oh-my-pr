import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "@octokit/rest";
import { MemStorage } from "./memoryStorage";
import { ReleaseManager, type ReleaseGitHubService } from "./releaseManager";
import type { Config } from "@shared/schema";
import type { ReleaseAgentPullSummary, ReleaseEvaluationDecision } from "./releaseAgent";

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

test("ReleaseManager publishes a release for a positive agent decision", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  let createCalls = 0;
  const manager = new ReleaseManager(storage, {
    github: makeGitHubService({
      createGitHubRelease: async (_octokit, _repo, params) => {
        createCalls += 1;
        assert.equal(params.tagName, "v1.3.0");
        assert.equal(params.targetCommitish, "abc123");
        return makePublishedRelease(params.tagName);
      },
    }),
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

  await manager.waitForIdle();
  const stored = await storage.getReleaseRun(created.id);

  assert.ok(stored);
  assert.equal(stored.status, "published");
  assert.equal(stored.recommendedBump, "minor");
  assert.equal(stored.proposedVersion, "v1.3.0");
  assert.equal(stored.githubReleaseUrl, "https://github.com/yungookim/oh-my-pr/releases/tag/v1.3.0");
  assert.equal(stored.includedPrs.length, 2);
  assert.equal(createCalls, 1);
});

test("ReleaseManager marks runs skipped when the agent rejects release creation", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  let createCalls = 0;
  const manager = new ReleaseManager(storage, {
    github: makeGitHubService({
      createGitHubRelease: async () => {
        createCalls += 1;
        return makePublishedRelease();
      },
    }),
    evaluateRelease: async (): Promise<ReleaseEvaluationDecision> => ({
      shouldRelease: false,
      reason: "No user-visible changes.",
      bump: null,
      title: null,
      notes: null,
    }),
  });

  const created = await manager.enqueueMergedPullReleaseEvaluation({
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    triggerPrNumber: 72,
    triggerPrTitle: "Refactor internals",
    triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/72",
    triggerMergeSha: "skip123",
    triggerMergedAt: "2026-03-28T16:00:00.000Z",
  });

  await manager.waitForIdle();
  const stored = await storage.getReleaseRun(created.id);

  assert.ok(stored);
  assert.equal(stored.status, "skipped");
  assert.equal(stored.decisionReason, "No user-visible changes.");
  assert.equal(createCalls, 0);
});

test("ReleaseManager deduplicates runs for the same repo and merge sha", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  let evaluateCalls = 0;
  const manager = new ReleaseManager(storage, {
    github: makeGitHubService(),
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

  await manager.waitForIdle();
  const runs = await storage.listReleaseRuns();

  assert.equal(first.id, second.id);
  assert.equal(runs.length, 1);
  assert.equal(evaluateCalls, 1);
});

test("ReleaseManager can retry a failed run", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());

  let failFirst = true;
  const manager = new ReleaseManager(storage, {
    github: makeGitHubService({
      createGitHubRelease: async (_octokit, _repo, params) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("temporary GitHub failure");
        }
        return makePublishedRelease(params.tagName);
      },
    }),
    evaluateRelease: async (): Promise<ReleaseEvaluationDecision> => ({
      shouldRelease: true,
      reason: "Worth a patch release",
      bump: "patch",
      title: "Patch release",
      notes: "Patch notes",
    }),
  });

  const created = await manager.enqueueMergedPullReleaseEvaluation({
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    triggerPrNumber: 74,
    triggerPrTitle: "Retryable release",
    triggerPrUrl: "https://github.com/yungookim/oh-my-pr/pull/74",
    triggerMergeSha: "retry-sha",
    triggerMergedAt: "2026-03-28T18:00:00.000Z",
  });

  await manager.waitForIdle();
  let stored = await storage.getReleaseRun(created.id);
  assert.equal(stored?.status, "error");

  const retried = await manager.retryReleaseRun(created.id);
  assert.ok(retried);
  await manager.waitForIdle();

  stored = await storage.getReleaseRun(created.id);
  assert.equal(stored?.status, "published");
});
