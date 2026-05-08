import assert from "node:assert/strict";
import test from "node:test";
import type { NewPR } from "@shared/schema";
import { createAppRuntime, mapMergedPullsToReleaseSummaries } from "./appRuntime";
import { _resetRingBufferForTests, readRingBuffer } from "./logger";
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
  assert.equal(jobs[0]?.payload.activityLabel, "Babysitting PR #42");
  assert.equal(jobs[0]?.payload.activityDetail, "acme/widgets - feat: add widget");
  assert.equal(jobs[0]?.payload.activityTargetUrl, pr.url);
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

test("runtime setDrainMode logs enable and disable transitions", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  _resetRingBufferForTests();

  await runtime.setDrainMode({
    enabled: true,
    reason: "Agent health check failed for codex",
  });
  await runtime.setDrainMode({
    enabled: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  const ring = readRingBuffer().join("\n");
  assert.match(ring, /Drain mode enabled/);
  assert.match(ring, /Agent health check failed for codex/);
  assert.match(ring, /Drain mode disabled/);
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
  assert.equal(jobs[0]?.payload.activityLabel, "Answering question for PR #42");
  assert.equal(jobs[0]?.payload.activityDetail, "acme/widgets - feat: add widget");
  assert.equal(jobs[0]?.payload.activityTargetUrl, pr.url);
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
    includeRepositoryLinksInGitHubComments: false,
    githubCommentAppName: "Review Bot",
    postGitHubProgressReplies: true,
  });

  assert.equal(updated.codingAgent, "codex");
  assert.equal(updated.autoUpdateDocs, false);
  assert.equal(updated.includeRepositoryLinksInGitHubComments, false);
  assert.equal(updated.githubCommentAppName, "Review Bot");
  assert.equal(updated.postGitHubProgressReplies, true);

  const config = await runtime.getConfig();
  assert.equal(config.codingAgent, "codex");
  assert.equal(config.autoUpdateDocs, false);
  assert.equal(config.includeRepositoryLinksInGitHubComments, false);
  assert.equal(config.githubCommentAppName, "Review Bot");
  assert.equal(config.postGitHubProgressReplies, true);
});

test("runtime release adapter skips merged PRs without a merge commit SHA", () => {
  const summaries = mapMergedPullsToReleaseSummaries([
    {
      number: 12,
      title: "Missing merge SHA",
      url: "https://github.com/acme/widgets/pull/12",
      author: "alice",
      repo: "acme/widgets",
      mergedAt: "2026-04-26T12:00:00.000Z",
      mergeCommitSha: null,
    },
    {
      number: 13,
      title: "Real release target",
      url: "https://github.com/acme/widgets/pull/13",
      author: "bob",
      repo: "acme/widgets",
      mergedAt: "2026-04-26T13:00:00.000Z",
      mergeCommitSha: "  abc123  ",
    },
  ]);

  assert.deepEqual(summaries, [
    {
      number: 13,
      title: "Real release target",
      url: "https://github.com/acme/widgets/pull/13",
      author: "bob",
      repo: "acme/widgets",
      mergedAt: "2026-04-26T13:00:00.000Z",
      mergeSha: "abc123",
    },
  ]);
});
