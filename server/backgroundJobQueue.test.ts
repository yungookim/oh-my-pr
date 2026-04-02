import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";

test("BackgroundJobQueue claims jobs by priority and availableAt", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  await queue.enqueue("babysit_pr", "pr-later", "babysit_pr:pr-later", { prId: "pr-later" }, {
    priority: 50,
    availableAt: "2026-04-02T10:05:00.000Z",
  });
  await queue.enqueue("babysit_pr", "pr-low", "babysit_pr:pr-low", { prId: "pr-low" }, {
    priority: 200,
    availableAt: "2026-04-02T10:00:00.000Z",
  });
  await queue.enqueue("babysit_pr", "pr-high", "babysit_pr:pr-high", { prId: "pr-high" }, {
    priority: 50,
    availableAt: "2026-04-02T10:00:00.000Z",
  });

  const first = await queue.claimNext({
    workerId: "worker-1",
    leaseMs: 30_000,
    now: "2026-04-02T10:00:00.000Z",
  });
  const second = await queue.claimNext({
    workerId: "worker-1",
    leaseMs: 30_000,
    now: "2026-04-02T10:00:00.000Z",
  });
  const thirdBeforeReady = await queue.claimNext({
    workerId: "worker-1",
    leaseMs: 30_000,
    now: "2026-04-02T10:00:00.000Z",
  });
  const thirdAfterReady = await queue.claimNext({
    workerId: "worker-1",
    leaseMs: 30_000,
    now: "2026-04-02T10:05:00.000Z",
  });

  assert.equal(first?.targetId, "pr-high");
  assert.equal(second?.targetId, "pr-low");
  assert.equal(thirdBeforeReady, undefined);
  assert.equal(thirdAfterReady?.targetId, "pr-later");
});

test("BackgroundJobQueue heartbeats only extend the matching lease token", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  const job = await queue.enqueue(
    "answer_pr_question",
    "question-1",
    "answer_pr_question:question-1",
    { questionId: "question-1" },
    { availableAt: "2026-04-02T10:00:00.000Z" },
  );
  const claimed = await queue.claimNext({
    workerId: "worker-1",
    leaseMs: 30_000,
    now: "2026-04-02T10:00:00.000Z",
  });

  assert.equal(claimed?.id, job.id);
  assert.equal(claimed?.leaseExpiresAt, "2026-04-02T10:00:30.000Z");

  const wrongLease = await queue.heartbeat({
    jobId: job.id,
    leaseToken: "wrong-lease",
    leaseMs: 30_000,
    now: "2026-04-02T10:00:10.000Z",
  });
  const matchedLease = await queue.heartbeat({
    jobId: job.id,
    leaseToken: claimed!.leaseToken!,
    leaseMs: 30_000,
    now: "2026-04-02T10:00:10.000Z",
  });

  assert.equal(wrongLease, undefined);
  assert.equal(matchedLease?.heartbeatAt, "2026-04-02T10:00:10.000Z");
  assert.equal(matchedLease?.leaseExpiresAt, "2026-04-02T10:00:40.000Z");
});

test("BackgroundJobQueue reclaims expired leases", async () => {
  const storage = new MemStorage();
  const queue = new BackgroundJobQueue(storage);

  const job = await queue.enqueue(
    "generate_social_changelog",
    "changelog-1",
    "generate_social_changelog:changelog-1",
    { changelogId: "changelog-1" },
    { availableAt: "2026-04-02T10:00:00.000Z" },
  );

  await queue.claimNext({
    workerId: "worker-1",
    leaseMs: 30_000,
    now: "2026-04-02T10:00:00.000Z",
  });

  const beforeExpiry = await queue.requeueExpired("2026-04-02T10:00:29.000Z");
  const afterExpiry = await queue.requeueExpired("2026-04-02T10:00:30.000Z");
  const requeued = await storage.getBackgroundJob(job.id);

  assert.equal(beforeExpiry, 0);
  assert.equal(afterExpiry, 1);
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.leaseToken, null);
  assert.equal(requeued?.leaseOwner, null);
});
