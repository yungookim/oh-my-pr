import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONFIG } from "./defaultConfig";
import { getCodeFactoryPaths } from "./paths";
import { SQLITE_LOCK_TIMEOUT_MS, SqliteStorage } from "./sqliteStorage";

function createRawDatabase(root: string): DatabaseSync {
  const db = new DatabaseSync(getCodeFactoryPaths(root).stateDbPath, {
    timeout: SQLITE_LOCK_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

async function waitForStdout(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  assert.ok(child.stdout, "child stdout should be available");

  await new Promise<void>((resolve, reject) => {
    let output = "";

    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited before emitting ${expected}: code=${code} signal=${signal} output=${output}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function makeHealingSessionInput(prId: string) {
  return {
    prId,
    repo: "owner/repo",
    prNumber: 42,
    initialHeadSha: "abc123",
    currentHeadSha: "abc123",
    state: "triaging" as const,
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: null,
    attemptCount: 0,
    lastImprovementScore: null,
  };
}

test("SqliteStorage reloads config and PR state from the same root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const first = new SqliteStorage(root);
  await first.updateConfig({
    pollIntervalMs: 45000,
    autoCreateReleases: false,
    autoUpdateDocs: false,
    autoHealCI: true,
    maxHealingAttemptsPerSession: 5,
    maxHealingAttemptsPerFingerprint: 4,
    maxConcurrentHealingRuns: 2,
    healingCooldownMs: 123456,
    watchedRepos: ["alex-morgan-o/lolodex"],
  });
  await first.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-03-18T10:00:00.000Z",
    drainReason: "planned update",
  });

  const pr = await first.addPR({
    number: 106,
    title: "Example PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/test",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    watchEnabled: false,
  });
  await first.updatePR(pr.id, {
    feedbackItems: [
      {
        id: "feedback-1",
        author: "octocat",
        body: "Please fix `thing`",
        bodyHtml: "<p>Please fix <code>thing</code></p>",
        replyKind: "review_thread",
        sourceId: "101",
        sourceNodeId: "PRRC_kwDO_test",
        sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r101",
        threadId: "PRRT_kwDO_thread",
        threadResolved: false,
        auditToken: "codefactory-feedback:feedback-1",
        file: "src/app.ts",
        line: 42,
        type: "review_comment",
        createdAt: "2026-03-15T07:30:00.000Z",
        decision: "accept",
        decisionReason: "Actionable request",
        action: "Fix thing",
        status: "resolved",
        statusReason: "GitHub audit trail verified",
      },
    ],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    lastChecked: "2026-03-15T07:31:00.000Z",
    docsAssessment: {
      headSha: "abc123",
      status: "needed",
      summary: "README and configuration docs should reflect the behavior change",
      assessedAt: "2026-03-28T12:00:00.000Z",
    },
  });
  await first.addLog(pr.id, "info", "Agent started", {
    runId: "run-1",
    phase: "agent",
    metadata: { attempt: 1 },
  });
  await first.upsertAgentRun({
    id: "run-1",
    prId: pr.id,
    preferredAgent: "codex",
    resolvedAgent: "codex",
    status: "running",
    phase: "run.agent-running",
    prompt: "Fix the accepted tasks and push",
    initialHeadSha: "abc123",
    metadata: { replay: true },
    lastError: null,
    createdAt: "2026-03-18T10:01:00.000Z",
    updatedAt: "2026-03-18T10:02:00.000Z",
  });
  const releaseRun = await first.createReleaseRun({
    repo: "alex-morgan-o/lolodex",
    baseBranch: "main",
    triggerPrNumber: 106,
    triggerPrTitle: "Example PR",
    triggerPrUrl: "https://github.com/alex-morgan-o/lolodex/pull/106",
    triggerMergeSha: "merge-sha-106",
    triggerMergedAt: "2026-03-18T10:05:00.000Z",
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
  first.close();

  const second = new SqliteStorage(root);
  const config = await second.getConfig();
  const runtime = await second.getRuntimeState();
  const reloadedPr = await second.getPR(pr.id);
  const run = await second.getAgentRun("run-1");
  const runningRuns = await second.listAgentRuns({ status: "running" });
  const release = await second.getReleaseRun(releaseRun.id);
  const logs = await second.getLogs(pr.id);

  assert.equal(config.pollIntervalMs, 45000);
  assert.equal(config.autoCreateReleases, false);
  assert.equal(config.autoUpdateDocs, false);
  assert.equal(config.autoHealCI, true);
  assert.equal(config.maxHealingAttemptsPerSession, 5);
  assert.equal(config.maxHealingAttemptsPerFingerprint, 4);
  assert.equal(config.maxConcurrentHealingRuns, 2);
  assert.equal(config.healingCooldownMs, 123456);
  assert.deepEqual(config.watchedRepos, ["alex-morgan-o/lolodex"]);
  assert.equal(runtime.drainMode, true);
  assert.equal(runtime.drainRequestedAt, "2026-03-18T10:00:00.000Z");
  assert.equal(runtime.drainReason, "planned update");
  assert.equal(reloadedPr?.repo, "alex-morgan-o/lolodex");
  assert.equal(reloadedPr?.feedbackItems.length, 1);
  assert.equal(reloadedPr?.feedbackItems[0]?.bodyHtml, "<p>Please fix <code>thing</code></p>");
  assert.equal(reloadedPr?.feedbackItems[0]?.replyKind, "review_thread");
  assert.equal(reloadedPr?.feedbackItems[0]?.threadId, "PRRT_kwDO_thread");
  assert.equal(reloadedPr?.feedbackItems[0]?.auditToken, "codefactory-feedback:feedback-1");
  assert.equal(reloadedPr?.accepted, 1);
  assert.equal(reloadedPr?.watchEnabled, false);
  assert.equal(reloadedPr?.docsAssessment?.headSha, "abc123");
  assert.equal(reloadedPr?.docsAssessment?.status, "needed");
  assert.match(reloadedPr?.docsAssessment?.summary || "", /README/);
  assert.equal(reloadedPr?.feedbackItems[0]?.status, "resolved");
  assert.equal(reloadedPr?.feedbackItems[0]?.statusReason, "GitHub audit trail verified");
  assert.equal(run?.status, "running");
  assert.equal(run?.prompt, "Fix the accepted tasks and push");
  assert.equal(run?.initialHeadSha, "abc123");
  assert.equal(runningRuns.length, 1);
  assert.equal(runningRuns[0]?.id, "run-1");
  assert.equal(release?.triggerMergeSha, "merge-sha-106");
  assert.equal(release?.status, "detected");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.phase, "agent");
  assert.deepEqual(logs[0]?.metadata, { attempt: 1 });
  second.close();
});

test("SqliteStorage returns defaults when singleton rows are missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);
  const db = createRawDatabase(root);

  try {
    await storage.updateConfig({
      githubToken: "tok_123",
      autoCreateReleases: false,
      autoUpdateDocs: false,
      autoHealCI: true,
      maxHealingAttemptsPerSession: 8,
      maxHealingAttemptsPerFingerprint: 7,
      maxConcurrentHealingRuns: 3,
      healingCooldownMs: 654321,
      watchedRepos: ["alex-morgan-o/lolodex"],
      trustedReviewers: ["octocat"],
      ignoredBots: ["custom[bot]"],
    });
    await storage.updateRuntimeState({
      drainMode: true,
      drainRequestedAt: "2026-03-18T10:00:00.000Z",
      drainReason: "planned update",
    });

    db.exec("DELETE FROM config WHERE id = 1");
    db.exec("DELETE FROM runtime_state WHERE id = 1");

    const config = await storage.getConfig();
    const runtime = await storage.getRuntimeState();

    assert.deepEqual(config, {
      ...DEFAULT_CONFIG,
      watchedRepos: ["alex-morgan-o/lolodex"],
    });
    assert.deepEqual(runtime, {
      drainMode: false,
      drainRequestedAt: null,
      drainReason: null,
    });
  } finally {
    db.close();
    storage.close();
  }
});

test("SqliteStorage defaults watchEnabled to true for new PRs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);

  try {
    const pr = await storage.addPR({
      number: 107,
      title: "Watch defaults on",
      repo: "alex-morgan-o/lolodex",
      branch: "feature/default-watch",
      author: "octocat",
      url: "https://github.com/alex-morgan-o/lolodex/pull/107",
      status: "watching",
      feedbackItems: [],
      accepted: 0,
      rejected: 0,
      flagged: 0,
      testsPassed: null,
      lintPassed: null,
      lastChecked: null,
    });

    const reloaded = await storage.getPR(pr.id);
    assert.equal(pr.watchEnabled, true);
    assert.equal(reloaded?.watchEnabled, true);
  } finally {
    storage.close();
  }
});

test("SqliteStorage upsertAgentRun preserves the original createdAt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);

  const pr = await storage.addPR({
    number: 59,
    title: "Preserve createdAt",
    repo: "yungookim/oh-my-pr",
    branch: "claude/typescript-data-model-k3zAW",
    author: "claude",
    url: "https://github.com/yungookim/oh-my-pr/pull/59",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  await storage.upsertAgentRun({
    id: "run-1",
    prId: pr.id,
    preferredAgent: "claude",
    resolvedAgent: "claude",
    status: "running",
    phase: "run.agent-running",
    prompt: "Initial run",
    initialHeadSha: "abc123",
    metadata: null,
    lastError: null,
    createdAt: "2026-03-18T10:01:00.000Z",
    updatedAt: "2026-03-18T10:02:00.000Z",
  });

  const updated = await storage.upsertAgentRun({
    id: "run-1",
    prId: pr.id,
    preferredAgent: "claude",
    resolvedAgent: "claude",
    status: "completed",
    phase: "run.done",
    prompt: "Updated run",
    initialHeadSha: "def456",
    metadata: { replay: true },
    lastError: null,
    createdAt: "2026-03-19T10:01:00.000Z",
    updatedAt: "2026-03-19T10:02:00.000Z",
  });

  const fetched = await storage.getAgentRun("run-1");

  assert.equal(updated.createdAt, "2026-03-18T10:01:00.000Z");
  assert.equal(fetched?.createdAt, "2026-03-18T10:01:00.000Z");
  assert.equal(fetched?.status, "completed");
  assert.equal(fetched?.phase, "run.done");
  storage.close();
});

test("SqliteStorage persists background jobs and requeues expired leases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const first = new SqliteStorage(root);

  try {
    const lowPriority = await first.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: "pr-low",
      dedupeKey: "babysit_pr:pr-low",
      payload: { prId: "pr-low" },
      priority: 200,
      availableAt: "2026-04-02T10:00:00.000Z",
    });
    const highPriority = await first.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: "pr-high",
      dedupeKey: "babysit_pr:pr-high",
      payload: { prId: "pr-high" },
      priority: 50,
      availableAt: "2026-04-02T10:00:00.000Z",
    });
    const duplicate = await first.enqueueBackgroundJob({
      kind: "babysit_pr",
      targetId: "pr-high",
      dedupeKey: "babysit_pr:pr-high",
      payload: { prId: "pr-high", duplicate: true },
      priority: 25,
      availableAt: "2026-04-02T10:00:00.000Z",
    });

    assert.equal(duplicate.id, highPriority.id);

    const claimed = await first.claimNextBackgroundJob({
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-04-02T10:00:30.000Z",
      now: "2026-04-02T10:00:00.000Z",
    });
    assert.equal(claimed?.id, highPriority.id);
    assert.equal(claimed?.attemptCount, 1);

    const heartbeat = await first.heartbeatBackgroundJob(
      highPriority.id,
      "lease-1",
      "2026-04-02T10:00:10.000Z",
      "2026-04-02T10:00:40.000Z",
    );
    assert.equal(heartbeat?.heartbeatAt, "2026-04-02T10:00:10.000Z");
    first.close();

    const second = new SqliteStorage(root);
    try {
      const persisted = await second.getBackgroundJob(highPriority.id);
      assert.equal(persisted?.status, "leased");
      assert.equal(persisted?.leaseToken, "lease-1");

      const reclaimedCount = await second.requeueExpiredBackgroundJobs("2026-04-02T10:00:41.000Z");
      assert.equal(reclaimedCount, 1);

      const requeued = await second.getBackgroundJob(highPriority.id);
      assert.equal(requeued?.status, "queued");
      assert.equal(requeued?.leaseToken, null);

      const reclaimedClaim = await second.claimNextBackgroundJob({
        workerId: "worker-2",
        leaseToken: "lease-2",
        leaseExpiresAt: "2026-04-02T10:01:10.000Z",
        now: "2026-04-02T10:00:41.000Z",
      });
      assert.equal(reclaimedClaim?.id, highPriority.id);
      assert.equal(reclaimedClaim?.attemptCount, 2);

      const failed = await second.failBackgroundJob(
        highPriority.id,
        "lease-2",
        "boom",
        "2026-04-02T10:00:50.000Z",
      );
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.lastError, "boom");

      const cancelSource = await second.enqueueBackgroundJob({
        kind: "generate_social_changelog",
        targetId: "changelog-1",
        dedupeKey: "generate_social_changelog:changelog-1",
        payload: { changelogId: "changelog-1" },
        availableAt: "2026-04-02T10:01:00.000Z",
      });

      const cancelClaim = await second.claimNextBackgroundJob({
        workerId: "worker-3",
        leaseToken: "lease-3",
        leaseExpiresAt: "2026-04-02T10:01:40.000Z",
        now: "2026-04-02T10:01:00.000Z",
        kinds: ["generate_social_changelog"],
      });
      assert.equal(cancelClaim?.id, cancelSource.id);

      const canceled = await second.cancelBackgroundJob(
        cancelSource.id,
        "lease-3",
        "no-op",
        "2026-04-02T10:01:10.000Z",
      );
      assert.equal(canceled?.status, "canceled");

      const completedSource = await second.enqueueBackgroundJob({
        kind: "answer_pr_question",
        targetId: "question-1",
        dedupeKey: "answer_pr_question:question-1",
        payload: { questionId: "question-1" },
        availableAt: "2026-04-02T10:02:00.000Z",
      });

      const completedClaim = await second.claimNextBackgroundJob({
        workerId: "worker-4",
        leaseToken: "lease-4",
        leaseExpiresAt: "2026-04-02T10:02:40.000Z",
        now: "2026-04-02T10:02:00.000Z",
        kinds: ["answer_pr_question"],
      });
      assert.equal(completedClaim?.id, completedSource.id);

      const completed = await second.completeBackgroundJob(
        completedSource.id,
        "lease-4",
        "2026-04-02T10:02:10.000Z",
      );
      assert.equal(completed?.status, "completed");

      const failedJobs = await second.listBackgroundJobs({ status: "failed" });
      assert.equal(failedJobs.length, 1);
      assert.equal(failedJobs[0]?.id, highPriority.id);

      const queuedJobs = await second.listBackgroundJobs({ status: "queued" });
      assert.equal(queuedJobs.length, 1);
      assert.equal(queuedJobs[0]?.id, lowPriority.id);
    } finally {
      second.close();
    }
  } finally {
    // `first` may already be closed after restart simulation.
    try {
      first.close();
    } catch {
      // ignore duplicate close in tests
    }
  }
});

test("SqliteStorage release run lookup is idempotent and list is newest-first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);

  const older = await storage.createReleaseRun({
    repo: "owner/repo",
    baseBranch: "main",
    triggerPrNumber: 1,
    triggerPrTitle: "Older",
    triggerPrUrl: "https://github.com/owner/repo/pull/1",
    triggerMergeSha: "merge-sha-1",
    triggerMergedAt: "2026-03-28T10:00:00.000Z",
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

  await storage.createReleaseRun({
    repo: "owner/repo",
    baseBranch: "main",
    triggerPrNumber: 2,
    triggerPrTitle: "Newer",
    triggerPrUrl: "https://github.com/owner/repo/pull/2",
    triggerMergeSha: "merge-sha-2",
    triggerMergedAt: "2026-03-28T10:01:00.000Z",
    status: "published",
    decisionReason: "Ship it",
    recommendedBump: "minor",
    proposedVersion: "v1.1.0",
    releaseTitle: "v1.1.0",
    releaseNotes: "notes",
    includedPrs: [],
    targetSha: "abc",
    githubReleaseId: 123,
    githubReleaseUrl: "https://github.com/owner/repo/releases/tag/v1.1.0",
    error: null,
    completedAt: "2026-03-28T10:02:00.000Z",
  });

  const byRepoAndSha = await storage.getReleaseRunByRepoAndMergeSha("owner/repo", "merge-sha-1");
  assert.equal(byRepoAndSha?.id, older.id);

  const byTrigger = await storage.getReleaseRunByTrigger("owner/repo", 1, "merge-sha-1");
  assert.equal(byTrigger?.id, older.id);

  const runs = await storage.listReleaseRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.triggerPrNumber, 2);
  assert.equal(runs[1]?.triggerPrNumber, 1);
  storage.close();
});

test("SqliteStorage persists healing sessions and attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);

  const pr = await storage.addPR({
    number: 90,
    title: "Healing session PR",
    repo: "owner/repo",
    branch: "feature/healing",
    author: "octocat",
    url: "https://github.com/owner/repo/pull/90",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const session = await storage.createHealingSession(makeHealingSessionInput(pr.id));
  const attempt = await storage.createHealingAttempt({
    sessionId: session.id,
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
  });

  const updatedSession = await storage.updateHealingSession(session.id, {
    state: "awaiting_repair_slot",
    attemptCount: 1,
    latestFingerprint: "build-failure",
  });
  const updatedAttempt = await storage.updateHealingAttempt(attempt.id, {
    status: "verified",
    outputSha: "def456",
    improvementScore: 2,
  });

  assert.equal(updatedSession?.state, "awaiting_repair_slot");
  assert.equal(updatedAttempt?.status, "verified");

  storage.close();

  const reloaded = new SqliteStorage(root);
  const fetchedSession = await reloaded.getHealingSession(session.id);
  const byHead = await reloaded.getHealingSessionByPrAndHead(pr.id, "abc123");
  const sessions = await reloaded.listHealingSessions({ prId: pr.id });
  const fetchedAttempt = await reloaded.getHealingAttempt(attempt.id);
  const attempts = await reloaded.listHealingAttempts({ sessionId: session.id });

  assert.equal(fetchedSession?.state, "awaiting_repair_slot");
  assert.equal(byHead?.id, session.id);
  assert.equal(sessions.length, 1);
  assert.equal(fetchedAttempt?.status, "verified");
  assert.equal(fetchedAttempt?.outputSha, "def456");
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0]?.targetFingerprints, ["build-failure"]);
  reloaded.close();
});

test("SqliteStorage persists check snapshots and failure fingerprints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);

  const pr = await storage.addPR({
    number: 91,
    title: "Snapshot PR",
    repo: "owner/repo",
    branch: "feature/snapshots",
    author: "octocat",
    url: "https://github.com/owner/repo/pull/91",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const session = await storage.createHealingSession(makeHealingSessionInput(pr.id));
  const snapshot = await storage.createCheckSnapshot({
    prId: pr.id,
    sha: "abc123",
    provider: "github",
    context: "build",
    status: "completed",
    conclusion: "failure",
    description: "Build failed",
    targetUrl: "https://github.com/owner/repo/actions/runs/1",
    observedAt: "2026-04-01T12:00:00.000Z",
  });
  const fingerprint = await storage.createFailureFingerprint({
    sessionId: session.id,
    sha: "abc123",
    fingerprint: "build-failure",
    category: "build",
    classification: "healable_in_branch",
    summary: "Build failed in a fixable way",
    selectedEvidence: ["line 12", "line 15"],
  });

  storage.close();

  const reloaded = new SqliteStorage(root);
  const snapshots = await reloaded.listCheckSnapshots({ prId: pr.id, sha: "abc123" });
  const fingerprints = await reloaded.listFailureFingerprints({ sessionId: session.id, sha: "abc123" });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.id, snapshot.id);
  assert.equal(fingerprints.length, 1);
  assert.equal(fingerprints[0]?.id, fingerprint.id);
  assert.deepEqual(fingerprints[0]?.selectedEvidence, ["line 12", "line 15"]);
  reloaded.close();
});

test("SqliteStorage allows getPR during a concurrent write transaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);
  const writer = createRawDatabase(root);

  try {
    const pr = await storage.addPR({
      number: 88,
      title: "Readable during write lock",
      repo: "owner/repo",
      branch: "feature/read-lock",
      author: "octocat",
      url: "https://github.com/owner/repo/pull/88",
      status: "watching",
      feedbackItems: [],
      accepted: 0,
      rejected: 0,
      flagged: 0,
      testsPassed: null,
      lintPassed: null,
      lastChecked: null,
    });

    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE prs SET title = ? WHERE id = ?").run("Uncommitted title", pr.id);

    const fetched = await storage.getPR(pr.id);

    assert.equal(fetched?.id, pr.id);
    assert.equal(fetched?.title, "Readable during write lock");
  } finally {
    try {
      writer.exec("ROLLBACK");
    } catch {
      // Ignore cleanup failures if the transaction already closed.
    }
    writer.close();
    storage.close();
  }
});

test("SqliteStorage recovers after a transient database lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const storage = new SqliteStorage(root);

  try {
    const pr = await storage.addPR({
      number: 89,
      title: "Transient lock recovery",
      repo: "owner/repo",
      branch: "feature/lock-recovery",
      author: "octocat",
      url: "https://github.com/owner/repo/pull/89",
      status: "watching",
      feedbackItems: [],
      accepted: 0,
      rejected: 0,
      flagged: 0,
      testsPassed: null,
      lintPassed: null,
      lastChecked: null,
    });

    const holdMs = SQLITE_LOCK_TIMEOUT_MS + 500;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const { DatabaseSync } = require("node:sqlite");

try {
  const dbPath = process.argv[1];
  const prId = process.argv[2];
  const holdMs = Number(process.argv[3]);
  const db = new DatabaseSync(dbPath, {
    timeout: ${SQLITE_LOCK_TIMEOUT_MS},
    enableForeignKeyConstraints: true,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE prs SET title = ? WHERE id = ?").run("Locked by child", prId);
  process.stdout.write("LOCKED\\n");
  setTimeout(() => {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
      process.exit(0);
    }
  }, holdMs);
} catch (error) {
  console.error(error);
  process.exit(1);
}
        `,
        getCodeFactoryPaths(root).stateDbPath,
        pr.id,
        String(holdMs),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exitPromise = once(child, "exit");
    await waitForStdout(child, "LOCKED");

    const startedAt = Date.now();
    const updated = await storage.updatePR(pr.id, {
      status: "processing",
      lastChecked: "2026-03-24T12:00:00.000Z",
    });
    const elapsedMs = Date.now() - startedAt;

    const [exitCode, signal] = await exitPromise;

    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.equal(updated?.status, "processing");
    assert.equal(updated?.lastChecked, "2026-03-24T12:00:00.000Z");
    assert.ok(
      elapsedMs >= SQLITE_LOCK_TIMEOUT_MS,
      `expected the first write attempt to wait for the lock timeout before recovery, got ${elapsedMs}ms`,
    );
  } finally {
    storage.close();
  }
});
