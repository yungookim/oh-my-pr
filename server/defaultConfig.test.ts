import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./defaultConfig";
import { configSchema } from "@shared/schema";

describe("DEFAULT_CONFIG", () => {
  it("has all required fields defined by Config type", () => {
    const requiredFields = [
      "githubToken",
      "codingAgent",
      "maxTurns",
      "batchWindowMs",
      "pollIntervalMs",
      "maxChangesPerRun",
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
    const numericFields = ["maxTurns", "batchWindowMs", "pollIntervalMs", "maxChangesPerRun"] as const;
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
});
