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
