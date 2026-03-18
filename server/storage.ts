import type { AgentRun, AgentRunStatus, Config, LogEntry, PR, PRQuestion, RuntimeState } from "@shared/schema";
export { MemStorage } from "./memoryStorage";
import { SqliteStorage } from "./sqliteStorage";

export interface IStorage {
  // PRs
  getPRs(): Promise<PR[]>;
  getArchivedPRs(): Promise<PR[]>;
  getPR(id: string): Promise<PR | undefined>;
  getPRByRepoAndNumber(repo: string, number: number): Promise<PR | undefined>;
  addPR(pr: Omit<PR, "id" | "addedAt">): Promise<PR>;
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

  // Durable agent run journal
  getAgentRun(id: string): Promise<AgentRun | undefined>;
  listAgentRuns(filters?: {
    status?: AgentRunStatus;
    prId?: string;
  }): Promise<AgentRun[]>;
  upsertAgentRun(run: AgentRun): Promise<AgentRun>;
}

export const storage = new SqliteStorage();
