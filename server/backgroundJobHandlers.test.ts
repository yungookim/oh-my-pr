import assert from "node:assert/strict";
import test from "node:test";
import { CancelBackgroundJobError } from "./backgroundJobDispatcher";
import { createBackgroundJobHandlers } from "./backgroundJobHandlers";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";

async function seedPR(storage: MemStorage): Promise<string> {
  const pr = await storage.addPR({
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
  });
  return pr.id;
}

test("answer_pr_question handler delegates for non-terminal questions", async () => {
  const storage = new MemStorage();
  const prId = await seedPR(storage);
  const question = await storage.addQuestion(prId, "What changed?");
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "answer_pr_question",
    question.id,
    `answer_pr_question:${question.id}`,
    { prId },
  );
  const calls: Array<{ prId: string; questionId: string; question: string; preferredAgent: string }> = [];

  const handlers = createBackgroundJobHandlers({
    storage,
    questionAnswerer: async (params) => {
      calls.push({
        prId: params.prId,
        questionId: params.questionId,
        question: params.question,
        preferredAgent: params.preferredAgent,
      });
    },
  });

  await handlers.answer_pr_question!(job);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    prId,
    questionId: question.id,
    question: "What changed?",
    preferredAgent: "claude",
  });
});

test("answer_pr_question handler no-ops for terminal questions", async () => {
  const storage = new MemStorage();
  const prId = await seedPR(storage);
  const question = await storage.addQuestion(prId, "What changed?");
  await storage.updateQuestion(question.id, {
    status: "answered",
    answer: "Already answered",
    answeredAt: "2026-04-02T12:00:00.000Z",
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "answer_pr_question",
    question.id,
    `answer_pr_question:${question.id}`,
    { prId },
  );
  let called = false;

  const handlers = createBackgroundJobHandlers({
    storage,
    questionAnswerer: async () => {
      called = true;
    },
  });

  await handlers.answer_pr_question!(job);

  assert.equal(called, false);
});

test("answer_pr_question handler cancels jobs whose question row is missing", async () => {
  const storage = new MemStorage();
  const handlers = createBackgroundJobHandlers({ storage });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "answer_pr_question",
    "missing-question",
    "answer_pr_question:missing-question",
    { prId: "missing-pr" },
  );

  await assert.rejects(
    handlers.answer_pr_question!(job),
    (error: unknown) => error instanceof CancelBackgroundJobError
      && error.message.includes("missing-question"),
  );
});

test("generate_social_changelog handler no-ops for terminal rows", async () => {
  const storage = new MemStorage();
  const changelog = await storage.createSocialChangelog({
    date: "2026-04-02",
    triggerCount: 5,
    prSummaries: [],
    content: "done",
    status: "done",
    error: null,
    completedAt: "2026-04-02T12:00:00.000Z",
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "generate_social_changelog",
    changelog.id,
    `generate_social_changelog:${changelog.id}`,
    {},
  );
  let called = false;

  const handlers = createBackgroundJobHandlers({
    storage,
    socialChangelogGenerator: async () => {
      called = true;
    },
  });

  await handlers.generate_social_changelog!(job);

  assert.equal(called, false);
});

test("generate_social_changelog handler cancels jobs whose row is missing", async () => {
  const storage = new MemStorage();
  const handlers = createBackgroundJobHandlers({ storage });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "generate_social_changelog",
    "missing-changelog",
    "generate_social_changelog:missing-changelog",
    {},
  );

  await assert.rejects(
    handlers.generate_social_changelog!(job),
    (error: unknown) => error instanceof CancelBackgroundJobError
      && error.message.includes("missing-changelog"),
  );
});

test("generate_social_changelog handler delegates for non-terminal rows", async () => {
  const storage = new MemStorage();
  const changelog = await storage.createSocialChangelog({
    date: "2026-04-02",
    triggerCount: 5,
    prSummaries: [{
      number: 42,
      title: "feat: add widget",
      url: "https://github.com/acme/widgets/pull/42",
      author: "alice",
      repo: "acme/widgets",
    }],
    content: null,
    status: "generating",
    error: null,
    completedAt: null,
  });
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue(
    "generate_social_changelog",
    changelog.id,
    `generate_social_changelog:${changelog.id}`,
    {},
  );
  const calls: Array<{ changelogId: string; date: string; preferredAgent: string }> = [];

  const handlers = createBackgroundJobHandlers({
    storage,
    socialChangelogGenerator: async (params) => {
      calls.push({
        changelogId: params.changelogId,
        date: params.date,
        preferredAgent: params.preferredAgent,
      });
    },
  });

  await handlers.generate_social_changelog!(job);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    changelogId: changelog.id,
    date: "2026-04-02",
    preferredAgent: "claude",
  });
});
