import assert from "node:assert/strict";
import test from "node:test";
import { MemStorage } from "./memoryStorage";
import { CIHealingManager } from "./ciHealingManager";
import type { Config, PR } from "@shared/schema";

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
    autoUpdateDocs: true,
    autoHealCI: true,
    maxHealingAttemptsPerSession: 3,
    maxHealingAttemptsPerFingerprint: 2,
    maxConcurrentHealingRuns: 1,
    healingCooldownMs: 300000,
    watchedRepos: [],
    trustedReviewers: [],
    ignoredBots: ["dependabot[bot]", "codecov[bot]", "github-actions[bot]"],
    ...overrides,
  };
}

function makePR(overrides: Partial<PR> = {}): Omit<PR, "id" | "addedAt"> {
  return {
    number: 42,
    title: "Healing candidate",
    repo: "owner/repo",
    branch: "feature/healing",
    author: "octocat",
    url: "https://github.com/owner/repo/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    docsAssessment: null,
    ...overrides,
  };
}

function makeSessionInput(overrides: Partial<{ prId: string; repo: string; prNumber: number; headSha: string }> = {}) {
  return {
    prId: "pr-1",
    repo: "owner/repo",
    prNumber: 42,
    headSha: "sha-a",
    ...overrides,
  };
}

test("CIHealingManager creates sessions and supersedes older head sessions", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const pr = await storage.addPR(makePR());
  const manager = new CIHealingManager(storage);

  const first = await manager.ensureSessionForHead({
    ...makeSessionInput({ prId: pr.id }),
    headSha: "sha-a",
  });
  assert.equal(first.state, "triaging");
  assert.equal(first.initialHeadSha, "sha-a");

  const sameHead = await manager.ensureSessionForHead({
    ...makeSessionInput({ prId: pr.id }),
    headSha: "sha-a",
  });
  assert.equal(sameHead.id, first.id);

  const second = await manager.ensureSessionForHead({
    ...makeSessionInput({ prId: pr.id }),
    headSha: "sha-b",
  });
  assert.equal(second.state, "triaging");
  assert.equal(second.initialHeadSha, "sha-b");
  assert.equal(second.currentHeadSha, "sha-b");

  const superseded = await storage.getHealingSession(first.id);
  assert.equal(superseded?.state, "superseded");
  assert.ok(superseded?.endedAt);
  assert.equal(superseded?.escalationReason, "PR head moved to sha-b");

  const headLookup = await manager.getSessionByPrAndHead(pr.id, "sha-b");
  assert.equal(headLookup?.id, second.id);
});

test("CIHealingManager enforces legal transitions", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const pr = await storage.addPR(makePR());
  const manager = new CIHealingManager(storage);
  const session = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "sha-a",
    currentHeadSha: "sha-a",
    state: "idle",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: null,
    attemptCount: 0,
    lastImprovementScore: null,
  });

  await assert.rejects(() => manager.markHealed(session.id), /Illegal healing session transition: idle -> healed/);

  const triaging = await manager.markTriaging(session.id);
  assert.equal(triaging.state, "triaging");

  const awaiting = await manager.markAwaitingRepairSlot(session.id);
  assert.equal(awaiting.state, "awaiting_repair_slot");

  const repairing = await manager.markRepairing(session.id);
  assert.equal(repairing.state, "repairing");
  assert.equal(repairing.attemptCount, 1);

  const awaitingCi = await manager.markAwaitingCi(session.id);
  assert.equal(awaitingCi.state, "awaiting_ci");

  const verifying = await manager.markVerifying(session.id);
  assert.equal(verifying.state, "verifying");

  const healed = await manager.markHealed(session.id);
  assert.equal(healed.state, "healed");
  assert.ok(healed.endedAt);
});

test("CIHealingManager reports retry budgets and cooldowns", async () => {
  let current = new Date("2026-04-01T10:00:00.000Z");
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig({
    maxHealingAttemptsPerSession: 2,
    maxHealingAttemptsPerFingerprint: 1,
    healingCooldownMs: 60_000,
  }));
  const pr = await storage.addPR(makePR());
  const manager = new CIHealingManager(storage, () => new Date(current));

  const session = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "sha-a",
    currentHeadSha: "sha-a",
    state: "awaiting_repair_slot",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: "build",
    attemptCount: 2,
    lastImprovementScore: null,
  });

  const exhausted = await manager.canRetry(session.id, "build");
  assert.equal(exhausted.canRetry, false);
  assert.equal(exhausted.reason, "session retry budget exhausted");
  assert.equal(exhausted.sessionAttempts, 2);
  assert.equal(exhausted.maxSessionAttempts, 2);

  const fingerprintSession = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "sha-b",
    currentHeadSha: "sha-b",
    state: "awaiting_repair_slot",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: "lint",
    attemptCount: 0,
    lastImprovementScore: null,
  });
  await storage.createHealingAttempt({
    sessionId: fingerprintSession.id,
    attemptNumber: 1,
    inputSha: "sha-b",
    outputSha: null,
    status: "failed",
    endedAt: null,
    agent: "claude",
    promptDigest: "prompt",
    targetFingerprints: ["lint"],
    summary: "lint failed",
    improvementScore: null,
    error: null,
  });

  const fingerprintBudget = await manager.canRetry(fingerprintSession.id, "lint");
  assert.equal(fingerprintBudget.canRetry, false);
  assert.equal(fingerprintBudget.reason, "retry budget exhausted for fingerprint lint");
  assert.equal(fingerprintBudget.fingerprintAttempts, 1);
  assert.equal(fingerprintBudget.maxFingerprintAttempts, 1);

  const cooldownSession = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "sha-c",
    currentHeadSha: "sha-c",
    state: "awaiting_repair_slot",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: "tests",
    attemptCount: 1,
    lastImprovementScore: null,
  });

  const cooled = await manager.markCooldown(cooldownSession.id);
  current = new Date(cooled.updatedAt);

  const cooling = await manager.canRetry(cooldownSession.id, "tests");
  assert.equal(cooling.canRetry, false);
  assert.equal(cooling.reason, "cooldown active for 60000ms");
  assert.equal(cooling.cooldownRemainingMs, 60000);

  current = new Date(new Date(cooled.updatedAt).getTime() + 60_001);
  const resumed = await manager.resumeRetry(cooldownSession.id, "tests");
  assert.equal(resumed.state, "awaiting_repair_slot");
});
