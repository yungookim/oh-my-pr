import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./defaultConfig";
import {
  configSchema,
  failureFingerprintSchema,
  healingAttemptSchema,
  healingSessionSchema,
  checkSnapshotSchema,
} from "@shared/schema";
import {
  createCheckSnapshot,
  createFailureFingerprint,
  createHealingAttempt,
  createHealingSession,
} from "@shared/models";

describe("DEFAULT_CONFIG", () => {
  it("has all required fields defined by Config type", () => {
    const requiredFields = [
      "githubToken",
      "codingAgent",
      "maxTurns",
      "batchWindowMs",
      "pollIntervalMs",
      "maxChangesPerRun",
      "autoResolveMergeConflicts",
      "autoCreateReleases",
      "autoUpdateDocs",
      "autoHealCI",
      "maxHealingAttemptsPerSession",
      "maxHealingAttemptsPerFingerprint",
      "maxConcurrentHealingRuns",
      "healingCooldownMs",
      "watchedRepos",
      "trustedReviewers",
      "ignoredBots",
    ] as const;

    for (const field of requiredFields) {
      assert.ok(
        field in DEFAULT_CONFIG,
        `Missing required field: ${field}`,
      );
      assert.notEqual(
        DEFAULT_CONFIG[field],
        undefined,
        `Field ${field} is undefined`,
      );
    }
  });

  it("validates successfully against configSchema", () => {
    const result = configSchema.safeParse(DEFAULT_CONFIG);
    assert.equal(result.success, true, `Validation failed: ${JSON.stringify(result.error?.issues)}`);
  });

  it("includes common bots in default ignoredBots", () => {
    const expectedBots = ["dependabot[bot]", "codecov[bot]", "github-actions[bot]"];
    for (const bot of expectedBots) {
      assert.ok(
        DEFAULT_CONFIG.ignoredBots.includes(bot),
        `ignoredBots should include ${bot}`,
      );
    }
  });

  it("has empty arrays for watchedRepos and trustedReviewers", () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.watchedRepos), "watchedRepos should be an array");
    assert.ok(Array.isArray(DEFAULT_CONFIG.trustedReviewers), "trustedReviewers should be an array");
    assert.equal(DEFAULT_CONFIG.watchedRepos.length, 0, "watchedRepos should be empty by default");
    assert.equal(DEFAULT_CONFIG.trustedReviewers.length, 0, "trustedReviewers should be empty by default");
  });

  it("has empty string as default githubToken", () => {
    assert.equal(typeof DEFAULT_CONFIG.githubToken, "string");
    assert.equal(DEFAULT_CONFIG.githubToken, "");
  });

  it("has positive numbers for numeric fields", () => {
    const numericFields = [
      "maxTurns",
      "batchWindowMs",
      "pollIntervalMs",
      "maxChangesPerRun",
      "maxHealingAttemptsPerSession",
      "maxHealingAttemptsPerFingerprint",
      "maxConcurrentHealingRuns",
      "healingCooldownMs",
    ] as const;
    for (const field of numericFields) {
      assert.equal(typeof DEFAULT_CONFIG[field], "number", `${field} should be a number`);
      assert.ok(DEFAULT_CONFIG[field] > 0, `${field} should be positive, got ${DEFAULT_CONFIG[field]}`);
    }
  });

  it("has a valid codingAgent enum value", () => {
    const validAgents = ["codex", "claude"];
    assert.ok(
      validAgents.includes(DEFAULT_CONFIG.codingAgent),
      `codingAgent should be one of ${validAgents.join(", ")}, got ${DEFAULT_CONFIG.codingAgent}`,
    );
  });

  it("enables docs auto-update by default", () => {
    assert.equal(DEFAULT_CONFIG.autoUpdateDocs, true);
  });

  it("includes CI-healing defaults and validates healing schemas", () => {
    assert.equal(DEFAULT_CONFIG.autoHealCI, false);
    assert.equal(DEFAULT_CONFIG.maxHealingAttemptsPerSession, 3);
    assert.equal(DEFAULT_CONFIG.maxHealingAttemptsPerFingerprint, 2);
    assert.equal(DEFAULT_CONFIG.maxConcurrentHealingRuns, 1);
    assert.equal(DEFAULT_CONFIG.healingCooldownMs, 300000);

    const snapshot = createCheckSnapshot({
      prId: "pr-1",
      sha: "abc123",
      provider: "github",
      context: "build",
      status: "completed",
      conclusion: "failure",
      description: "Build failed",
      targetUrl: "https://github.com/owner/repo/actions/runs/1",
      observedAt: "2026-04-01T12:00:00.000Z",
    });

    const fingerprint = createFailureFingerprint({
      sessionId: "session-1",
      sha: "abc123",
      fingerprint: "build-failure",
      category: "build",
      classification: "healable_in_branch",
      summary: "A build error can be fixed in branch",
      selectedEvidence: ["line 12", "line 15"],
    });

    const session = createHealingSession({
      prId: "pr-1",
      repo: "owner/repo",
      prNumber: 42,
      initialHeadSha: "abc123",
      currentHeadSha: "abc123",
      state: "triaging",
      endedAt: null,
      blockedReason: null,
      escalationReason: null,
      latestFingerprint: null,
      attemptCount: 0,
      lastImprovementScore: null,
    });

    const attempt = createHealingAttempt({
      sessionId: session.id,
      attemptNumber: 1,
      inputSha: "abc123",
      outputSha: null,
      status: "queued",
      endedAt: null,
      agent: "claude",
      promptDigest: "digest",
      targetFingerprints: [fingerprint.fingerprint],
      summary: null,
      improvementScore: null,
      error: null,
    });

    assert.equal(checkSnapshotSchema.safeParse(snapshot).success, true);
    assert.equal(failureFingerprintSchema.safeParse(fingerprint).success, true);
    assert.equal(healingSessionSchema.safeParse(session).success, true);
    assert.equal(healingAttemptSchema.safeParse(attempt).success, true);
  });
});
