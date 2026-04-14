import assert from "node:assert/strict";
import test from "node:test";
import type { NewPR } from "@shared/schema";
import { createAppRuntime } from "./appRuntime";
import { MemStorage } from "./memoryStorage";

async function seedPR(storage: MemStorage, overrides: Partial<NewPR> = {}) {
  return storage.addPR({
    number: 42,
    title: "feat: add widget",
    repo: "acme/widgets",
    branch: "feat/widget",
    author: "alice",
    url: "https://github.com/acme/widgets/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    ...overrides,
  });
}

test("runtime lists active and archived PRs separately", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  await seedPR(storage, { number: 1, title: "active pr" });
  await seedPR(storage, {
    number: 2,
    title: "archived pr",
    status: "archived",
    url: "https://github.com/acme/widgets/pull/2",
  });

  const active = await runtime.listPRs("active");
  const archived = await runtime.listPRs("archived");

  assert.equal(active.length, 1);
  assert.equal(active[0]?.title, "active pr");
  assert.equal(archived.length, 1);
  assert.equal(archived[0]?.title, "archived pr");
});

test("runtime queueBabysit enqueues a babysit job using the configured agent", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);

  const updated = await runtime.queueBabysit(pr.id);
  assert.equal(updated.id, pr.id);

  const jobs = await storage.listBackgroundJobs({
    kind: "babysit_pr",
    status: "queued",
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.targetId, pr.id);
  assert.equal(jobs[0]?.payload.preferredAgent, "claude");
});

test("runtime setWatchEnabled updates the PR and emits a change event", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);

  let changeEvents = 0;
  const unsubscribe = runtime.subscribe(() => {
    changeEvents += 1;
  });

  try {
    const updated = await runtime.setWatchEnabled(pr.id, false);
    assert.equal(updated.watchEnabled, false);
    assert.ok(changeEvents >= 1);

    const refreshed = await storage.getPR(pr.id);
    assert.equal(refreshed?.watchEnabled, false);
  } finally {
    unsubscribe();
  }
});

test("runtime askQuestion persists the question and enqueues a durable job", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);

  const question = await runtime.askQuestion(pr.id, "What changed?");

  const questions = await storage.getQuestions(pr.id);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.id, question.id);
  assert.equal(questions[0]?.status, "pending");

  const jobs = await storage.listBackgroundJobs({
    kind: "answer_pr_question",
    status: "queued",
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.targetId, question.id);
  assert.equal(jobs[0]?.payload.prId, pr.id);
});

test("runtime updateConfig persists updates and exposes them through getConfig", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  const updated = await runtime.updateConfig({
    codingAgent: "codex",
    autoUpdateDocs: false,
  });

  assert.equal(updated.codingAgent, "codex");
  assert.equal(updated.autoUpdateDocs, false);

  const config = await runtime.getConfig();
  assert.equal(config.codingAgent, "codex");
  assert.equal(config.autoUpdateDocs, false);
});
