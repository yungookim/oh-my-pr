import { z } from "zod";

// ── Types for PR feedback workflow ──────────────────────────

export const prStatusEnum = z.enum(["watching", "processing", "done", "error", "archived"]);
export type PRStatus = z.infer<typeof prStatusEnum>;

export const triageDecision = z.enum(["accept", "reject", "flag"]);
export type TriageDecision = z.infer<typeof triageDecision>;

export const feedbackStatusEnum = z.enum([
  "pending",
  "queued",
  "in_progress",
  "resolved",
  "failed",
  "warning",
  "rejected",
  "flagged",
]);
export type FeedbackStatus = z.infer<typeof feedbackStatusEnum>;

export const feedbackItemSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  bodyHtml: z.string(),
  replyKind: z.enum(["review_thread", "review", "general_comment"]),
  sourceId: z.string(),
  sourceNodeId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  threadId: z.string().nullable(),
  threadResolved: z.boolean().nullable(),
  auditToken: z.string(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  type: z.enum(["review_comment", "review", "general_comment"]),
  createdAt: z.string(),
  decision: triageDecision.nullable(),
  decisionReason: z.string().nullable(),
  action: z.string().nullable(),
  status: feedbackStatusEnum,
  statusReason: z.string().nullable(),
});
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;

export const docsAssessmentStatusEnum = z.enum(["needed", "not_needed", "failed"]);
export type DocsAssessmentStatus = z.infer<typeof docsAssessmentStatusEnum>;

export const docsAssessmentSchema = z.object({
  headSha: z.string(),
  status: docsAssessmentStatusEnum,
  summary: z.string(),
  assessedAt: z.string(),
});
export type DocsAssessment = z.infer<typeof docsAssessmentSchema>;

export const prSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  repo: z.string(), // "owner/repo"
  branch: z.string(),
  author: z.string(),
  url: z.string(),
  status: prStatusEnum,
  feedbackItems: z.array(feedbackItemSchema),
  accepted: z.number(),
  rejected: z.number(),
  flagged: z.number(),
  testsPassed: z.boolean().nullable(),
  lintPassed: z.boolean().nullable(),
  lastChecked: z.string().nullable(),
  watchEnabled: z.boolean().default(true),
  docsAssessment: docsAssessmentSchema.nullable().optional(),
  addedAt: z.string(),
});
export type PR = z.infer<typeof prSchema>;

export const newPRSchema = prSchema.omit({
  id: true,
  addedAt: true,
});
export type NewPR = z.input<typeof newPRSchema>;

export const addPRSchema = z.object({
  url: z.string().url(),
});
export type AddPR = z.infer<typeof addPRSchema>;

export const logEntrySchema = z.object({
  id: z.string(),
  prId: z.string(),
  runId: z.string().nullable(),
  timestamp: z.string(),
  level: z.enum(["info", "warn", "error"]),
  phase: z.string().nullable(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const agentRunStatusEnum = z.enum(["running", "completed", "failed"]);
export type AgentRunStatus = z.infer<typeof agentRunStatusEnum>;

export const agentRunSchema = z.object({
  id: z.string(),
  prId: z.string(),
  preferredAgent: z.enum(["codex", "claude"]),
  resolvedAgent: z.enum(["codex", "claude"]).nullable(),
  status: agentRunStatusEnum,
  phase: z.string(),
  prompt: z.string().nullable(),
  initialHeadSha: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const runtimeStateSchema = z.object({
  drainMode: z.boolean(),
  drainRequestedAt: z.string().nullable(),
  drainReason: z.string().nullable(),
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const backgroundJobKindEnum = z.enum([
  "sync_watched_repos",
  "babysit_pr",
  "process_release_run",
  "answer_pr_question",
  "generate_social_changelog",
  "heal_deployment",
]);
export type BackgroundJobKind = z.infer<typeof backgroundJobKindEnum>;

export const backgroundJobStatusEnum = z.enum([
  "queued",
  "leased",
  "completed",
  "failed",
  "canceled",
]);
export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusEnum>;

export const backgroundJobSchema = z.object({
  id: z.string(),
  kind: backgroundJobKindEnum,
  targetId: z.string(),
  dedupeKey: z.string(),
  status: backgroundJobStatusEnum,
  priority: z.number().int(),
  availableAt: z.string(),
  leaseOwner: z.string().nullable(),
  leaseToken: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

export const questionStatusEnum = z.enum(["pending", "answering", "answered", "error"]);
export type QuestionStatus = z.infer<typeof questionStatusEnum>;

export const prQuestionSchema = z.object({
  id: z.string(),
  prId: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  status: questionStatusEnum,
  error: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
});
export type PRQuestion = z.infer<typeof prQuestionSchema>;

export const askQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
});

export const socialChangelogStatusEnum = z.enum(["generating", "done", "error"]);
export type SocialChangelogStatus = z.infer<typeof socialChangelogStatusEnum>;

export const socialChangelogPRSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  repo: z.string(),
});
export type SocialChangelogPRSummary = z.infer<typeof socialChangelogPRSummarySchema>;

export const socialChangelogSchema = z.object({
  id: z.string(),
  date: z.string(),               // YYYY-MM-DD UTC
  triggerCount: z.number(),       // The nth merge that triggered this (5, 10, 15…)
  prSummaries: z.array(socialChangelogPRSummarySchema),
  content: z.string().nullable(), // Generated social media post
  status: socialChangelogStatusEnum,
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type SocialChangelog = z.infer<typeof socialChangelogSchema>;

export const healingSessionStateEnum = z.enum([
  "idle",
  "triaging",
  "awaiting_repair_slot",
  "repairing",
  "awaiting_ci",
  "verifying",
  "healed",
  "cooldown",
  "blocked",
  "escalated",
  "superseded",
]);
export type HealingSessionState = z.infer<typeof healingSessionStateEnum>;

export const healingClassificationEnum = z.enum([
  "healable_in_branch",
  "blocked_external",
  "flaky_or_ambiguous",
  "unknown",
]);
export type HealingClassification = z.infer<typeof healingClassificationEnum>;

export const healingAttemptStatusEnum = z.enum([
  "queued",
  "running",
  "awaiting_ci",
  "verified",
  "failed",
  "canceled",
]);
export type HealingAttemptStatus = z.infer<typeof healingAttemptStatusEnum>;

export const checkSnapshotSchema = z.object({
  id: z.string(),
  prId: z.string(),
  sha: z.string(),
  provider: z.string(),
  context: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  description: z.string(),
  targetUrl: z.string().nullable(),
  observedAt: z.string(),
});
export type CheckSnapshot = z.infer<typeof checkSnapshotSchema>;

export const failureFingerprintSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sha: z.string(),
  fingerprint: z.string(),
  category: z.string(),
  classification: healingClassificationEnum,
  summary: z.string(),
  selectedEvidence: z.array(z.string()),
  createdAt: z.string(),
});
export type FailureFingerprint = z.infer<typeof failureFingerprintSchema>;

export const healingSessionSchema = z.object({
  id: z.string(),
  prId: z.string(),
  repo: z.string(),
  prNumber: z.number(),
  initialHeadSha: z.string(),
  currentHeadSha: z.string(),
  state: healingSessionStateEnum,
  startedAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
  escalationReason: z.string().nullable(),
  latestFingerprint: z.string().nullable(),
  attemptCount: z.number(),
  lastImprovementScore: z.number().nullable(),
});
export type HealingSession = z.infer<typeof healingSessionSchema>;

export const healingAttemptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  attemptNumber: z.number(),
  inputSha: z.string(),
  outputSha: z.string().nullable(),
  status: healingAttemptStatusEnum,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  agent: z.enum(["codex", "claude"]),
  promptDigest: z.string(),
  targetFingerprints: z.array(z.string()),
  summary: z.string().nullable(),
  improvementScore: z.number().nullable(),
  error: z.string().nullable(),
});
export type HealingAttempt = z.infer<typeof healingAttemptSchema>;

export const releaseRunStatusEnum = z.enum([
  "detected",
  "evaluating",
  "skipped",
  "proposed",
  "publishing",
  "published",
  "error",
]);
export type ReleaseRunStatus = z.infer<typeof releaseRunStatusEnum>;

export const releaseBumpEnum = z.enum(["patch", "minor", "major"]);
export type ReleaseBump = z.infer<typeof releaseBumpEnum>;

export const releaseRunIncludedPRSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  mergedAt: z.string(),
  mergeSha: z.string(),
});
export type ReleaseRunIncludedPR = z.infer<typeof releaseRunIncludedPRSchema>;

export const releaseRunSchema = z.object({
  id: z.string(),
  repo: z.string(),
  baseBranch: z.string(),
  triggerPrNumber: z.number(),
  triggerPrTitle: z.string(),
  triggerPrUrl: z.string(),
  triggerMergeSha: z.string(),
  triggerMergedAt: z.string(),
  status: releaseRunStatusEnum,
  decisionReason: z.string().nullable(),
  recommendedBump: releaseBumpEnum.nullable(),
  proposedVersion: z.string().nullable(),
  releaseTitle: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  includedPrs: z.array(releaseRunIncludedPRSchema),
  targetSha: z.string().nullable(),
  githubReleaseId: z.number().nullable(),
  githubReleaseUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ReleaseRun = z.infer<typeof releaseRunSchema>;

export const deploymentPlatformEnum = z.enum(["vercel", "railway"]);
export type DeploymentPlatform = z.infer<typeof deploymentPlatformEnum>;

export const deploymentHealingStateEnum = z.enum([
  "monitoring",
  "failed",
  "fixing",
  "fix_submitted",
  "escalated",
]);
export type DeploymentHealingState = z.infer<typeof deploymentHealingStateEnum>;

export const deploymentHealingSessionSchema = z.object({
  id: z.string(),
  repo: z.string(),
  platform: deploymentPlatformEnum,
  triggerPrNumber: z.number(),
  triggerPrTitle: z.string(),
  triggerPrUrl: z.string(),
  mergeSha: z.string(),
  deploymentId: z.string().nullable(),
  deploymentLog: z.string().nullable(),
  fixBranch: z.string().nullable(),
  fixPrNumber: z.number().nullable(),
  fixPrUrl: z.string().nullable(),
  state: deploymentHealingStateEnum,
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type DeploymentHealingSession = z.infer<typeof deploymentHealingSessionSchema>;

export const configSchema = z.object({
  githubToken: z.string(),
  codingAgent: z.enum(["codex", "claude"]),
  maxTurns: z.number(),
  batchWindowMs: z.number(),
  pollIntervalMs: z.number(),
  maxChangesPerRun: z.number(),
  autoResolveMergeConflicts: z.boolean(),
  autoCreateReleases: z.boolean(),
  autoUpdateDocs: z.boolean(),
  autoHealCI: z.boolean(),
  maxHealingAttemptsPerSession: z.number(),
  maxHealingAttemptsPerFingerprint: z.number(),
  maxConcurrentHealingRuns: z.number(),
  healingCooldownMs: z.number(),
  autoHealDeployments: z.boolean(),
  deploymentCheckDelayMs: z.number(),
  deploymentCheckTimeoutMs: z.number(),
  deploymentCheckPollIntervalMs: z.number(),
  watchedRepos: z.array(z.string()),
  trustedReviewers: z.array(z.string()),
  ignoredBots: z.array(z.string()),
});
export type Config = z.infer<typeof configSchema>;

export const watchedRepoSchema = z.object({
  repo: z.string(),
  autoCreateReleases: z.boolean(),
});
export type WatchedRepo = z.infer<typeof watchedRepoSchema>;
