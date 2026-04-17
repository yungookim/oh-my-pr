import { randomUUID } from "crypto";
import {
  checkSnapshotSchema,
  agentRunSchema,
  backgroundJobSchema,
  configSchema,
  deploymentHealingSessionSchema,
  feedbackItemSchema,
  failureFingerprintSchema,
  healingAttemptSchema,
  healingSessionSchema,
  logEntrySchema,
  prQuestionSchema,
  prSchema,
  releaseRunSchema,
  socialChangelogSchema,
  watchedRepoSchema,
} from "./schema";
import type {
  AgentRun,
  BackgroundJob,
  Config,
  CheckSnapshot,
  DeploymentHealingSession,
  FeedbackItem,
  FailureFingerprint,
  HealingAttempt,
  HealingSession,
  LogEntry,
  NewPR,
  PR,
  PRQuestion,
  ReleaseRun,
  SocialChangelog,
  WatchedRepo,
} from "./schema";

// ── PR ───────────────────────────────────────────────────────────────────────

export function createPR(data: NewPR): PR {
  return prSchema.parse({
    ...data,
    id: randomUUID(),
    addedAt: new Date().toISOString(),
  });
}

export function applyPRUpdate(existing: PR, updates: Partial<PR>): PR {
  return prSchema.parse({
    ...existing,
    ...updates,
    // Immutable fields
    id: existing.id,
    addedAt: existing.addedAt,
  });
}

// ── Feedback item ─────────────────────────────────────────────────────────────
// FeedbackItems are always created externally (from GitHub), so no factory is
// needed, but we expose a validator to ensure consistency at ingestion time.

export function parseFeedbackItem(raw: unknown): FeedbackItem {
  return feedbackItemSchema.parse(raw);
}

// ── Log entry ────────────────────────────────────────────────────────────────

export function createLogEntry(
  prId: string,
  level: LogEntry["level"],
  message: string,
  details?: {
    runId?: string | null;
    phase?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): LogEntry {
  return logEntrySchema.parse({
    id: randomUUID(),
    prId,
    runId: details?.runId ?? null,
    timestamp: new Date().toISOString(),
    level,
    phase: details?.phase ?? null,
    message,
    metadata: details?.metadata ?? null,
  });
}

// ── PR question ───────────────────────────────────────────────────────────────

export function createPRQuestion(prId: string, question: string): PRQuestion {
  return prQuestionSchema.parse({
    id: randomUUID(),
    prId,
    question,
    answer: null,
    status: "pending",
    error: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  });
}

export function applyPRQuestionUpdate(
  existing: PRQuestion,
  updates: Partial<PRQuestion>,
): PRQuestion {
  return prQuestionSchema.parse({
    ...existing,
    ...updates,
    // Immutable fields
    id: existing.id,
    prId: existing.prId,
    createdAt: existing.createdAt,
  });
}

// ── Agent run ─────────────────────────────────────────────────────────────────

export function createAgentRun(
  data: Omit<AgentRun, "createdAt" | "updatedAt">,
): AgentRun {
  const now = new Date().toISOString();
  return agentRunSchema.parse({
    ...data,
    createdAt: now,
    updatedAt: now,
  });
}

export function touchAgentRun(run: AgentRun, updates: Partial<AgentRun>): AgentRun {
  return agentRunSchema.parse({
    ...run,
    ...updates,
    // Immutable fields
    id: run.id,
    prId: run.prId,
    createdAt: run.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

// ── Background jobs ───────────────────────────────────────────────────────────

export function createBackgroundJob(
  data: Omit<
    BackgroundJob,
    "id" | "status" | "priority" | "leaseOwner" | "leaseToken" | "leaseExpiresAt" | "heartbeatAt" |
    "attemptCount" | "lastError" | "createdAt" | "updatedAt" | "completedAt"
  > & {
    priority?: number;
  },
): BackgroundJob {
  const now = new Date().toISOString();
  return backgroundJobSchema.parse({
    ...data,
    id: randomUUID(),
    status: "queued",
    priority: data.priority ?? 100,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
}

export function applyBackgroundJobUpdate(
  existing: BackgroundJob,
  updates: Partial<BackgroundJob>,
): BackgroundJob {
  return backgroundJobSchema.parse({
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

// ── Social changelog ──────────────────────────────────────────────────────────

export function createSocialChangelog(
  data: Omit<SocialChangelog, "id" | "createdAt">,
): SocialChangelog {
  return socialChangelogSchema.parse({
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

export function applySocialChangelogUpdate(
  existing: SocialChangelog,
  updates: Partial<SocialChangelog>,
): SocialChangelog {
  return socialChangelogSchema.parse({
    ...existing,
    ...updates,
    // Immutable fields
    id: existing.id,
    createdAt: existing.createdAt,
  });
}

// ── Release runs ──────────────────────────────────────────────────────────────

export function createReleaseRun(
  data: Omit<ReleaseRun, "id" | "createdAt" | "updatedAt">,
): ReleaseRun {
  const now = new Date().toISOString();
  return releaseRunSchema.parse({
    ...data,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
}

export function applyReleaseRunUpdate(
  existing: ReleaseRun,
  updates: Partial<ReleaseRun>,
): ReleaseRun {
  return releaseRunSchema.parse({
    ...existing,
    ...updates,
    // Immutable fields
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

// ── CI healing ───────────────────────────────────────────────────────────────

export function createCheckSnapshot(data: Omit<CheckSnapshot, "id">): CheckSnapshot {
  return checkSnapshotSchema.parse({
    ...data,
    id: randomUUID(),
  });
}

export function createFailureFingerprint(
  data: Omit<FailureFingerprint, "id" | "createdAt">,
): FailureFingerprint {
  return failureFingerprintSchema.parse({
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

export function createHealingSession(
  data: Omit<HealingSession, "id" | "startedAt" | "updatedAt">,
): HealingSession {
  const now = new Date().toISOString();
  return healingSessionSchema.parse({
    ...data,
    id: randomUUID(),
    startedAt: now,
    updatedAt: now,
  });
}

export function applyHealingSessionUpdate(
  existing: HealingSession,
  updates: Partial<HealingSession>,
): HealingSession {
  return healingSessionSchema.parse({
    ...existing,
    ...updates,
    id: existing.id,
    startedAt: existing.startedAt,
    updatedAt: new Date().toISOString(),
  });
}

export function createHealingAttempt(
  data: Omit<HealingAttempt, "id" | "startedAt">,
): HealingAttempt {
  return healingAttemptSchema.parse({
    ...data,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
  });
}

export function applyHealingAttemptUpdate(
  existing: HealingAttempt,
  updates: Partial<HealingAttempt>,
): HealingAttempt {
  return healingAttemptSchema.parse({
    ...existing,
    ...updates,
    id: existing.id,
    sessionId: existing.sessionId,
    attemptNumber: existing.attemptNumber,
    startedAt: existing.startedAt,
  });
}

// ── Deployment healing ────────────────────────────────────────────────────────

export function createDeploymentHealingSession(
  data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">,
): DeploymentHealingSession {
  const now = new Date().toISOString();
  return deploymentHealingSessionSchema.parse({
    ...data,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
}

export function applyDeploymentHealingSessionUpdate(
  existing: DeploymentHealingSession,
  updates: Partial<DeploymentHealingSession>,
): DeploymentHealingSession {
  return deploymentHealingSessionSchema.parse({
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

// ── Config ────────────────────────────────────────────────────────────────────

export function applyConfigUpdate(existing: Config, updates: Partial<Config>): Config {
  return configSchema.parse({
    ...existing,
    ...updates,
    watchedRepos: updates.watchedRepos ?? existing.watchedRepos,
    trustedReviewers: updates.trustedReviewers ?? existing.trustedReviewers,
    ignoredBots: updates.ignoredBots ?? existing.ignoredBots,
  });
}

export function applyWatchedRepoUpdate(
  existing: WatchedRepo,
  updates: Partial<Omit<WatchedRepo, "repo">>,
): WatchedRepo {
  return watchedRepoSchema.parse({
    ...existing,
    ...updates,
    repo: existing.repo,
  });
}
