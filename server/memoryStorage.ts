import { randomUUID } from "crypto";
import type { PR, LogEntry, Config } from "@shared/schema";
import type { IStorage } from "./storage";
import { DEFAULT_CONFIG } from "./defaultConfig";

export class MemStorage implements IStorage {
  private prs: Map<string, PR> = new Map();
  private logs: LogEntry[] = [];
  private config: Config = { ...DEFAULT_CONFIG };

  async getPRs(): Promise<PR[]> {
    return Array.from(this.prs.values())
      .filter((pr) => pr.status !== "archived")
      .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
  }

  async getArchivedPRs(): Promise<PR[]> {
    return Array.from(this.prs.values())
      .filter((pr) => pr.status === "archived")
      .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
  }

  async getPR(id: string): Promise<PR | undefined> {
    return this.prs.get(id);
  }

  async getPRByRepoAndNumber(repo: string, number: number): Promise<PR | undefined> {
    return Array.from(this.prs.values()).find((pr) => pr.repo === repo && pr.number === number);
  }

  async addPR(pr: Omit<PR, "id" | "addedAt">): Promise<PR> {
    const id = randomUUID();
    const full: PR = { ...pr, id, addedAt: new Date().toISOString() };
    this.prs.set(id, full);
    return full;
  }

  async updatePR(id: string, updates: Partial<PR>): Promise<PR | undefined> {
    const existing = this.prs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates };
    this.prs.set(id, updated);
    return updated;
  }

  async removePR(id: string): Promise<boolean> {
    return this.prs.delete(id);
  }

  async getLogs(prId?: string): Promise<LogEntry[]> {
    const logs = prId ? this.logs.filter((l) => l.prId === prId) : this.logs;
    return logs.slice(-200);
  }

  async addLog(
    prId: string,
    level: "info" | "warn" | "error",
    message: string,
    details?: {
      runId?: string | null;
      phase?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<LogEntry> {
    const entry: LogEntry = {
      id: randomUUID(),
      prId,
      runId: details?.runId ?? null,
      timestamp: new Date().toISOString(),
      level,
      phase: details?.phase ?? null,
      message,
      metadata: details?.metadata ?? null,
    };

    this.logs.push(entry);
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }

    return entry;
  }

  async clearLogs(prId?: string): Promise<void> {
    if (prId) {
      this.logs = this.logs.filter((l) => l.prId !== prId);
      return;
    }

    this.logs = [];
  }

  async getConfig(): Promise<Config> {
    return { ...this.config };
  }

  async updateConfig(updates: Partial<Config>): Promise<Config> {
    this.config = { ...this.config, ...updates };
    return { ...this.config };
  }
}
