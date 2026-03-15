import type { PR, LogEntry, Config } from "@shared/schema";
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
}

export const storage = new SqliteStorage();
