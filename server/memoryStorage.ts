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
import {
  applyConfigUpdate,
  applyPRQuestionUpdate,
  applyPRUpdate,
  applyReleaseRunUpdate,
  applySocialChangelogUpdate,
  createLogEntry,
  createPR,
  createPRQuestion,
  createReleaseRun,
  createSocialChangelog,
  touchAgentRun,
} from "@shared/models";
import type { IStorage } from "./storage";
import { DEFAULT_CONFIG } from "./defaultConfig";

export class MemStorage implements IStorage {
  private prs: Map<string, PR> = new Map();
  private questions: Map<string, PRQuestion> = new Map();
  private logs: LogEntry[] = [];
  private config: Config = { ...DEFAULT_CONFIG };
  private runtimeState: RuntimeState = {
    drainMode: false,
    drainRequestedAt: null,
    drainReason: null,
  };
  private releaseRuns: Map<string, ReleaseRun> = new Map();
  private agentRuns: Map<string, AgentRun> = new Map();
  private socialChangelogs: Map<string, SocialChangelog> = new Map();

  private cloneReleaseRun(run: ReleaseRun): ReleaseRun {
    return {
      ...run,
      includedPrs: run.includedPrs.map((pr) => ({ ...pr })),
    };
  }

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

  async addPR(pr: NewPR): Promise<PR> {
    const full = createPR(pr);
    this.prs.set(full.id, full);
    return full;
  }

  async updatePR(id: string, updates: Partial<PR>): Promise<PR | undefined> {
    const existing = this.prs.get(id);
    if (!existing) return undefined;
    const updated = applyPRUpdate(existing, updates);
    this.prs.set(id, updated);
    return updated;
  }

  async removePR(id: string): Promise<boolean> {
    return this.prs.delete(id);
  }

  async getQuestions(prId: string): Promise<PRQuestion[]> {
    return Array.from(this.questions.values())
      .filter((q) => q.prId === prId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async addQuestion(prId: string, question: string): Promise<PRQuestion> {
    const entry = createPRQuestion(prId, question);
    this.questions.set(entry.id, entry);
    return entry;
  }

  async updateQuestion(id: string, updates: Partial<PRQuestion>): Promise<PRQuestion | undefined> {
    const existing = this.questions.get(id);
    if (!existing) return undefined;
    const updated = applyPRQuestionUpdate(existing, updates);
    this.questions.set(id, updated);
    return updated;
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
    const entry = createLogEntry(prId, level, message, details);

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
    this.config = applyConfigUpdate(this.config, updates);
    return { ...this.config };
  }

  async getRuntimeState(): Promise<RuntimeState> {
    return { ...this.runtimeState };
  }

  async updateRuntimeState(updates: Partial<RuntimeState>): Promise<RuntimeState> {
    this.runtimeState = {
      ...this.runtimeState,
      ...updates,
    };

    return { ...this.runtimeState };
  }

  async getReleaseRun(id: string): Promise<ReleaseRun | undefined> {
    const run = this.releaseRuns.get(id);
    return run ? this.cloneReleaseRun(run) : undefined;
  }

  async getReleaseRunByRepoAndMergeSha(repo: string, triggerMergeSha: string): Promise<ReleaseRun | undefined> {
    const run = Array.from(this.releaseRuns.values()).find(
      (candidate) => candidate.repo === repo && candidate.triggerMergeSha === triggerMergeSha,
    );
    return run ? this.cloneReleaseRun(run) : undefined;
  }

  async getReleaseRunByTrigger(repo: string, triggerPrNumber: number, triggerMergeSha: string): Promise<ReleaseRun | undefined> {
    const run = Array.from(this.releaseRuns.values()).find(
      (candidate) =>
        candidate.repo === repo
        && candidate.triggerPrNumber === triggerPrNumber
        && candidate.triggerMergeSha === triggerMergeSha,
    );
    return run ? this.cloneReleaseRun(run) : undefined;
  }

  async listReleaseRuns(filters?: {
    status?: ReleaseRunStatus;
    repo?: string;
  }): Promise<ReleaseRun[]> {
    return Array.from(this.releaseRuns.values())
      .map((run, index) => ({ run, index }))
      .filter((run) => {
        if (filters?.status && run.run.status !== filters.status) return false;
        if (filters?.repo && run.run.repo !== filters.repo) return false;
        return true;
      })
      .sort((a, b) => {
        const createdDiff = new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime();
        if (createdDiff !== 0) {
          return createdDiff;
        }

        // If timestamps match to the same millisecond, prefer later insertion.
        return b.index - a.index;
      })
      .map(({ run }) => this.cloneReleaseRun(run));
  }

  async createReleaseRun(data: Omit<ReleaseRun, "id" | "createdAt" | "updatedAt">): Promise<ReleaseRun> {
    const entry = createReleaseRun(data);
    this.releaseRuns.set(entry.id, entry);
    return this.cloneReleaseRun(entry);
  }

  async updateReleaseRun(id: string, updates: Partial<ReleaseRun>): Promise<ReleaseRun | undefined> {
    const existing = this.releaseRuns.get(id);
    if (!existing) return undefined;
    const updated = applyReleaseRunUpdate(existing, updates);
    this.releaseRuns.set(id, updated);
    return this.cloneReleaseRun(updated);
  }

  async getAgentRun(id: string): Promise<AgentRun | undefined> {
    const run = this.agentRuns.get(id);
    return run ? { ...run } : undefined;
  }

  async listAgentRuns(filters?: { status?: AgentRunStatus; prId?: string }): Promise<AgentRun[]> {
    const runs = Array.from(this.agentRuns.values())
      .filter((run) => {
        if (filters?.status && run.status !== filters.status) return false;
        if (filters?.prId && run.prId !== filters.prId) return false;
        return true;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return runs.map((run) => ({ ...run }));
  }

  async upsertAgentRun(run: AgentRun): Promise<AgentRun> {
    const existing = this.agentRuns.get(run.id);
    const stored = existing ? touchAgentRun(existing, run) : { ...run };
    this.agentRuns.set(run.id, stored);
    return { ...stored };
  }

  async getSocialChangelogs(): Promise<SocialChangelog[]> {
    return Array.from(this.socialChangelogs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async getSocialChangelog(id: string): Promise<SocialChangelog | undefined> {
    return this.socialChangelogs.get(id);
  }

  async getSocialChangelogForDateAndCount(date: string, triggerCount: number): Promise<SocialChangelog | undefined> {
    return Array.from(this.socialChangelogs.values()).find(
      (c) => c.date === date && c.triggerCount === triggerCount,
    );
  }

  async createSocialChangelog(data: Omit<SocialChangelog, "id" | "createdAt">): Promise<SocialChangelog> {
    const entry = createSocialChangelog(data);
    this.socialChangelogs.set(entry.id, entry);
    return entry;
  }

  async updateSocialChangelog(id: string, updates: Partial<SocialChangelog>): Promise<SocialChangelog | undefined> {
    const existing = this.socialChangelogs.get(id);
    if (!existing) return undefined;
    const updated = applySocialChangelogUpdate(existing, updates);
    this.socialChangelogs.set(id, updated);
    return updated;
  }
}
