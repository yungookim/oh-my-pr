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

test("SqliteStorage reloads config and PR state from the same root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const first = new SqliteStorage(root);
  await first.updateConfig({
    pollIntervalMs: 45000,
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
  first.close();

  const second = new SqliteStorage(root);
  const config = await second.getConfig();
  const runtime = await second.getRuntimeState();
  const reloadedPr = await second.getPR(pr.id);
  const run = await second.getAgentRun("run-1");
  const runningRuns = await second.listAgentRuns({ status: "running" });
  const logs = await second.getLogs(pr.id);

  assert.equal(config.pollIntervalMs, 45000);
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
  assert.equal(reloadedPr?.feedbackItems[0]?.status, "resolved");
  assert.equal(reloadedPr?.feedbackItems[0]?.statusReason, "GitHub audit trail verified");
  assert.equal(run?.status, "running");
  assert.equal(run?.prompt, "Fix the accepted tasks and push");
  assert.equal(run?.initialHeadSha, "abc123");
  assert.equal(runningRuns.length, 1);
  assert.equal(runningRuns[0]?.id, "run-1");
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
