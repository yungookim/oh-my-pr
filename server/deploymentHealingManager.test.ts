import assert from "node:assert/strict";
import test from "node:test";
import { MemStorage } from "./memoryStorage";
import { DeploymentHealingManager } from "./deploymentHealingManager";
import type { Config } from "@shared/schema";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubTokens: [], codingAgent: "claude", maxTurns: 15, batchWindowMs: 300000,
    pollIntervalMs: 120000, maxChangesPerRun: 20, autoResolveMergeConflicts: true,
    autoCreateReleases: true, autoUpdateDocs: true, autoHealCI: false,
    maxHealingAttemptsPerSession: 3, maxHealingAttemptsPerFingerprint: 2,
    maxConcurrentHealingRuns: 1, healingCooldownMs: 300000,
    watchedRepos: [], trustedReviewers: [], ignoredBots: [],
    autoHealDeployments: true, deploymentCheckDelayMs: 60000,
    deploymentCheckTimeoutMs: 600000, deploymentCheckPollIntervalMs: 15000,
    ...overrides,
  };
}

test("creates a deployment healing session", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);
  const session = await manager.createSession({
    repo: "owner/repo", platform: "vercel", triggerPrNumber: 42,
    triggerPrTitle: "Add feature", triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });
  assert.ok(session.id);
  assert.equal(session.state, "monitoring");
  assert.equal(session.platform, "vercel");
});

test("transitions session through states", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);
  const session = await manager.createSession({
    repo: "owner/repo", platform: "vercel", triggerPrNumber: 42,
    triggerPrTitle: "Add feature", triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });
  const failed = await manager.transitionTo(session.id, "failed", { deploymentId: "dpl_abc", deploymentLog: "Build error" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.deploymentId, "dpl_abc");
  const fixing = await manager.transitionTo(session.id, "fixing");
  assert.equal(fixing.state, "fixing");
  const submitted = await manager.transitionTo(session.id, "fix_submitted", {
    fixBranch: "deploy-fix/vercel-1234", fixPrNumber: 43,
    fixPrUrl: "https://github.com/owner/repo/pull/43",
  });
  assert.equal(submitted.state, "fix_submitted");
  assert.ok(submitted.completedAt);
});

test("rejects invalid state transitions", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);
  const session = await manager.createSession({
    repo: "owner/repo", platform: "vercel", triggerPrNumber: 42,
    triggerPrTitle: "Add feature", triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });
  await assert.rejects(() => manager.transitionTo(session.id, "fixing"), /illegal.*transition/i);
});

test("deduplicates by repo + merge sha", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);
  const input = { repo: "owner/repo", platform: "vercel" as const, triggerPrNumber: 42,
    triggerPrTitle: "Add feature", triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123" };
  const first = await manager.createSession(input);
  const second = await manager.ensureSession(input);
  assert.equal(first.id, second.id);
});
