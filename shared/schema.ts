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
  addedAt: z.string(),
});
export type PR = z.infer<typeof prSchema>;

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

export const configSchema = z.object({
  githubToken: z.string(),
  codingAgent: z.enum(["codex", "claude"]),
  model: z.string(),
  maxTurns: z.number(),
  batchWindowMs: z.number(),
  pollIntervalMs: z.number(),
  maxChangesPerRun: z.number(),
  watchedRepos: z.array(z.string()),
  trustedReviewers: z.array(z.string()),
  ignoredBots: z.array(z.string()),
});
export type Config = z.infer<typeof configSchema>;
