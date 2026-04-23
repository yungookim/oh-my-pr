import type { Config, FeedbackItem, LogEntry, PR, PRQuestion } from "@shared/schema";
import type { TuiRuntime, TuiRuntimeSnapshot } from "./types";

type TestRuntimeState = {
  prs: PR[];
  repos: string[];
  config: Config;
  runtime: TuiRuntimeSnapshot;
  logs: Record<string, LogEntry[]>;
  questions: Record<string, PRQuestion[]>;
};

function clonePr(pr: PR): PR {
  return {
    ...pr,
    feedbackItems: pr.feedbackItems.map((item) => ({ ...item })),
  };
}

function cloneQuestion(question: PRQuestion): PRQuestion {
  return { ...question };
}

function cloneLog(log: LogEntry): LogEntry {
  return {
    ...log,
    metadata: log.metadata ? { ...log.metadata } : null,
  };
}

export class TestTuiRuntime implements TuiRuntime {
  private readonly listeners = new Set<() => void>();
  private readonly state: TestRuntimeState;

  constructor(state: TestRuntimeState) {
    this.state = state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitChange() {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  appendLog(prId: string, message: string) {
    const nextLog: LogEntry = {
      id: `log-${Math.random().toString(36).slice(2)}`,
      prId,
      runId: null,
      timestamp: new Date().toISOString(),
      level: "info",
      phase: "test",
      message,
      metadata: null,
    };
    this.state.logs[prId] = [...(this.state.logs[prId] ?? []), nextLog];
    this.emitChange();
  }

  async getRuntimeSnapshot(): Promise<TuiRuntimeSnapshot> {
    return { ...this.state.runtime };
  }

  async listPRs(): Promise<PR[]> {
    return this.state.prs.map(clonePr);
  }

  async getPR(id: string): Promise<PR | null> {
    return this.state.prs.find((pr) => pr.id === id) ? clonePr(this.state.prs.find((pr) => pr.id === id)!) : null;
  }

  async listLogs(prId?: string): Promise<LogEntry[]> {
    if (!prId) {
      return Object.values(this.state.logs).flat().map(cloneLog);
    }

    return (this.state.logs[prId] ?? []).map(cloneLog);
  }

  async listPRQuestions(prId: string): Promise<PRQuestion[]> {
    return (this.state.questions[prId] ?? []).map(cloneQuestion);
  }

  async listRepos(): Promise<string[]> {
    return [...this.state.repos];
  }

  async getConfig(): Promise<Config> {
    return { ...this.state.config };
  }

  async queueBabysit(id: string): Promise<PR> {
    this.appendLog(id, "Queued babysitter run");
    return this.getPROrThrow(id);
  }

  async setWatchEnabled(id: string, enabled: boolean): Promise<PR> {
    const pr = this.getMutablePr(id);
    pr.watchEnabled = enabled;
    this.emitChange();
    return clonePr(pr);
  }

  async setFeedbackDecision(prId: string, feedbackId: string, decision: "accept" | "reject" | "flag"): Promise<PR> {
    const pr = this.getMutablePr(prId);
    const item = pr.feedbackItems.find((feedback) => feedback.id === feedbackId);
    if (!item) {
      throw new Error("Feedback item not found");
    }

    item.decision = decision;
    item.status = decision === "accept" ? "queued" : decision === "reject" ? "rejected" : "flagged";
    this.emitChange();
    return clonePr(pr);
  }

  async retryFeedback(prId: string, feedbackId: string): Promise<PR> {
    const pr = this.getMutablePr(prId);
    const item = pr.feedbackItems.find((feedback) => feedback.id === feedbackId);
    if (!item) {
      throw new Error("Feedback item not found");
    }

    item.status = "queued";
    this.emitChange();
    return clonePr(pr);
  }

  async askQuestion(prId: string, question: string): Promise<PRQuestion> {
    const entry: PRQuestion = {
      id: `q-${Math.random().toString(36).slice(2)}`,
      prId,
      question,
      answer: null,
      status: "pending",
      error: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
    };
    this.state.questions[prId] = [...(this.state.questions[prId] ?? []), entry];
    this.emitChange();
    return cloneQuestion(entry);
  }

  async addRepo(repo: string): Promise<{ repo: string }> {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error("Invalid repository. Use the owner/repo format.");
    }

    const normalized = repo.toLowerCase();
    this.state.repos = Array.from(new Set([...this.state.repos, normalized]));
    this.state.config = {
      ...this.state.config,
      watchedRepos: Array.from(new Set([...this.state.config.watchedRepos, normalized])),
    };
    this.emitChange();
    return { repo: normalized };
  }

  async addPR(url: string): Promise<PR> {
    const next: PR = {
      id: `pr-${this.state.prs.length + 1}`,
      number: this.state.prs.length + 1,
      title: `tracked ${url}`,
      repo: "acme/new-repo",
      branch: "main",
      author: "alice",
      url,
      status: "watching",
      feedbackItems: [],
      accepted: 0,
      rejected: 0,
      flagged: 0,
      testsPassed: null,
      lintPassed: null,
      lastChecked: null,
      watchEnabled: true,
      addedAt: new Date().toISOString(),
    };
    this.state.prs = [...this.state.prs, next];
    this.emitChange();
    return clonePr(next);
  }

  async updateConfig(updates: Partial<Config>): Promise<Config> {
    this.state.config = {
      ...this.state.config,
      ...updates,
    };
    this.emitChange();
    return { ...this.state.config };
  }

  async syncRepos(): Promise<{ ok: true }> {
    this.emitChange();
    return { ok: true };
  }

  private getMutablePr(id: string): PR {
    const pr = this.state.prs.find((entry) => entry.id === id);
    if (!pr) {
      throw new Error("PR not found");
    }

    return pr;
  }

  private getPROrThrow(id: string): PR {
    return clonePr(this.getMutablePr(id));
  }
}

export function createTestRuntime(params?: Partial<TestRuntimeState>): TestTuiRuntime {
  const feedbackItem: FeedbackItem = {
    id: "feedback-1",
    author: "reviewer",
    body: "Please rename this variable for clarity.",
    bodyHtml: "<p>Please rename this variable for clarity.</p>",
    replyKind: "review_thread",
    sourceId: "source-1",
    sourceNodeId: null,
    sourceUrl: null,
    threadId: null,
    threadResolved: null,
    auditToken: "token-1",
    file: "server/app.ts",
    line: 10,
    type: "review_comment",
    createdAt: new Date().toISOString(),
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  };

  return new TestTuiRuntime({
    prs: params?.prs ?? [
      {
        id: "pr-1",
        number: 1,
        title: "feat: first pr",
        repo: "acme/widgets",
        branch: "feat/first",
        author: "alice",
        url: "https://github.com/acme/widgets/pull/1",
        status: "watching",
        feedbackItems: [feedbackItem],
        accepted: 0,
        rejected: 0,
        flagged: 0,
        testsPassed: null,
        lintPassed: null,
        lastChecked: null,
        watchEnabled: true,
        addedAt: new Date().toISOString(),
      },
      {
        id: "pr-2",
        number: 2,
        title: "fix: second pr",
        repo: "acme/widgets",
        branch: "fix/second",
        author: "bob",
        url: "https://github.com/acme/widgets/pull/2",
        status: "watching",
        feedbackItems: [],
        accepted: 0,
        rejected: 0,
        flagged: 0,
        testsPassed: null,
        lintPassed: null,
        lastChecked: null,
        watchEnabled: true,
        addedAt: new Date().toISOString(),
      },
    ],
    repos: params?.repos ?? ["acme/widgets"],
    config: params?.config ?? {
      githubTokens: [],
      codingAgent: "claude",
      maxTurns: 15,
      batchWindowMs: 300000,
      pollIntervalMs: 120000,
      maxChangesPerRun: 20,
      autoResolveMergeConflicts: true,
      autoCreateReleases: true,
      autoUpdateDocs: true,
      includeRepositoryLinksInGitHubComments: true,
      autoHealCI: false,
      maxHealingAttemptsPerSession: 3,
      maxHealingAttemptsPerFingerprint: 2,
      maxConcurrentHealingRuns: 1,
      healingCooldownMs: 300000,
      autoHealDeployments: false,
      deploymentCheckDelayMs: 60000,
      deploymentCheckTimeoutMs: 600000,
      deploymentCheckPollIntervalMs: 15000,
      watchedRepos: ["acme/widgets"],
      trustedReviewers: [],
      ignoredBots: ["dependabot[bot]"],
    },
    runtime: params?.runtime ?? {
      drainMode: false,
      drainRequestedAt: null,
      drainReason: null,
      activeRuns: 0,
    },
    logs: params?.logs ?? {
      "pr-1": [
        {
          id: "log-1",
          prId: "pr-1",
          runId: null,
          timestamp: new Date().toISOString(),
          level: "info",
          phase: "watcher",
          message: "Initial sync complete",
          metadata: null,
        },
      ],
    },
    questions: params?.questions ?? {
      "pr-1": [],
    },
  });
}
