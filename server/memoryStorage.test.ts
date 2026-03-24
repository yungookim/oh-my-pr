import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemStorage } from "./memoryStorage";
import { DEFAULT_CONFIG } from "./defaultConfig";
import type { AgentRun, PR } from "@shared/schema";

function makePRInput(overrides: Partial<Omit<PR, "id" | "addedAt">> = {}): Omit<PR, "id" | "addedAt"> {
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

    it("sorts by addedAt descending", async () => {
      const pr1 = await storage.addPR(makePRInput({ title: "First" }));
      // Force a later addedAt on the second PR
      await storage.updatePR(pr1.id, { addedAt: "2020-01-01T00:00:00.000Z" });
      const pr2 = await storage.addPR(makePRInput({ title: "Second" }));
      await storage.updatePR(pr2.id, { addedAt: "2025-01-01T00:00:00.000Z" });

      const prs = await storage.getPRs();
      // Most recent first
      assert.equal(prs[0].title, "Second");
      assert.equal(prs[1].title, "First");
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
      assert.deepEqual(config.watchedRepos, []);
    });
  });

  describe("updateConfig", () => {
    it("merges partial updates", async () => {
      const updated = await storage.updateConfig({ maxTurns: 25 });
      assert.equal(updated.maxTurns, 25);
      // Other fields preserved
      assert.equal(updated.codingAgent, "claude");
    });

    it("returns the updated config", async () => {
      const updated = await storage.updateConfig({ githubToken: "tok_123" });
      const fetched = await storage.getConfig();
      assert.deepEqual(updated, fetched);
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
