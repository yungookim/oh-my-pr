import type {
  AgentRun,
  AgentRunStatus,
  Config,
  LogEntry,
  NewPR,
  PR,
  PRQuestion,
  ReleaseRun,
  ReleaseRunStatus,
  RuntimeState,
  SocialChangelog,
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

  // Runtime lifecycle
  getRuntimeState(): Promise<RuntimeState>;
  updateRuntimeState(updates: Partial<RuntimeState>): Promise<RuntimeState>;

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
}

export const storage = new SqliteStorage();
