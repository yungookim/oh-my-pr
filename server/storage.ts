import type {
  AgentRun,
  AgentRunStatus,
  BackgroundJob,
  BackgroundJobKind,
  BackgroundJobStatus,
  Config,
  CheckSnapshot,
  DeploymentHealingSession,
  DeploymentHealingState,
  LogEntry,
  FailureFingerprint,
  HealingAttempt,
  HealingAttemptStatus,
  HealingSession,
  HealingSessionState,
  NewPR,
  PR,
  PRQuestion,
  ReleaseRun,
  ReleaseRunStatus,
  RuntimeState,
  SocialChangelog,
  WatchedRepo,
} from "@shared/schema";
export { MemStorage } from "./memoryStorage";
import { SqliteStorage } from "./sqliteStorage";

export interface IStorage {
  // PRs
  getPRs(): Promise<PR[]>;
  getArchivedPRs(): Promise<PR[]>;
  getPR(id: string): Promise<PR | undefined>;
  getPRByRepoAndNumber(repo: string, number: number): Promise<PR | undefined>;
  addPR(pr: NewPR): Promise<PR>;
  updatePR(id: string, updates: Partial<PR>): Promise<PR | undefined>;
  removePR(id: string): Promise<boolean>;

  // Questions
  getQuestions(prId: string): Promise<PRQuestion[]>;
  addQuestion(prId: string, question: string): Promise<PRQuestion>;
  updateQuestion(id: string, updates: Partial<PRQuestion>): Promise<PRQuestion | undefined>;

  // Logs
  getLogs(prId?: string): Promise<LogEntry[]>;
  addLog(
    prId: string,
    level: "info" | "warn" | "error",
    message: string,
    details?: {
      runId?: string | null;
      phase?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<LogEntry>;
  clearLogs(prId?: string): Promise<void>;

  // Config
  getConfig(): Promise<Config>;
  updateConfig(updates: Partial<Config>): Promise<Config>;
  listRepoSettings(): Promise<WatchedRepo[]>;
  getRepoSettings(repo: string): Promise<WatchedRepo | undefined>;
  updateRepoSettings(repo: string, updates: Partial<Omit<WatchedRepo, "repo">>): Promise<WatchedRepo>;

  // CI healing
  getHealingSession(id: string): Promise<HealingSession | undefined>;
  getHealingSessionByPrAndHead(prId: string, initialHeadSha: string): Promise<HealingSession | undefined>;
  listHealingSessions(filters?: {
    status?: HealingSessionState;
    prId?: string;
    repo?: string;
  }): Promise<HealingSession[]>;
  createHealingSession(data: Omit<HealingSession, "id" | "startedAt" | "updatedAt">): Promise<HealingSession>;
  updateHealingSession(id: string, updates: Partial<HealingSession>): Promise<HealingSession | undefined>;

  getHealingAttempt(id: string): Promise<HealingAttempt | undefined>;
  listHealingAttempts(filters?: {
    sessionId?: string;
    status?: HealingAttemptStatus;
  }): Promise<HealingAttempt[]>;
  createHealingAttempt(data: Omit<HealingAttempt, "id" | "startedAt">): Promise<HealingAttempt>;
  updateHealingAttempt(id: string, updates: Partial<HealingAttempt>): Promise<HealingAttempt | undefined>;

  listCheckSnapshots(filters?: {
    prId?: string;
    sha?: string;
  }): Promise<CheckSnapshot[]>;
  createCheckSnapshot(data: Omit<CheckSnapshot, "id">): Promise<CheckSnapshot>;

  listFailureFingerprints(filters?: {
    sessionId?: string;
    sha?: string;
  }): Promise<FailureFingerprint[]>;
  createFailureFingerprint(data: Omit<FailureFingerprint, "id" | "createdAt">): Promise<FailureFingerprint>;

  // Runtime lifecycle
  getRuntimeState(): Promise<RuntimeState>;
  updateRuntimeState(updates: Partial<RuntimeState>): Promise<RuntimeState>;

  // Background jobs
  getBackgroundJob(id: string): Promise<BackgroundJob | undefined>;
  listBackgroundJobs(filters?: {
    kind?: BackgroundJobKind;
    status?: BackgroundJobStatus;
    dedupeKey?: string;
    targetId?: string;
  }): Promise<BackgroundJob[]>;
  enqueueBackgroundJob(data: {
    kind: BackgroundJobKind;
    targetId: string;
    dedupeKey: string;
    payload?: Record<string, unknown>;
    priority?: number;
    availableAt?: string;
  }): Promise<BackgroundJob>;
  claimNextBackgroundJob(params: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
    kinds?: BackgroundJobKind[];
  }): Promise<BackgroundJob | undefined>;
  heartbeatBackgroundJob(id: string, leaseToken: string, heartbeatAt: string, leaseExpiresAt: string): Promise<BackgroundJob | undefined>;
  completeBackgroundJob(id: string, leaseToken: string, completedAt: string): Promise<BackgroundJob | undefined>;
  failBackgroundJob(id: string, leaseToken: string, error: string, completedAt: string): Promise<BackgroundJob | undefined>;
  cancelBackgroundJob(id: string, leaseToken: string, error: string | null, completedAt: string): Promise<BackgroundJob | undefined>;
  requeueExpiredBackgroundJobs(now: string): Promise<number>;

  // Social media changelogs
  getSocialChangelogs(): Promise<SocialChangelog[]>;
  getSocialChangelog(id: string): Promise<SocialChangelog | undefined>;
  getSocialChangelogForDateAndCount(date: string, triggerCount: number): Promise<SocialChangelog | undefined>;
  createSocialChangelog(data: Omit<SocialChangelog, "id" | "createdAt">): Promise<SocialChangelog>;
  updateSocialChangelog(id: string, updates: Partial<SocialChangelog>): Promise<SocialChangelog | undefined>;

  // Release runs
  getReleaseRun(id: string): Promise<ReleaseRun | undefined>;
  getReleaseRunByRepoAndMergeSha(repo: string, triggerMergeSha: string): Promise<ReleaseRun | undefined>;
  getReleaseRunByTrigger(repo: string, triggerPrNumber: number, triggerMergeSha: string): Promise<ReleaseRun | undefined>;
  listReleaseRuns(filters?: {
    status?: ReleaseRunStatus;
    repo?: string;
  }): Promise<ReleaseRun[]>;
  createReleaseRun(data: Omit<ReleaseRun, "id" | "createdAt" | "updatedAt">): Promise<ReleaseRun>;
  updateReleaseRun(id: string, updates: Partial<ReleaseRun>): Promise<ReleaseRun | undefined>;

  // Durable agent run journal
  getAgentRun(id: string): Promise<AgentRun | undefined>;
  listAgentRuns(filters?: {
    status?: AgentRunStatus;
    prId?: string;
  }): Promise<AgentRun[]>;
  upsertAgentRun(run: AgentRun): Promise<AgentRun>;

  // Deployment healing
  getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession | undefined>;
  getDeploymentHealingSessionByRepoAndMergeSha(repo: string, mergeSha: string): Promise<DeploymentHealingSession | undefined>;
  listDeploymentHealingSessions(filters?: { repo?: string; state?: DeploymentHealingState; }): Promise<DeploymentHealingSession[]>;
  createDeploymentHealingSession(data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">): Promise<DeploymentHealingSession>;
  updateDeploymentHealingSession(id: string, updates: Partial<DeploymentHealingSession>): Promise<DeploymentHealingSession | undefined>;
}

let defaultStorage: IStorage | undefined;

export function getDefaultStorage(): IStorage {
  if (!defaultStorage) {
    defaultStorage = new SqliteStorage();
  }

  return defaultStorage;
}
