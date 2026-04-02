import type { Config } from "@shared/schema";

export const DEFAULT_CONFIG: Config = {
  githubToken: "",
  codingAgent: "claude",
  maxTurns: 15,
  batchWindowMs: 300000,
  pollIntervalMs: 120000,
  maxChangesPerRun: 20,
  autoResolveMergeConflicts: true,
  autoCreateReleases: true,
  autoUpdateDocs: true,
  autoHealCI: false,
  maxHealingAttemptsPerSession: 3,
  maxHealingAttemptsPerFingerprint: 2,
  maxConcurrentHealingRuns: 1,
  healingCooldownMs: 300000,
  watchedRepos: [],
  trustedReviewers: [],
  ignoredBots: ["dependabot[bot]", "codecov[bot]", "github-actions[bot]"],
};
