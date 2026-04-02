import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobDispatcher, CancelBackgroundJobError } from "./backgroundJobDispatcher";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 250,
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    if (await condition()) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("BackgroundJobDispatcher requeues expired leases on start and completes reclaimed jobs", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  const staleClaimTime = new Date(Date.now() - 60_000);
  const job = await queue.enqueue(
    "babysit_pr",
    "pr-1",
    "babysit_pr:pr-1",
    { prId: "pr-1" },
    { availableAt: new Date(staleClaimTime.getTime() - 60_000) },
  );
  await queue.claimNext({
    workerId: "stale-worker",
    leaseMs: 1_000,
    now: staleClaimTime,
  });

  let handled = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    handlers: {
      babysit_pr: async () => {
        handled += 1;
      },
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(() => handled === 1);
    assert.equal(await dispatcher.waitForIdle(250), true);

    const stored = await storage.getBackgroundJob(job.id);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.attemptCount, 2);
  } finally {
    dispatcher.stop();
  }
});

test("BackgroundJobDispatcher does not claim new jobs while drain mode is enabled", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  await storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-04-02T10:00:00.000Z",
    drainReason: "test",
  });

  const job = await queue.enqueue("babysit_pr", "pr-1", "babysit_pr:pr-1", { prId: "pr-1" });
  let handled = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    handlers: {
      babysit_pr: async () => {
        handled += 1;
      },
    },
  });

  try {
    await dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(handled, 0);
    assert.equal((await storage.getBackgroundJob(job.id))?.status, "queued");

    await storage.updateRuntimeState({
      drainMode: false,
      drainRequestedAt: null,
      drainReason: null,
    });
    dispatcher.wake();

    await waitForCondition(() => handled === 1);
    assert.equal(await dispatcher.waitForIdle(250), true);
    assert.equal((await storage.getBackgroundJob(job.id))?.status, "completed");
  } finally {
    dispatcher.stop();
  }
});

test("BackgroundJobDispatcher waitForIdle reflects active queue handlers", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const releaseHandler = deferred();
  const handlerStarted = deferred();

  await queue.enqueue("babysit_pr", "pr-1", "babysit_pr:pr-1", { prId: "pr-1" });

  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    handlers: {
      babysit_pr: async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
      },
    },
  });

  try {
    await dispatcher.start();
    await handlerStarted.promise;

    assert.equal(dispatcher.getActiveRunCount(), 1);
    assert.equal(await dispatcher.waitForIdle(25), false);

    releaseHandler.resolve();

    assert.equal(await dispatcher.waitForIdle(250), true);
    assert.equal(dispatcher.getActiveRunCount(), 0);
  } finally {
    releaseHandler.resolve();
    dispatcher.stop();
  }
});

test("BackgroundJobDispatcher cancels jobs when the handler raises a cancel error", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue("answer_pr_question", "question-1", "answer_pr_question:question-1", {
    prId: "missing-pr",
  });

  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    handlers: {
      answer_pr_question: async () => {
        throw new CancelBackgroundJobError("question disappeared");
      },
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(async () => (await storage.getBackgroundJob(job.id))?.status === "canceled");

    const stored = await storage.getBackgroundJob(job.id);
    assert.equal(stored?.status, "canceled");
    assert.equal(stored?.lastError, "question disappeared");
  } finally {
    dispatcher.stop();
  }
});
