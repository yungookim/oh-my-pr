import type { Config } from "@shared/schema";

export const DEFAULT_CONFIG: Config = {
  githubToken: "",
  codingAgent: "claude",
  model: "opus",
  maxTurns: 15,
  batchWindowMs: 300000,
  pollIntervalMs: 120000,
  maxChangesPerRun: 20,
  watchedRepos: [],
  trustedReviewers: [],
  ignoredBots: ["dependabot[bot]", "codecov[bot]", "github-actions[bot]"],
};
