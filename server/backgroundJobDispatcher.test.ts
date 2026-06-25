import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobDispatcher, CancelBackgroundJobError, TerminalBackgroundJobError } from "./backgroundJobDispatcher";
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
  const reclaimedTargets: string[] = [];
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
    onReclaimedJobs: (jobs) => {
      reclaimedTargets.push(...jobs.map((reclaimed) => reclaimed.targetId));
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(() => handled === 1);
    assert.equal(await dispatcher.waitForIdle(250), true);

    const stored = await storage.getBackgroundJob(job.id);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.attemptCount, 2);
    assert.deepEqual(reclaimedTargets, ["pr-1"]);
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

test("BackgroundJobDispatcher claims sync_watched_repos but not babysit_pr while drain mode is enabled", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  await storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-05-02T10:00:00.000Z",
    drainReason: "maintenance",
  });

  const babysitJob = await queue.enqueue("babysit_pr", "pr-1", "babysit_pr:pr-1", { prId: "pr-1" });
  const syncJob = await queue.enqueue("sync_watched_repos", "runtime:1", "sync_watched_repos", {});
  let babysitHandled = 0;
  let syncHandled = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    handlers: {
      babysit_pr: async () => {
        babysitHandled += 1;
      },
      sync_watched_repos: async () => {
        syncHandled += 1;
      },
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(() => syncHandled === 1);
    assert.equal(await dispatcher.waitForIdle(250), true);

    assert.equal(syncHandled, 1);
    assert.equal(babysitHandled, 0);
    assert.equal((await storage.getBackgroundJob(syncJob.id))?.status, "completed");
    assert.equal((await storage.getBackgroundJob(babysitJob.id))?.status, "queued");
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

test("BackgroundJobDispatcher reclaims expired leases during operation, not just at startup", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  // Use a controllable clock so we can expire leases on demand.
  let clockMs = Date.now();
  const now = () => new Date(clockMs);

  let handled = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 2_000, // 2-second lease
    heartbeatIntervalMs: 0, // disable heartbeat for this test
    now,
    handlers: {
      babysit_pr: async () => {
        handled += 1;
      },
    },
  });

  try {
    // Start dispatcher with no jobs — requeueExpired runs but finds nothing.
    await dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handled, 0);

    // Enqueue a job and immediately claim it as a "dead worker",
    // simulating a handler whose heartbeat died.
    const job = await queue.enqueue(
      "babysit_pr", "pr-1", "babysit_pr:pr-1", { prId: "pr-1" },
      { availableAt: now() },
    );
    const claimed = await queue.claimNext({
      workerId: "dead-worker",
      leaseMs: 2_000,
      now: now(),
    });
    assert.ok(claimed);
    assert.equal(claimed.status, "leased");

    // Advance the clock past the lease expiry.
    clockMs += 5_000;

    // The job is now stuck in "leased" with an expired lease.
    // Without the fix, the dispatcher's poll loop would never reclaim it.
    // With the fix, pollOnce calls requeueExpired before claiming.
    dispatcher.wake();
    await waitForCondition(() => handled === 1, 500);
    assert.equal(await dispatcher.waitForIdle(250), true);

    const final = await storage.getBackgroundJob(job.id);
    assert.equal(final?.status, "completed");
  } finally {
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

test("BackgroundJobDispatcher retries transient handler errors before completing", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue("babysit_pr", "pr-1", "babysit_pr:pr-1", {
    prId: "pr-1",
  });

  let attempts = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    maxAttempts: 2,
    retryBackoffMs: 0,
    handlers: {
      babysit_pr: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary GitHub outage");
        }
      },
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(() => attempts === 2, 500);
    assert.equal(await dispatcher.waitForIdle(250), true);

    const stored = await storage.getBackgroundJob(job.id);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.attemptCount, 2);
    assert.match(stored?.lastError ?? "", /temporary GitHub outage/);
  } finally {
    dispatcher.stop();
  }
});

test("BackgroundJobDispatcher fails terminal handler errors without retrying", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue("babysit_pr", "pr-1", "babysit_pr:pr-1", {
    prId: "pr-1",
  });

  let attempts = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    maxAttempts: 3,
    retryBackoffMs: 0,
    handlers: {
      babysit_pr: async () => {
        attempts += 1;
        throw new TerminalBackgroundJobError("merge conflict repair failed twice");
      },
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(async () => (await storage.getBackgroundJob(job.id))?.status === "failed", 500);

    const stored = await storage.getBackgroundJob(job.id);
    assert.equal(attempts, 1);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.attemptCount, 1);
    assert.match(stored?.lastError ?? "", /merge conflict repair failed twice/);
  } finally {
    dispatcher.stop();
  }
});

test("BackgroundJobDispatcher fails handler errors after retry attempts are exhausted", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);
  const job = await queue.enqueue("babysit_pr", "pr-1", "babysit_pr:pr-1", {
    prId: "pr-1",
  });

  let attempts = 0;
  const dispatcher = new BackgroundJobDispatcher({
    storage,
    queue,
    workerId: "dispatcher-1",
    pollIntervalMs: 5,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10,
    maxAttempts: 2,
    retryBackoffMs: 0,
    handlers: {
      babysit_pr: async () => {
        attempts += 1;
        throw new Error("persistent failure");
      },
    },
  });

  try {
    await dispatcher.start();
    await waitForCondition(async () => (await storage.getBackgroundJob(job.id))?.status === "failed", 500);

    const stored = await storage.getBackgroundJob(job.id);
    assert.equal(attempts, 2);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.attemptCount, 2);
    assert.match(stored?.lastError ?? "", /persistent failure/);
  } finally {
    dispatcher.stop();
  }
});
