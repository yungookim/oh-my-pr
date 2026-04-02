import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemStorage } from "./memoryStorage";
import { DEFAULT_CONFIG } from "./defaultConfig";
import type {
  AgentRun,
  CheckSnapshot,
  FailureFingerprint,
  HealingAttempt,
  HealingSession,
  NewPR,
} from "@shared/schema";

function makePRInput(overrides: Partial<NewPR> = {}): NewPR {
  return {
    number: 1,
    title: "Test PR",
    repo: "owner/repo",
    branch: "feature",
    author: "alice",
    url: "https://github.com/owner/repo/pull/1",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    ...overrides,
  };
}

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    prId: "pr-1",
    preferredAgent: "claude",
    resolvedAgent: null,
    status: "running",
    phase: "init",
    prompt: null,
    initialHeadSha: null,
    metadata: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBackgroundJobInput(overrides: Partial<{
  kind: "sync_watched_repos" | "babysit_pr" | "process_release_run" | "answer_pr_question" | "generate_social_changelog";
  targetId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  priority: number;
  availableAt: string;
}> = {}) {
  return {
    kind: "babysit_pr" as const,
    targetId: "pr-1",
    dedupeKey: "babysit_pr:pr-1",
    payload: { prId: "pr-1" },
    priority: 100,
    availableAt: "2026-04-02T10:00:00.000Z",
    ...overrides,
  };
}

function makeHealingSession(overrides: Partial<HealingSession> = {}): Omit<HealingSession, "id" | "startedAt" | "updatedAt"> {
  return {
    prId: "pr-1",
    repo: "owner/repo",
    prNumber: 1,
    initialHeadSha: "abc123",
    currentHeadSha: "abc123",
    state: "triaging",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: null,
    attemptCount: 0,
    lastImprovementScore: null,
    ...overrides,
  };
}

function makeHealingAttempt(overrides: Partial<HealingAttempt> = {}): Omit<HealingAttempt, "id" | "startedAt"> {
  return {
    sessionId: "session-1",
    attemptNumber: 1,
    inputSha: "abc123",
    outputSha: null,
    status: "queued",
    endedAt: null,
    agent: "claude",
    promptDigest: "digest",
    targetFingerprints: ["build-failure"],
    summary: null,
    improvementScore: null,
    error: null,
    ...overrides,
  };
}

function makeCheckSnapshot(overrides: Partial<CheckSnapshot> = {}): Omit<CheckSnapshot, "id"> {
  return {
    prId: "pr-1",
    sha: "abc123",
    provider: "github",
    context: "build",
    status: "completed",
    conclusion: "failure",
    description: "Build failed",
    targetUrl: "https://github.com/owner/repo/actions/runs/1",
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFailureFingerprint(overrides: Partial<FailureFingerprint> = {}): Omit<FailureFingerprint, "id" | "createdAt"> {
  return {
    sessionId: "session-1",
    sha: "abc123",
    fingerprint: "build-failure",
    category: "build",
    classification: "healable_in_branch",
    summary: "Build error can be fixed in branch",
    selectedEvidence: ["line 12"],
    ...overrides,
  };
}

describe("MemStorage", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  // ── PR CRUD ──────────────────────────────────────────────

  describe("addPR", () => {
    it("returns a PR with generated id and addedAt", async () => {
      const pr = await storage.addPR(makePRInput());
      assert.ok(pr.id, "should have an id");
      assert.ok(pr.addedAt, "should have addedAt");
      assert.equal(pr.title, "Test PR");
      assert.equal(pr.status, "watching");
      assert.equal(pr.watchEnabled, true);
    });
  });

  describe("getPR", () => {
    it("returns the PR by id", async () => {
      const pr = await storage.addPR(makePRInput());
      const found = await storage.getPR(pr.id);
      assert.deepEqual(found, pr);
    });

    it("returns undefined for nonexistent id", async () => {
      const found = await storage.getPR("nonexistent");
      assert.equal(found, undefined);
    });
  });

  describe("getPRs", () => {
    it("excludes archived PRs", async () => {
      await storage.addPR(makePRInput({ title: "Active" }));
      await storage.addPR(makePRInput({ title: "Archived", status: "archived" }));

      const prs = await storage.getPRs();
      assert.equal(prs.length, 1);
      assert.equal(prs[0].title, "Active");
    });

    it("sorts by addedAt descending", async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: new Date("2024-01-01T00:00:00.000Z") });

      await storage.addPR(makePRInput({ title: "First" }));
      t.mock.timers.tick(100);
      await storage.addPR(makePRInput({ title: "Second" }));

      const prs = await storage.getPRs();
      // Most recent first
      assert.equal(prs[0].title, "Second");
      assert.equal(prs[1].title, "First");
      assert.ok(new Date(prs[0].addedAt).getTime() > new Date(prs[1].addedAt).getTime());
    });
  });

  describe("getArchivedPRs", () => {
    it("returns only archived PRs", async () => {
      await storage.addPR(makePRInput({ title: "Active" }));
      await storage.addPR(makePRInput({ title: "Archived", status: "archived" }));

      const archived = await storage.getArchivedPRs();
      assert.equal(archived.length, 1);
      assert.equal(archived[0].title, "Archived");
    });
  });

  describe("getPRByRepoAndNumber", () => {
    it("finds by repo and number combo", async () => {
      await storage.addPR(makePRInput({ repo: "owner/repo", number: 42 }));
      await storage.addPR(makePRInput({ repo: "owner/other", number: 42 }));

      const found = await storage.getPRByRepoAndNumber("owner/repo", 42);
      assert.ok(found);
      assert.equal(found.repo, "owner/repo");
      assert.equal(found.number, 42);
    });

    it("returns undefined when not found", async () => {
      const found = await storage.getPRByRepoAndNumber("nope/nope", 999);
      assert.equal(found, undefined);
    });
  });

  describe("updatePR", () => {
    it("merges updates and preserves id and addedAt", async () => {
      const pr = await storage.addPR(makePRInput());
      const updated = await storage.updatePR(pr.id, { title: "Updated", status: "processing" });

      assert.ok(updated);
      assert.equal(updated.id, pr.id);
      assert.equal(updated.addedAt, pr.addedAt);
      assert.equal(updated.title, "Updated");
      assert.equal(updated.status, "processing");
    });

    it("returns undefined for nonexistent PR", async () => {
      const result = await storage.updatePR("nonexistent", { title: "nope" });
      assert.equal(result, undefined);
    });
  });

  describe("removePR", () => {
    it("removes an existing PR and returns true", async () => {
      const pr = await storage.addPR(makePRInput());
      const removed = await storage.removePR(pr.id);
      assert.equal(removed, true);

      const found = await storage.getPR(pr.id);
      assert.equal(found, undefined);
    });

    it("returns false for nonexistent PR", async () => {
      const removed = await storage.removePR("nonexistent");
      assert.equal(removed, false);
    });
  });

  // ── Questions CRUD ───────────────────────────────────────

  describe("addQuestion", () => {
    it("creates with pending status and generated fields", async () => {
      const q = await storage.addQuestion("pr-1", "What does this do?");
      assert.ok(q.id);
      assert.equal(q.prId, "pr-1");
      assert.equal(q.question, "What does this do?");
      assert.equal(q.status, "pending");
      assert.equal(q.answer, null);
      assert.equal(q.error, null);
      assert.ok(q.createdAt);
      assert.equal(q.answeredAt, null);
    });
  });

  describe("getQuestions", () => {
    it("filters by prId", async () => {
      await storage.addQuestion("pr-1", "Q1");
      await storage.addQuestion("pr-2", "Q2");

      const questions = await storage.getQuestions("pr-1");
      assert.equal(questions.length, 1);
      assert.equal(questions[0].question, "Q1");
    });

    it("sorts by createdAt ascending", async () => {
      await storage.addQuestion("pr-1", "First");
      await storage.addQuestion("pr-1", "Second");

      const questions = await storage.getQuestions("pr-1");
      assert.equal(questions[0].question, "First");
      assert.equal(questions[1].question, "Second");
    });
  });

  describe("updateQuestion", () => {
    it("preserves immutable fields (id, prId, createdAt)", async () => {
      const q = await storage.addQuestion("pr-1", "Question?");
      const updated = await storage.updateQuestion(q.id, {
        id: "hacked-id",
        prId: "hacked-pr",
        createdAt: "1999-01-01T00:00:00.000Z",
        status: "answered",
        answer: "The answer",
      } as unknown as Parameters<typeof storage.updateQuestion>[1]);

      assert.ok(updated);
      assert.equal(updated.id, q.id);
      assert.equal(updated.prId, q.prId);
      assert.equal(updated.createdAt, q.createdAt);
      assert.equal(updated.status, "answered");
      assert.equal(updated.answer, "The answer");
    });

    it("returns undefined for nonexistent id", async () => {
      const result = await storage.updateQuestion("nonexistent", { status: "answered" });
      assert.equal(result, undefined);
    });
  });

  // ── Logs ─────────────────────────────────────────────────

  describe("addLog", () => {
    it("creates entry with generated id and timestamp", async () => {
      const log = await storage.addLog("pr-1", "info", "Test message");
      assert.ok(log.id);
      assert.ok(log.timestamp);
      assert.equal(log.prId, "pr-1");
      assert.equal(log.level, "info");
      assert.equal(log.message, "Test message");
      assert.equal(log.runId, null);
      assert.equal(log.phase, null);
      assert.equal(log.metadata, null);
    });

    it("stores optional details", async () => {
      const log = await storage.addLog("pr-1", "warn", "msg", {
        runId: "run-1",
        phase: "triage",
        metadata: { key: "value" },
      });
      assert.equal(log.runId, "run-1");
      assert.equal(log.phase, "triage");
      assert.deepEqual(log.metadata, { key: "value" });
    });
  });

  describe("getLogs", () => {
    it("filters by prId when provided", async () => {
      await storage.addLog("pr-1", "info", "Log 1");
      await storage.addLog("pr-2", "info", "Log 2");

      const logs = await storage.getLogs("pr-1");
      assert.equal(logs.length, 1);
      assert.equal(logs[0].message, "Log 1");
    });

    it("returns all logs when no prId", async () => {
      await storage.addLog("pr-1", "info", "Log 1");
      await storage.addLog("pr-2", "info", "Log 2");

      const logs = await storage.getLogs();
      assert.equal(logs.length, 2);
    });

    it("returns last 200 entries at most", async () => {
      for (let i = 0; i < 250; i++) {
        await storage.addLog("pr-1", "info", `Log ${i}`);
      }
      const logs = await storage.getLogs();
      assert.equal(logs.length, 200);
      // Should be the last 200
      assert.equal(logs[0].message, "Log 50");
      assert.equal(logs[199].message, "Log 249");
    });
  });

  describe("clearLogs", () => {
    it("clears only the specified PR's logs", async () => {
      await storage.addLog("pr-1", "info", "Log 1");
      await storage.addLog("pr-2", "info", "Log 2");

      await storage.clearLogs("pr-1");

      const logs1 = await storage.getLogs("pr-1");
      assert.equal(logs1.length, 0);

      const logs2 = await storage.getLogs("pr-2");
      assert.equal(logs2.length, 1);
    });

    it("clears all logs when no prId", async () => {
      await storage.addLog("pr-1", "info", "Log 1");
      await storage.addLog("pr-2", "info", "Log 2");

      await storage.clearLogs();

      const logs = await storage.getLogs();
      assert.equal(logs.length, 0);
    });
  });

  describe("log trimming", () => {
    it("trims to last 500 when logs exceed 1000", async () => {
      // Add 1001 logs to trigger the trim
      for (let i = 0; i < 1001; i++) {
        await storage.addLog("pr-1", "info", `Log ${i}`);
      }
      // After adding 1001 entries, it should have trimmed to 500.
      // getLogs returns last 200 of those 500.
      const logs = await storage.getLogs();
      assert.equal(logs.length, 200);
      // The trimmed array keeps the last 500 of 1001 entries (indices 501..1000).
      // getLogs returns the last 200 of those => indices 801..1000 => messages "Log 801".."Log 1000"
      assert.equal(logs[0].message, "Log 801");
      assert.equal(logs[199].message, "Log 1000");
    });
  });

  // ── Config ───────────────────────────────────────────────

  describe("getConfig", () => {
    it("returns default config initially", async () => {
      const config = await storage.getConfig();
      assert.equal(config.codingAgent, DEFAULT_CONFIG.codingAgent);
      assert.equal(config.maxTurns, DEFAULT_CONFIG.maxTurns);
      assert.equal(config.autoCreateReleases, DEFAULT_CONFIG.autoCreateReleases);
      assert.equal(config.autoUpdateDocs, DEFAULT_CONFIG.autoUpdateDocs);
      assert.equal(config.autoHealCI, DEFAULT_CONFIG.autoHealCI);
      assert.equal(config.maxHealingAttemptsPerSession, DEFAULT_CONFIG.maxHealingAttemptsPerSession);
      assert.equal(config.maxHealingAttemptsPerFingerprint, DEFAULT_CONFIG.maxHealingAttemptsPerFingerprint);
      assert.equal(config.maxConcurrentHealingRuns, DEFAULT_CONFIG.maxConcurrentHealingRuns);
      assert.equal(config.healingCooldownMs, DEFAULT_CONFIG.healingCooldownMs);
      assert.deepEqual(config.watchedRepos, []);
    });
  });

  describe("updateConfig", () => {
    it("merges partial updates", async () => {
      const updated = await storage.updateConfig({ maxTurns: 25 });
      assert.equal(updated.maxTurns, 25);
      // Other fields preserved
      assert.equal(updated.codingAgent, "claude");
      assert.equal(updated.autoUpdateDocs, true);
      assert.equal(updated.autoCreateReleases, true);
      assert.equal(updated.autoHealCI, false);
      assert.equal(updated.maxHealingAttemptsPerSession, 3);
    });

    it("returns the updated config", async () => {
      const updated = await storage.updateConfig({
        githubToken: "tok_123",
        autoHealCI: true,
        maxHealingAttemptsPerSession: 5,
        maxHealingAttemptsPerFingerprint: 4,
        maxConcurrentHealingRuns: 2,
        healingCooldownMs: 123456,
      });
      const fetched = await storage.getConfig();
      assert.deepEqual(updated, fetched);
    });
  });

  // ── Background jobs ─────────────────────────────────────

  describe("background jobs", () => {
    it("dedupes active jobs by dedupe key", async () => {
      const first = await storage.enqueueBackgroundJob(makeBackgroundJobInput());
      const second = await storage.enqueueBackgroundJob(makeBackgroundJobInput({
        payload: { prId: "pr-1", duplicate: true },
      }));

      assert.equal(first.id, second.id);
      assert.equal(second.status, "queued");

      const jobs = await storage.listBackgroundJobs({ dedupeKey: "babysit_pr:pr-1" });
      assert.equal(jobs.length, 1);
    });

    it("claims by priority, heartbeats, requeues expired leases, and fails jobs", async () => {
      const lowPriority = await storage.enqueueBackgroundJob(makeBackgroundJobInput({
        targetId: "pr-low",
        dedupeKey: "babysit_pr:pr-low",
        priority: 200,
        payload: { prId: "pr-low" },
      }));
      const highPriority = await storage.enqueueBackgroundJob(makeBackgroundJobInput({
        targetId: "pr-high",
        dedupeKey: "babysit_pr:pr-high",
        priority: 50,
        payload: { prId: "pr-high" },
      }));

      const claimed = await storage.claimNextBackgroundJob({
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseExpiresAt: "2026-04-02T10:00:30.000Z",
        now: "2026-04-02T10:00:00.000Z",
      });

      assert.equal(claimed?.id, highPriority.id);
      assert.equal(claimed?.status, "leased");
      assert.equal(claimed?.attemptCount, 1);

      const heartbeat = await storage.heartbeatBackgroundJob(
        highPriority.id,
        "lease-1",
        "2026-04-02T10:00:10.000Z",
        "2026-04-02T10:00:40.000Z",
      );
      assert.equal(heartbeat?.heartbeatAt, "2026-04-02T10:00:10.000Z");
      assert.equal(heartbeat?.leaseExpiresAt, "2026-04-02T10:00:40.000Z");

      const wrongLease = await storage.completeBackgroundJob(
        highPriority.id,
        "wrong-lease",
        "2026-04-02T10:00:20.000Z",
      );
      assert.equal(wrongLease, undefined);

      const reclaimed = await storage.requeueExpiredBackgroundJobs("2026-04-02T10:00:41.000Z");
      assert.equal(reclaimed, 1);

      const requeued = await storage.getBackgroundJob(highPriority.id);
      assert.equal(requeued?.status, "queued");
      assert.equal(requeued?.leaseToken, null);

      const reclaimedClaim = await storage.claimNextBackgroundJob({
        workerId: "worker-2",
        leaseToken: "lease-2",
        leaseExpiresAt: "2026-04-02T10:01:10.000Z",
        now: "2026-04-02T10:00:41.000Z",
      });
      assert.equal(reclaimedClaim?.id, highPriority.id);
      assert.equal(reclaimedClaim?.attemptCount, 2);

      const failed = await storage.failBackgroundJob(
        highPriority.id,
        "lease-2",
        "boom",
        "2026-04-02T10:00:50.000Z",
      );
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.lastError, "boom");

      const failedJobs = await storage.listBackgroundJobs({ status: "failed" });
      assert.equal(failedJobs.length, 1);
      assert.equal(failedJobs[0]?.id, highPriority.id);

      const queuedJobs = await storage.listBackgroundJobs({ status: "queued" });
      assert.equal(queuedJobs.length, 1);
      assert.equal(queuedJobs[0]?.id, lowPriority.id);
    });

    it("completes and cancels leased jobs with the matching lease token", async () => {
      const completeJob = await storage.enqueueBackgroundJob(makeBackgroundJobInput({
        targetId: "question-1",
        dedupeKey: "answer_pr_question:question-1",
        kind: "answer_pr_question",
        payload: { questionId: "question-1" },
      }));

      await storage.claimNextBackgroundJob({
        workerId: "worker-1",
        leaseToken: "lease-complete",
        leaseExpiresAt: "2026-04-02T10:00:30.000Z",
        now: "2026-04-02T10:00:00.000Z",
        kinds: ["answer_pr_question"],
      });

      const completed = await storage.completeBackgroundJob(
        completeJob.id,
        "lease-complete",
        "2026-04-02T10:00:15.000Z",
      );
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.completedAt, "2026-04-02T10:00:15.000Z");

      const cancelJob = await storage.enqueueBackgroundJob(makeBackgroundJobInput({
        targetId: "changelog-1",
        dedupeKey: "generate_social_changelog:changelog-1",
        kind: "generate_social_changelog",
        payload: { changelogId: "changelog-1" },
      }));

      await storage.claimNextBackgroundJob({
        workerId: "worker-2",
        leaseToken: "lease-cancel",
        leaseExpiresAt: "2026-04-02T10:01:30.000Z",
        now: "2026-04-02T10:01:00.000Z",
        kinds: ["generate_social_changelog"],
      });

      const canceled = await storage.cancelBackgroundJob(
        cancelJob.id,
        "lease-cancel",
        "no-op",
        "2026-04-02T10:01:15.000Z",
      );
      assert.equal(canceled?.status, "canceled");
      assert.equal(canceled?.lastError, "no-op");
    });
  });

  // ── CI healing ──────────────────────────────────────────

  describe("healing sessions", () => {
    it("creates, fetches, updates, and lists sessions", async () => {
      const created = await storage.createHealingSession(makeHealingSession());
      assert.ok(created.id);
      assert.equal(created.state, "triaging");

      const fetched = await storage.getHealingSession(created.id);
      assert.deepEqual(fetched, created);
      assert.notEqual(fetched, created);

      const byHead = await storage.getHealingSessionByPrAndHead(created.prId, created.initialHeadSha);
      assert.equal(byHead?.id, created.id);

      const updated = await storage.updateHealingSession(created.id, {
        state: "awaiting_repair_slot",
        attemptCount: 1,
        latestFingerprint: "build-failure",
      });
      assert.equal(updated?.state, "awaiting_repair_slot");
      assert.equal(updated?.attemptCount, 1);
      assert.equal(updated?.latestFingerprint, "build-failure");

      const sessions = await storage.listHealingSessions({ prId: created.prId });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.id, created.id);
    });
  });

  describe("healing attempts", () => {
    it("creates, fetches, updates, and lists attempts", async () => {
      const session = await storage.createHealingSession(makeHealingSession());
      const created = await storage.createHealingAttempt({
        ...makeHealingAttempt({ sessionId: session.id }),
        sessionId: session.id,
      });
      assert.ok(created.id);
      assert.equal(created.status, "queued");

      const fetched = await storage.getHealingAttempt(created.id);
      assert.deepEqual(fetched, created);
      assert.notEqual(fetched, created);

      const updated = await storage.updateHealingAttempt(created.id, {
        status: "verified",
        outputSha: "def456",
        improvementScore: 2,
      });
      assert.equal(updated?.status, "verified");
      assert.equal(updated?.outputSha, "def456");
      assert.equal(updated?.improvementScore, 2);

      const attempts = await storage.listHealingAttempts({ sessionId: session.id });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.id, created.id);
    });
  });

  describe("check snapshots", () => {
    it("creates and lists check snapshots", async () => {
      const snapshot = await storage.createCheckSnapshot(makeCheckSnapshot());
      assert.ok(snapshot.id);
      assert.equal(snapshot.status, "completed");

      const snapshots = await storage.listCheckSnapshots({ prId: snapshot.prId, sha: snapshot.sha });
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]?.id, snapshot.id);
      assert.notEqual(snapshots[0], snapshot);
    });
  });

  describe("failure fingerprints", () => {
    it("creates and lists failure fingerprints", async () => {
      const session = await storage.createHealingSession(makeHealingSession());
      const fingerprint = await storage.createFailureFingerprint({
        ...makeFailureFingerprint({ sessionId: session.id }),
        sessionId: session.id,
      });
      assert.ok(fingerprint.id);
      assert.equal(fingerprint.classification, "healable_in_branch");

      const fingerprints = await storage.listFailureFingerprints({ sessionId: session.id, sha: fingerprint.sha });
      assert.equal(fingerprints.length, 1);
      assert.equal(fingerprints[0]?.id, fingerprint.id);
      assert.notEqual(fingerprints[0], fingerprint);
    });
  });

  // ── ReleaseRuns ─────────────────────────────────────────

  describe("createReleaseRun/getReleaseRun", () => {
    it("creates a release run and looks it up by id", async () => {
      const run = await storage.createReleaseRun({
        repo: "owner/repo",
        baseBranch: "main",
        triggerPrNumber: 42,
        triggerPrTitle: "Ship feature",
        triggerPrUrl: "https://github.com/owner/repo/pull/42",
        triggerMergeSha: "abc123",
        triggerMergedAt: "2026-03-28T12:00:00.000Z",
        status: "detected",
        decisionReason: null,
        recommendedBump: null,
        proposedVersion: null,
        releaseTitle: null,
        releaseNotes: null,
        includedPrs: [],
        targetSha: null,
        githubReleaseId: null,
        githubReleaseUrl: null,
        error: null,
        completedAt: null,
      });

      const fetched = await storage.getReleaseRun(run.id);
      assert.ok(fetched);
      assert.equal(fetched.id, run.id);
      assert.equal(fetched.repo, "owner/repo");
    });

    it("updates an existing release run", async () => {
      const run = await storage.createReleaseRun({
        repo: "owner/repo",
        baseBranch: "main",
        triggerPrNumber: 43,
        triggerPrTitle: "Update status",
        triggerPrUrl: "https://github.com/owner/repo/pull/43",
        triggerMergeSha: "merge-sha-43",
        triggerMergedAt: "2026-03-28T12:00:00.000Z",
        status: "detected",
        decisionReason: null,
        recommendedBump: null,
        proposedVersion: null,
        releaseTitle: null,
        releaseNotes: null,
        includedPrs: [],
        targetSha: null,
        githubReleaseId: null,
        githubReleaseUrl: null,
        error: null,
        completedAt: null,
      });

      const updated = await storage.updateReleaseRun(run.id, {
        status: "published",
        recommendedBump: "patch",
        proposedVersion: "v1.0.1",
        completedAt: "2026-03-28T12:10:00.000Z",
      });

      assert.equal(updated?.status, "published");
      assert.equal(updated?.proposedVersion, "v1.0.1");
      assert.equal(updated?.completedAt, "2026-03-28T12:10:00.000Z");
    });
  });

  describe("release run idempotent lookups", () => {
    it("looks up by repo + triggerMergeSha", async () => {
      const run = await storage.createReleaseRun({
        repo: "owner/repo",
        baseBranch: "main",
        triggerPrNumber: 8,
        triggerPrTitle: "Test",
        triggerPrUrl: "https://github.com/owner/repo/pull/8",
        triggerMergeSha: "merge-sha-8",
        triggerMergedAt: "2026-03-28T12:00:00.000Z",
        status: "detected",
        decisionReason: null,
        recommendedBump: null,
        proposedVersion: null,
        releaseTitle: null,
        releaseNotes: null,
        includedPrs: [],
        targetSha: null,
        githubReleaseId: null,
        githubReleaseUrl: null,
        error: null,
        completedAt: null,
      });

      const found = await storage.getReleaseRunByRepoAndMergeSha("owner/repo", "merge-sha-8");
      assert.equal(found?.id, run.id);
    });

    it("looks up by repo + triggerPrNumber + triggerMergeSha", async () => {
      const run = await storage.createReleaseRun({
        repo: "owner/repo",
        baseBranch: "main",
        triggerPrNumber: 9,
        triggerPrTitle: "Test two",
        triggerPrUrl: "https://github.com/owner/repo/pull/9",
        triggerMergeSha: "merge-sha-9",
        triggerMergedAt: "2026-03-28T12:00:00.000Z",
        status: "detected",
        decisionReason: null,
        recommendedBump: null,
        proposedVersion: null,
        releaseTitle: null,
        releaseNotes: null,
        includedPrs: [],
        targetSha: null,
        githubReleaseId: null,
        githubReleaseUrl: null,
        error: null,
        completedAt: null,
      });

      const found = await storage.getReleaseRunByTrigger("owner/repo", 9, "merge-sha-9");
      assert.equal(found?.id, run.id);
    });
  });

  describe("listReleaseRuns", () => {
    it("returns newest-first", async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-03-28T12:00:00.000Z") });

      await storage.createReleaseRun({
        repo: "owner/repo",
        baseBranch: "main",
        triggerPrNumber: 10,
        triggerPrTitle: "Older",
        triggerPrUrl: "https://github.com/owner/repo/pull/10",
        triggerMergeSha: "sha-10",
        triggerMergedAt: "2026-03-28T12:00:00.000Z",
        status: "detected",
        decisionReason: null,
        recommendedBump: null,
        proposedVersion: null,
        releaseTitle: null,
        releaseNotes: null,
        includedPrs: [],
        targetSha: null,
        githubReleaseId: null,
        githubReleaseUrl: null,
        error: null,
        completedAt: null,
      });

      t.mock.timers.tick(100);

      await storage.createReleaseRun({
        repo: "owner/repo",
        baseBranch: "main",
        triggerPrNumber: 11,
        triggerPrTitle: "Newer",
        triggerPrUrl: "https://github.com/owner/repo/pull/11",
        triggerMergeSha: "sha-11",
        triggerMergedAt: "2026-03-28T12:01:00.000Z",
        status: "published",
        decisionReason: "release-worthy",
        recommendedBump: "minor",
        proposedVersion: "v1.2.0",
        releaseTitle: "Release v1.2.0",
        releaseNotes: "Notes",
        includedPrs: [],
        targetSha: "target",
        githubReleaseId: 1,
        githubReleaseUrl: "https://github.com/owner/repo/releases/tag/v1.2.0",
        error: null,
        completedAt: "2026-03-28T12:01:00.000Z",
      });

      const runs = await storage.listReleaseRuns();
      assert.equal(runs.length, 2);
      assert.equal(runs[0].triggerPrNumber, 11);
      assert.equal(runs[1].triggerPrNumber, 10);
    });
  });

  // ── RuntimeState ─────────────────────────────────────────

  describe("getRuntimeState", () => {
    it("has drainMode false by default", async () => {
      const state = await storage.getRuntimeState();
      assert.equal(state.drainMode, false);
      assert.equal(state.drainRequestedAt, null);
      assert.equal(state.drainReason, null);
    });
  });

  describe("updateRuntimeState", () => {
    it("merges updates", async () => {
      const now = new Date().toISOString();
      const updated = await storage.updateRuntimeState({
        drainMode: true,
        drainRequestedAt: now,
        drainReason: "maintenance",
      });
      assert.equal(updated.drainMode, true);
      assert.equal(updated.drainRequestedAt, now);
      assert.equal(updated.drainReason, "maintenance");
    });

    it("preserves fields not in the update", async () => {
      await storage.updateRuntimeState({ drainMode: true });
      const updated = await storage.updateRuntimeState({ drainReason: "test" });
      assert.equal(updated.drainMode, true);
      assert.equal(updated.drainReason, "test");
    });
  });

  // ── AgentRuns ────────────────────────────────────────────

  describe("upsertAgentRun", () => {
    it("stores and returns a copy", async () => {
      const run = makeAgentRun();
      const result = await storage.upsertAgentRun(run);

      assert.deepEqual(result, run);
      // Verify it's a copy, not the same reference
      assert.notEqual(result, run);
    });

    it("updates an existing run", async () => {
      const run = makeAgentRun();
      await storage.upsertAgentRun(run);

      const updated = { ...run, status: "completed" as const, phase: "done" };
      const result = await storage.upsertAgentRun(updated);
      assert.equal(result.status, "completed");

      const fetched = await storage.getAgentRun(run.id);
      assert.equal(fetched?.status, "completed");
    });
  });

  describe("getAgentRun", () => {
    it("returns undefined for nonexistent id", async () => {
      const result = await storage.getAgentRun("nonexistent");
      assert.equal(result, undefined);
    });

    it("returns a copy (not the stored reference)", async () => {
      const run = makeAgentRun();
      await storage.upsertAgentRun(run);

      const a = await storage.getAgentRun(run.id);
      const b = await storage.getAgentRun(run.id);
      assert.ok(a);
      assert.ok(b);
      assert.deepEqual(a, b);
      assert.notEqual(a, b);
    });
  });

  describe("listAgentRuns", () => {
    it("filters by status", async () => {
      await storage.upsertAgentRun(makeAgentRun({ id: "r1", status: "running" }));
      await storage.upsertAgentRun(makeAgentRun({ id: "r2", status: "completed" }));
      await storage.upsertAgentRun(makeAgentRun({ id: "r3", status: "failed" }));

      const running = await storage.listAgentRuns({ status: "running" });
      assert.equal(running.length, 1);
      assert.equal(running[0].id, "r1");
    });

    it("filters by prId", async () => {
      await storage.upsertAgentRun(makeAgentRun({ id: "r1", prId: "pr-1" }));
      await storage.upsertAgentRun(makeAgentRun({ id: "r2", prId: "pr-2" }));

      const runs = await storage.listAgentRuns({ prId: "pr-1" });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].prId, "pr-1");
    });

    it("returns copies (not references)", async () => {
      await storage.upsertAgentRun(makeAgentRun({ id: "r1" }));

      const list1 = await storage.listAgentRuns();
      const list2 = await storage.listAgentRuns();
      assert.deepEqual(list1, list2);
      assert.notEqual(list1[0], list2[0]);
    });

    it("returns all runs when no filters", async () => {
      await storage.upsertAgentRun(makeAgentRun({ id: "r1" }));
      await storage.upsertAgentRun(makeAgentRun({ id: "r2" }));

      const runs = await storage.listAgentRuns();
      assert.equal(runs.length, 2);
    });
  });
});
