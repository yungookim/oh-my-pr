import { mkdtemp, mkdir } from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import type { CheckSnapshot, FeedbackItem } from "@shared/schema";
import { APP_COMMENT_FOOTER, PRBabysitter } from "./babysitter";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { MemStorage } from "./memoryStorage";

function makeFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "gh-review-comment-1",
    author: "reviewer",
    body: "Please rename this variable.",
    bodyHtml: "<p>Please rename this variable.</p>",
    replyKind: "review_thread",
    sourceId: "1",
    sourceNodeId: "PRRC_kwDO_example",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r1",
    threadId: "PRRT_kwDO_example",
    threadResolved: false,
    auditToken: "codefactory-feedback:gh-review-comment-1",
    file: "src/example.ts",
    line: 12,
    type: "review_comment",
    createdAt: "2026-03-15T10:00:00.000Z",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
    ...overrides,
  };
}

function makePullSummary(pr: { url: string }, overrides?: Record<string, unknown>) {
  return {
    number: 106,
    title: "Verbose PR",
    branch: "feature/verbose",
    author: "octocat",
    url: pr.url,
    repoFullName: "alex-morgan-o/lolodex",
    repoCloneUrl: "https://github.com/alex-morgan-o/lolodex.git",
    headSha: "abc123",
    headRef: "feature/verbose",
    headRepoFullName: "alex-morgan-o/lolodex",
    headRepoCloneUrl: "https://github.com/alex-morgan-o/lolodex.git",
    baseRef: "main",
    mergeable: true as boolean | null,
    ...overrides,
  };
}

function makeGitRunCommand(params?: {
  localHeadSha?: string;
  remoteHeadSha?: string;
}) {
  const localHeadSha = params?.localHeadSha || "def456";
  const remoteHeadSha = params?.remoteHeadSha || localHeadSha;
  let cloned = false;

  return async (command: string, args: string[]) => {
    if (command !== "git") {
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    }

    if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--is-inside-work-tree") {
      return cloned ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }

    if (args[0] === "clone") {
      cloned = true;
      await mkdir(args[2], { recursive: true });
      return { code: 0, stdout: "cloned\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
      return { code: 0, stdout: "https://github.com/alex-morgan-o/lolodex.git\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "status") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "fetch") {
      return { code: 0, stdout: "fetched\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[5], { recursive: true });
      return { code: 0, stdout: "worktree added\n", stderr: "" };
    }

    if (args[0] === "config" && args[1] === "--get") {
      return { code: 1, stdout: "", stderr: "" };
    }

    if (args[0] === "config") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "status") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${localHeadSha}\n`, stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "FETCH_HEAD") {
      return { code: 0, stdout: `${remoteHeadSha}\n`, stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "worktree" && args[3] === "remove") {
      return { code: 0, stdout: "worktree removed\n", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  };
}

function makeWatcherGitHubService(overrides?: Record<string, unknown>) {
  return {
    buildOctokit: async () => ({}) as never,
    fetchFeedbackItemsForPR: async () => [],
    fetchPullSummary: async () => {
      throw new Error("unused");
    },
    fetchPullCloseState: async () => ({
      number: 42,
      title: "Example PR",
      url: "https://github.com/octo/example/pull/42",
      author: "octocat",
      baseRef: "main",
      headRef: "feature/example",
      headSha: "head123",
      merged: true,
      mergedAt: "2026-03-28T12:00:00.000Z",
      closedAt: "2026-03-28T12:00:00.000Z",
      mergeCommitSha: "merge123",
    }),
    listFailingStatuses: async () => [],
    checkCISettled: async () => true,
    getAuthenticatedLogin: async () => "octocat",
    listOpenPullsForRepo: async () => [],
    postFollowUpForFeedbackItem: async () => undefined,
    resolveReviewThread: async () => undefined,
    resolveGitHubAuthToken: async () => undefined,
    addReactionToComment: async () => undefined,
    postStatusReplyForFeedbackItem: async () => null,
    updateStatusReply: async () => undefined,
    postPRComment: async () => undefined,
    ...overrides,
  };
}

function makeCheckSnapshot(overrides: Partial<CheckSnapshot> = {}): CheckSnapshot {
  return {
    id: "snapshot-1",
    prId: "pr-1",
    sha: "abc123",
    provider: "github.check_run",
    context: "build",
    status: "completed",
    conclusion: "failure",
    description: "TypeScript compilation failed",
    targetUrl: "https://github.com/octo/example/actions/runs/1",
    observedAt: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };
}

test("pollForCICompletion tolerates transient status API errors and eventually succeeds", async () => {
  const storage = new MemStorage();
  const logs: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  let settledChecks = 0;
  let statusChecks = 0;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => {
        throw new Error("unused");
      },
      listFailingStatuses: async () => {
        statusChecks += 1;
        if (statusChecks === 1) {
          throw new Error("transient GitHub API error");
        }
        return [];
      },
      checkCISettled: async () => {
        settledChecks += 1;
        return settledChecks >= 2;
      },
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => undefined,
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => undefined,
      postPRComment: async () => undefined,
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );

  const result = await (babysitter as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).pollForCICompletion(
    {} as never,
    { owner: "octo", repo: "example" },
    { owner: "octo", repo: "example", number: 42 },
    "abc123",
    "pr-1",
    async (
      _prId: string,
      level: "info" | "warn" | "error",
      message: string,
    ) => {
      logs.push({ level, message });
    },
  );

  assert.deepEqual(result, { status: "success", failures: [] });
  assert.ok(logs.some((log) => log.level === "warn" && log.message.includes("CI poll attempt 1 failed")));
  assert.ok(logs.some((log) => log.level === "info" && log.message.includes("CI poll attempt 2/10")));
});

test("pollForCICompletion returns timeout when status API keeps failing, including final check", async () => {
  const storage = new MemStorage();
  const logs: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  let settledChecks = 0;
  let statusChecks = 0;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => {
        throw new Error("unused");
      },
      listFailingStatuses: async () => {
        statusChecks += 1;
        throw new Error(`still flaky (${statusChecks})`);
      },
      checkCISettled: async () => {
        settledChecks += 1;
        return false;
      },
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => undefined,
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => undefined,
      postPRComment: async () => undefined,
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );

  const result = await (babysitter as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).pollForCICompletion(
    {} as never,
    { owner: "octo", repo: "example" },
    { owner: "octo", repo: "example", number: 42 },
    "abc123",
    "pr-1",
    async (
      _prId: string,
      level: "info" | "warn" | "error",
      message: string,
    ) => {
      logs.push({ level, message });
    },
  );

  assert.deepEqual(result, { status: "timeout", failures: [] });
  assert.equal(settledChecks, 10);
  assert.equal(statusChecks, 11);
  assert.ok(logs.some((log) => log.level === "warn" && log.message.includes("Final CI status check after timeout failed")));
});

test("syncFeedbackForPR logs completion even when no new feedback items arrive", async () => {
  const storage = new MemStorage();
  const existingItem = makeFeedbackItem();

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(storage, {
    buildOctokit: async () => ({}) as never,
    fetchFeedbackItemsForPR: async () => [existingItem],
    fetchPullSummary: async () => {
      throw new Error("unused in this test");
    },
    listFailingStatuses: async () => {
      throw new Error("unused in this test");
    },
    checkCISettled: async () => {
      throw new Error("unused in this test");
    },
    listOpenPullsForRepo: async () => {
      throw new Error("unused in this test");
    },
    postFollowUpForFeedbackItem: async () => {
      throw new Error("unused in this test");
    },
    resolveReviewThread: async () => {
      throw new Error("unused in this test");
    },
    resolveGitHubAuthToken: async () => undefined,
    addReactionToComment: async () => {},
    postStatusReplyForFeedbackItem: async () => null,
    updateStatusReply: async () => {},
  });

  const updated = await babysitter.syncFeedbackForPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(updated.status, "watching");
  assert.equal(logs.at(-1)?.message, "GitHub sync complete: 1 feedback item (0 new)");
});

test("syncAndBabysitTrackedRepos queues release evaluation for merged archived PRs", async () => {
  const storage = new MemStorage();
  const queued: Array<Record<string, string | number>> = [];

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
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

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService(),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    {
      enqueueMergedPullReleaseEvaluation: async (input) => {
        queued.push(input as Record<string, string | number>);
      },
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  assert.equal(updated?.status, "archived");
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.triggerMergeSha, "merge123");
  assert.ok(logs.some((log) => log.message.includes("queued release evaluation")));
});

test("syncAndBabysitTrackedRepos enqueues social changelog generation as a background job", async () => {
  const storage = new MemStorage();
  const backgroundJobQueue = new BackgroundJobQueue(storage);

  await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
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

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listMergedPullsToday: async () => Array.from({ length: 5 }, (_, index) => ({
        number: index + 1,
        title: `Merged PR ${index + 1}`,
        url: `https://github.com/octo/example/pull/${index + 1}`,
        author: "octocat",
        repo: "octo/example",
        mergedAt: `2026-03-28T1${index}:00:00.000Z`,
      })),
    }),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    undefined,
    async (...args) => backgroundJobQueue.enqueue(...args),
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const changelogs = await storage.getSocialChangelogs();
  assert.equal(changelogs.length, 1);
  assert.equal(changelogs[0].triggerCount, 5);
  assert.equal(changelogs[0].status, "generating");

  const jobs = await storage.listBackgroundJobs({
    kind: "generate_social_changelog",
    targetId: changelogs[0].id,
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
});

test("syncAndBabysitTrackedRepos enqueues babysit_pr jobs when a background scheduler is provided", async () => {
  const storage = new MemStorage();
  const backgroundJobQueue = new BackgroundJobQueue(storage);

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    watchEnabled: true,
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [{
        number: 42,
        title: "Example PR",
        branch: "feature/example",
        author: "octocat",
        url: "https://github.com/octo/example/pull/42",
      }],
    }),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    undefined,
    async (...args) => backgroundJobQueue.enqueue(...args),
  );

  babysitter.babysitPR = async () => {
    throw new Error("watcher should not invoke babysitPR directly when a scheduler is provided");
  };

  await babysitter.syncAndBabysitTrackedRepos();

  const jobs = await storage.listBackgroundJobs({
    kind: "babysit_pr",
    targetId: pr.id,
    status: "queued",
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.preferredAgent, "claude");
});

test("syncAndBabysitTrackedRepos repairs missing review-thread metadata on archived PRs", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 42,
    title: "Repair review-thread metadata",
    repo: "octo/example",
    branch: "feature/repair",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "archived",
    feedbackItems: [
      {
        id: "gh-review-comment-1",
        author: "reviewer",
        body: "Please reply in thread",
        bodyHtml: "<p>Please reply in thread</p>",
        replyKind: "review_thread",
        sourceId: "101",
        sourceNodeId: null,
        sourceUrl: "https://github.com/octo/example/pull/42#discussion_r101",
        threadId: null,
        threadResolved: null,
        auditToken: "codefactory-feedback:gh-review-comment-1",
        file: "server/github.ts",
        line: 100,
        type: "review_comment",
        createdAt: "2026-04-02T10:00:00Z",
        decision: null,
        decisionReason: null,
        action: null,
        status: "pending",
        statusReason: null,
      },
    ],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    watchEnabled: false,
  });

  const babysitter = new PRBabysitter(storage, {
    buildOctokit: async () => ({}) as never,
    fetchFeedbackItemsForPR: async () => [
      {
        id: "gh-review-comment-1",
        author: "reviewer",
        body: "Please reply in thread",
        bodyHtml: "<p>Please reply in thread</p>",
        replyKind: "review_thread",
        sourceId: "101",
        sourceNodeId: null,
        sourceUrl: "https://github.com/octo/example/pull/42#discussion_r101",
        threadId: "THREAD_node_101",
        threadResolved: false,
        auditToken: "codefactory-feedback:gh-review-comment-1",
        file: "server/github.ts",
        line: 100,
        type: "review_comment",
        createdAt: "2026-04-02T10:00:00Z",
        decision: null,
        decisionReason: null,
        action: null,
        status: "pending",
        statusReason: null,
      },
    ],
    fetchPullSummary: async () => {
      throw new Error("unused in this test");
    },
    listFailingStatuses: async () => [],
    listOpenPullsForRepo: async () => [],
    postFollowUpForFeedbackItem: async () => undefined,
    postPRComment: async () => undefined,
    resolveReviewThread: async () => undefined,
    resolveGitHubAuthToken: async () => undefined,
    addReactionToComment: async () => {},
    postStatusReplyForFeedbackItem: async () => null,
    updateStatusReply: async () => {},
    checkCISettled: async () => true,
    fetchCheckSnapshotsForRef: async () => [],
  });

  await babysitter.syncAndBabysitTrackedRepos();

  const repaired = await storage.getArchivedPRs();
  const repairedPr = repaired.find((candidate) => candidate.id === pr.id);
  const repairedItem = repairedPr?.feedbackItems.find((candidate) => candidate.id === "gh-review-comment-1");

  assert.equal(repairedItem?.threadId, "THREAD_node_101");
  assert.equal(repairedItem?.threadResolved, false);
  assert.equal(repairedPr?.status, "archived");
});

test("syncAndBabysitTrackedRepos skips automatic babysits when pr watch is paused", async () => {
  const storage = new MemStorage();
  const babysitCalls: string[] = [];

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
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

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [{
        number: 42,
        title: "Example PR",
        branch: "feature/example",
        author: "octocat",
        url: "https://github.com/octo/example/pull/42",
      }],
    }),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );
  babysitter.babysitPR = async (prId) => {
    babysitCalls.push(prId);
    return;
  };

  await babysitter.syncAndBabysitTrackedRepos();

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  assert.equal(updated?.watchEnabled, false);
  assert.deepEqual(babysitCalls, []);
  assert.ok(!logs.some((log) => log.message.includes("Watcher queued autonomous babysitter run")));
});

test("syncAndBabysitTrackedRepos resumes automatic babysits when pr watch is re-enabled", async () => {
  const storage = new MemStorage();
  const babysitCalls: string[] = [];

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    watchEnabled: true,
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [{
        number: 42,
        title: "Example PR",
        branch: "feature/example",
        author: "octocat",
        url: "https://github.com/octo/example/pull/42",
      }],
    }),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );
  babysitter.babysitPR = async (prId) => {
    babysitCalls.push(prId);
    return;
  };

  await storage.updatePR(pr.id, { watchEnabled: false });
  await babysitter.syncAndBabysitTrackedRepos();
  await storage.updatePR(pr.id, { watchEnabled: true });
  await babysitter.syncAndBabysitTrackedRepos();

  const logs = await storage.getLogs(pr.id);
  assert.deepEqual(babysitCalls, [pr.id]);
  assert.ok(logs.some((log) => log.message.includes("Watcher queued autonomous babysitter run")));
});

test("syncAndBabysitTrackedRepos does not queue release evaluation for closed-unmerged PRs", async () => {
  const storage = new MemStorage();
  const queued: Array<Record<string, string | number>> = [];

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      fetchPullCloseState: async () => ({
        number: 42,
        title: "Example PR",
        url: "https://github.com/octo/example/pull/42",
        author: "octocat",
        baseRef: "main",
        headRef: "feature/example",
        headSha: "head123",
        merged: false,
        mergedAt: null,
        closedAt: "2026-03-28T12:00:00.000Z",
        mergeCommitSha: null,
      }),
    }),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    {
      enqueueMergedPullReleaseEvaluation: async (input) => {
        queued.push(input as Record<string, string | number>);
      },
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  assert.equal(updated?.status, "archived");
  assert.equal(queued.length, 0);
  assert.ok(logs.some((log) => log.message.includes("closed without merge")));
});

test("syncAndBabysitTrackedRepos respects autoCreateReleases when a merged PR is archived", async () => {
  const storage = new MemStorage();
  const queued: Array<Record<string, string | number>> = [];
  await storage.updateConfig({ autoCreateReleases: false });

  await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService(),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    {
      enqueueMergedPullReleaseEvaluation: async (input) => {
        queued.push(input as Record<string, string | number>);
      },
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  assert.equal(queued.length, 0);
});

test("syncAndBabysitTrackedRepos respects repo-level autoCreateReleases when a merged PR is archived", async () => {
  const storage = new MemStorage();
  const queued: Array<Record<string, string | number>> = [];
  await storage.updateRepoSettings("octo/example", { autoCreateReleases: false });

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService(),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    {
      enqueueMergedPullReleaseEvaluation: async (input) => {
        queued.push(input as Record<string, string | number>);
      },
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const logs = await storage.getLogs(pr.id);
  assert.equal(queued.length, 0);
  assert.ok(logs.some((log) => log.message.includes("auto-release is disabled for octo/example")));
});

test("syncAndBabysitTrackedRepos skips release evaluation when merged PR metadata is incomplete", async () => {
  const storage = new MemStorage();
  const queued: Array<Record<string, string | number>> = [];

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      fetchPullCloseState: async () => ({
        number: 42,
        title: "Example PR",
        url: "https://github.com/octo/example/pull/42",
        author: "octocat",
        baseRef: "",
        headRef: "feature/example",
        headSha: "",
        merged: true,
        mergedAt: null,
        closedAt: null,
        mergeCommitSha: null,
      }),
    }),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    {
      enqueueMergedPullReleaseEvaluation: async (input) => {
        queued.push(input as Record<string, string | number>);
      },
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const logs = await storage.getLogs(pr.id);
  assert.equal(queued.length, 0);
  assert.ok(logs.some((log) => log.message.includes("release evaluation was not queued because GitHub did not return")));
  assert.ok(logs.some((log) => log.message.includes("base branch")));
  assert.ok(logs.some((log) => log.message.includes("commit SHA")));
  assert.ok(logs.some((log) => log.message.includes("merge timestamp")));
});

test("babysitPR skips new runs while drain mode is enabled", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [makeFeedbackItem()],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  await storage.updateRuntimeState({
    drainMode: true,
    drainRequestedAt: "2026-03-18T10:00:00.000Z",
    drainReason: "planned update",
  });

  const babysitter = new PRBabysitter(storage, {
    buildOctokit: async () => ({}) as never,
    fetchFeedbackItemsForPR: async () => {
      throw new Error("should not fetch feedback while draining");
    },
    fetchPullSummary: async () => {
      throw new Error("unused");
    },
    listFailingStatuses: async () => [],
    checkCISettled: async () => true,
    listOpenPullsForRepo: async () => [],
    postFollowUpForFeedbackItem: async () => undefined,
    resolveReviewThread: async () => undefined,
    resolveGitHubAuthToken: async () => undefined,
    addReactionToComment: async () => undefined,
    postStatusReplyForFeedbackItem: async () => null,
    updateStatusReply: async () => undefined,
    postPRComment: async () => undefined,
  });

  await babysitter.babysitPR(pr.id, "codex");

  const logs = await storage.getLogs(pr.id);
  const runs = await storage.listAgentRuns();
  assert.ok(logs.some((log) => log.message.includes("drain mode is enabled")));
  assert.equal(runs.length, 0);
});

test("retryFeedbackItem serializes concurrent retry updates for the same PR", async () => {
  const storage = new MemStorage();
  const failedItem = makeFeedbackItem({
    id: "gh-review-comment-1",
    status: "failed",
    statusReason: "GitHub follow-up failed",
  });
  const warningItem = makeFeedbackItem({
    id: "gh-review-comment-2",
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_example_2",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r2",
    threadId: "PRRT_kwDO_example_2",
    auditToken: "codefactory-feedback:gh-review-comment-2",
    line: 24,
    createdAt: "2026-03-15T10:01:00.000Z",
    status: "warning",
    statusReason: "GitHub comment could not be posted",
  });

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [failedItem, warningItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(storage);
  const [firstResult, secondResult] = await Promise.all([
    babysitter.retryFeedbackItem(pr.id, failedItem.id),
    babysitter.retryFeedbackItem(pr.id, warningItem.id),
  ]);

  assert.equal(firstResult.kind, "ok");
  assert.equal(secondResult.kind, "ok");

  const updated = await storage.getPR(pr.id);
  const retriedFailed = updated?.feedbackItems.find((item) => item.id === failedItem.id);
  const retriedWarning = updated?.feedbackItems.find((item) => item.id === warningItem.id);

  assert.equal(retriedFailed?.status, "queued");
  assert.equal(retriedFailed?.statusReason, "Queued for retry");
  assert.equal(retriedWarning?.status, "queued");
  assert.equal(retriedWarning?.statusReason, "Queued for retry");
});

test("babysitPR uses a CODEFACTORY_HOME worktree, passes GitHub context, and verifies audit trail", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  let receivedPrompt = "";
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  let feedbackFetchCount = 0;
  const postedFollowUps: Array<{ id: string; body: string }> = [];
  const postedAgentComments: string[] = [];
  const resolvedThreads: string[] = [];
  const pullSummary = makePullSummary(pr);
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Implemented the requested rename.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Implemented the requested rename.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    decision: null,
    decisionReason: null,
    action: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem];
        }

        return [
          { ...existingItem, threadResolved: true },
          followUp,
        ];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body, options) => {
        postedFollowUps.push({ id: item.id, body });
        if (options?.resolve && item.threadId) {
          resolvedThreads.push(item.threadId);
        }
      },
      resolveReviewThread: async (_octokit, _parsed, threadId) => {
        resolvedThreads.push(threadId);
      },
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postPRComment: async (_octokit: unknown, _parsed: unknown, body: string) => {
        postedAgentComments.push(body);
      },
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: true,
        reason: "Comment requires a code change",
      }),
      applyFixesWithAgent: async ({ prompt, env, onStdoutChunk, onStderrChunk }) => {
        receivedPrompt = prompt;
        receivedEnv = env;
        const agentOutput = [
          "agent stdout line",
          "FEEDBACK_SUMMARY_START codefactory-feedback:gh-review-comment-1",
          "Renamed the variable from `foo` to `bar` as requested.",
          "FEEDBACK_SUMMARY_END",
        ].join("\n") + "\n";
        onStdoutChunk?.(agentOutput);
        onStderrChunk?.("agent stderr line\n");
        return {
          code: 0,
          stdout: agentOutput,
          stderr: "agent stderr line\n",
        };
      },
      runCommand: makeGitRunCommand({
        localHeadSha: "def456",
        remoteHeadSha: "def456",
      }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  const runs = await storage.listAgentRuns();
  const fixRunLog = logs.find((log) => log.phase === "run" && log.message.includes("Babysitter preparing fix run"));

  assert.equal(updated?.status, "watching");
  assert.equal(updated?.accepted, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "completed");
  assert.equal(runs[0]?.resolvedAgent, "codex");
  assert.equal(runs[0]?.initialHeadSha, "abc123");
  assert.match(runs[0]?.prompt || "", /auditToken=codefactory-feedback:gh-review-comment-1/);
  assert.ok(fixRunLog);
  assert.equal(
    fixRunLog.message,
    "Babysitter preparing fix run with 1 comment task(s), 0 status task(s), 0 documentation task(s), and 1 GitHub follow-up task(s) using codex",
  );
  assert.equal(fixRunLog.metadata?.followUpTasks, 1);
  assert.equal(fixRunLog.metadata?.docsTasks, 0);
  assert.deepEqual(postedFollowUps, [
    {
      id: "gh-review-comment-1",
      body: `Addressed in commit \`def456\` by the latest babysitter run.\n\nRenamed the variable from \`foo\` to \`bar\` as requested.\n\n<!-- codefactory-feedback:gh-review-comment-1 -->\n\n${APP_COMMENT_FOOTER}`,
    },
  ]);
  assert.equal(postedAgentComments.length, 1);
  assert.match(
    postedAgentComments[0] || "",
    /\*\*\[oh-my-pr\]\(https:\/\/github.com\/yungookim\/oh-my-pr\)\*\* dispatched `codex`/,
  );
  assert.doesNotMatch(postedAgentComments[0] || "", /\*\*CodeFactory\*\*/);
  assert.equal(postedAgentComments[0]?.endsWith(APP_COMMENT_FOOTER), true);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
  assert.ok(logs.some((log) => log.phase === "worktree" && log.message.includes(`Preparing worktree in ${worktreeRoot}`)));
  assert.ok(logs.some((log) => log.phase === "github.followup" && log.message.includes("GitHub follow-up complete for gh-review-comment-1")));
  assert.ok(logs.some((log) => log.phase === "verify.github" && log.message.includes("GitHub audit trail verified")));
  assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("Babysitter run complete")));
  assert.match(receivedPrompt, /If you changed files, commit and push to origin HEAD:feature\/verbose/i);
  assert.match(receivedPrompt, /GitHub follow-up replies and review-thread resolution will be handled by the babysitter/i);
  assert.match(receivedPrompt, /auditToken=codefactory-feedback:gh-review-comment-1/);
  assert.match(receivedPrompt, /FEEDBACK_SUMMARY_START/);
  assert.equal(receivedEnv?.GITHUB_TOKEN, "test-token");
  assert.equal(receivedEnv?.GH_TOKEN, "test-token");

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR omits repository links in GitHub comments when disabled", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    autoUpdateDocs: false,
    includeRepositoryLinksInGitHubComments: false,
  });
  const existingItem = makeFeedbackItem();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    let feedbackFetchCount = 0;
    const initialStatusBodies: Array<{ id: string; body: string }> = [];
    const statusReplyRefs = new Map<
      string,
      { commentDatabaseId: number; replyKind: FeedbackItem["replyKind"]; body: string }
    >();
    const postedFollowUps: Array<{ id: string; body: string }> = [];
    const postedAgentComments: string[] = [];
    const pullSummary = makePullSummary(pr);
    const followUp = makeFeedbackItem({
      id: "gh-review-comment-2",
      author: "code-factory",
      body: `Implemented the requested rename.\n\n<!-- ${existingItem.auditToken} -->`,
      bodyHtml: "<p>Implemented the requested rename.</p>",
      sourceId: "2",
      sourceNodeId: "PRRC_kwDO_followup",
      sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
      threadId: existingItem.threadId,
      threadResolved: true,
      createdAt: new Date().toISOString(),
      auditToken: "codefactory-feedback:gh-review-comment-2",
      decision: null,
      decisionReason: null,
      action: null,
      status: "pending",
      statusReason: null,
    });

    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => {
          feedbackFetchCount += 1;
          if (feedbackFetchCount === 1) {
            return [existingItem];
          }

          return [
            { ...existingItem, threadResolved: true },
            followUp,
          ];
        },
        fetchPullSummary: async () => pullSummary,
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body) => {
          postedFollowUps.push({ id: item.id, body });
        },
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postPRComment: async (_octokit, _parsed, body) => {
          postedAgentComments.push(body);
        },
        postStatusReplyForFeedbackItem: async (_octokit, _parsed, item, body) => {
          initialStatusBodies.push({ id: item.id, body });
          const ref = {
            commentDatabaseId: Number(item.sourceId),
            replyKind: item.replyKind,
            body,
          };
          statusReplyRefs.set(item.id, ref);
          return ref;
        },
        updateStatusReply: async (_octokit, _parsed, ref, body) => {
          ref.body = body;
        },
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => ({
          needsFix: true,
          reason: "Comment requires a code change",
        }),
        applyFixesWithAgent: async ({ onStdoutChunk }) => {
          const agentOutput = [
            "FEEDBACK_SUMMARY_START codefactory-feedback:gh-review-comment-1",
            "Renamed the variable from `foo` to `bar` as requested.",
            "FEEDBACK_SUMMARY_END",
          ].join("\n") + "\n";
          onStdoutChunk?.(agentOutput);
          return {
            code: 0,
            stdout: agentOutput,
            stderr: "",
          };
        },
        runCommand: makeGitRunCommand({
          localHeadSha: "def456",
          remoteHeadSha: "def456",
        }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const expectedAcceptedStatus = "\u23f3 **Accepted** \u2014 this comment requires code changes. Queuing fix...";
    const expectedFinalStatusBody = [
      expectedAcceptedStatus,
      "\ud83e\uddf0 **Agent running** \u2014 `codex` is working on the fix...",
      "\u2705 **Agent completed** \u2014 verifying changes...",
      "\ud83c\udf89 **Resolved** \u2014 addressed in commit `def456`.",
    ].join("\n");

    assert.deepEqual(initialStatusBodies, [
      { id: existingItem.id, body: expectedAcceptedStatus },
    ]);
    assert.equal(statusReplyRefs.get(existingItem.id)?.body, expectedFinalStatusBody);
    assert.deepEqual(postedFollowUps, [
      {
        id: "gh-review-comment-1",
        body: "Addressed in commit `def456` by the latest babysitter run.\n\nRenamed the variable from `foo` to `bar` as requested.\n\n<!-- codefactory-feedback:gh-review-comment-1 -->",
      },
    ]);
    assert.equal(postedAgentComments.length, 1);
    assert.match(postedAgentComments[0] || "", /\*\*oh-my-pr\*\* dispatched `codex`/);
    assert.doesNotMatch(postedAgentComments[0] || "", /\[oh-my-pr\]\(https:\/\/github.com\/yungookim\/oh-my-pr\)/);
    assert.equal(postedAgentComments[0]?.includes(APP_COMMENT_FOOTER), false);
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR centralizes status replies, logs best-effort failures, and updates replies in parallel", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const firstItem = makeFeedbackItem();
  const secondItem = makeFeedbackItem({
    id: "gh-review-comment-2",
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_example_2",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r2",
    threadId: "PRRT_kwDO_example_2",
    auditToken: "codefactory-feedback:gh-review-comment-2",
    line: 24,
    createdAt: "2026-03-15T10:01:00.000Z",
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [firstItem, secondItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    let feedbackFetchCount = 0;
    let activeStatusUpdates = 0;
    let maxConcurrentStatusUpdates = 0;
    const initialStatusBodies: Array<{ id: string; body: string }> = [];
    const statusReplyRefs = new Map<
      string,
      { commentDatabaseId: number; replyKind: FeedbackItem["replyKind"]; body: string }
    >();
    const pullSummary = makePullSummary(pr);
    const followUpItems = [
      makeFeedbackItem({
        id: "gh-review-comment-3",
        author: "code-factory",
        body: `Addressed in commit \`def456\` by the latest babysitter run.\n\n${firstItem.auditToken}`,
        bodyHtml: `<p>Addressed in commit <code>def456</code> by the latest babysitter run.</p><p>${firstItem.auditToken}</p>`,
        sourceId: "3",
        sourceNodeId: "PRRC_kwDO_followup_1",
        sourceUrl: "https://github.com/octo/example/pull/42#discussion_r3",
        threadId: firstItem.threadId,
        threadResolved: true,
        createdAt: new Date().toISOString(),
        decision: null,
        decisionReason: null,
        action: null,
      }),
      makeFeedbackItem({
        id: "gh-review-comment-4",
        author: "code-factory",
        body: `Addressed in commit \`def456\` by the latest babysitter run.\n\n${secondItem.auditToken}`,
        bodyHtml: `<p>Addressed in commit <code>def456</code> by the latest babysitter run.</p><p>${secondItem.auditToken}</p>`,
        sourceId: "4",
        sourceNodeId: "PRRC_kwDO_followup_2",
        sourceUrl: "https://github.com/octo/example/pull/42#discussion_r4",
        threadId: secondItem.threadId,
        threadResolved: true,
        createdAt: new Date().toISOString(),
        decision: null,
        decisionReason: null,
        action: null,
      }),
    ];

    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => {
          feedbackFetchCount += 1;
          if (feedbackFetchCount === 1) {
            return [firstItem, secondItem];
          }

          return [
            { ...firstItem, threadResolved: true },
            { ...secondItem, threadResolved: true },
            ...followUpItems,
          ];
        },
        fetchPullSummary: async () => pullSummary,
        listFailingStatuses: async () => [],
    checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {
          throw new Error("reaction endpoint unavailable");
        },
        postStatusReplyForFeedbackItem: async (_octokit, _parsed, item, body) => {
          initialStatusBodies.push({ id: item.id, body });
          const ref = {
            commentDatabaseId: Number(item.sourceId),
            replyKind: item.replyKind,
            body,
          };
          statusReplyRefs.set(item.id, ref);
          return ref;
        },
        updateStatusReply: async (_octokit, _parsed, ref, body) => {
          activeStatusUpdates += 1;
          maxConcurrentStatusUpdates = Math.max(maxConcurrentStatusUpdates, activeStatusUpdates);
          await new Promise((resolve) => setTimeout(resolve, 15));
          ref.body = body;
          activeStatusUpdates -= 1;
        },
      },
      {
        resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => ({
          needsFix: true,
          reason: "Comment requires a code change",
        }),
        applyFixesWithAgent: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
        }),
        runCommand: makeGitRunCommand({
          localHeadSha: "def456",
          remoteHeadSha: "def456",
        }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const logs = await storage.getLogs(pr.id);
    const expectedAcceptedLine = "\u23f3 **Accepted** \u2014 this comment requires code changes. Queuing fix...";
    const expectedAcceptedStatus = `${expectedAcceptedLine}\n\n${APP_COMMENT_FOOTER}`;
    const expectedFinalStatusBody = [
      expectedAcceptedLine,
      "\ud83e\uddf0 **Agent running** \u2014 `codex` is working on the fix...",
      "\u2705 **Agent completed** \u2014 verifying changes...",
      "\ud83c\udf89 **Resolved** \u2014 addressed in commit `def456`.",
      "",
      APP_COMMENT_FOOTER,
    ].join("\n");

    assert.deepEqual(initialStatusBodies, [
      { id: firstItem.id, body: expectedAcceptedStatus },
      { id: secondItem.id, body: expectedAcceptedStatus },
    ]);
    assert.equal(statusReplyRefs.get(firstItem.id)?.body, expectedFinalStatusBody);
    assert.equal(statusReplyRefs.get(secondItem.id)?.body, expectedFinalStatusBody);
    assert.ok(maxConcurrentStatusUpdates >= 2);
    assert.ok(
      logs.some((log) => {
        return log.phase === "github.reaction"
          && log.message.includes("Failed to add reaction for gh-review-comment-1: reaction endpoint unavailable");
      }),
    );
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR marks the run as error when app-owned GitHub follow-up fails", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  const pullSummary = makePullSummary(pr);
  let applyCalled = false;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [existingItem],
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => {
        throw new Error("GitHub follow-up failed");
      },
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: true,
        reason: "Comment requires a code change",
      }),
      applyFixesWithAgent: async ({ onStdoutChunk, onStderrChunk }) => {
        applyCalled = true;
        onStdoutChunk?.("agent stdout line\n");
        onStderrChunk?.("agent stderr line\n");
        return {
          code: 0,
          stdout: "agent stdout line\n",
          stderr: "agent stderr line\n",
        };
      },
      runCommand: makeGitRunCommand({
        localHeadSha: "def456",
        remoteHeadSha: "def456",
      }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(applyCalled, true);
  assert.equal(updated?.status, "error");
  assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("GitHub follow-up failed")));
  assert.ok(logs.some((log) => log.phase === "cleanup" && log.message.includes("Worktree cleanup complete")));

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR treats audit-trail replies as non-actionable follow-up comments", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const originalItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Previously addressed",
    action: "Please rename this variable.",
    threadResolved: true,
    status: "resolved",
  });
  const auditReply = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Implemented the rename and verified the failing test now passes.\n\n${originalItem.auditToken}`,
    bodyHtml: "<p>Implemented the rename and verified the failing test now passes.</p>",
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r2",
    threadId: originalItem.threadId,
    threadResolved: true,
    createdAt: "2026-03-15T10:05:00.000Z",
    auditToken: "codefactory-feedback:gh-review-comment-2",
    status: "pending",
  });

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [originalItem, auditReply],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [originalItem, auditReply],
      fetchPullSummary: async () => makePullSummary(pr),
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => undefined,
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => undefined,
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => {
        throw new Error("automation audit-trail follow-up should not be sent back to the coding agent");
      },
      applyFixesWithAgent: async () => {
        throw new Error("automation audit-trail follow-up should not trigger a fix run");
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  const updatedReply = updated?.feedbackItems.find((item) => item.id === auditReply.id);

  assert.equal(updated?.status, "watching");
  assert.equal(updated?.rejected, 1);
  assert.equal(updatedReply?.decision, "reject");
  assert.equal(updatedReply?.status, "rejected");
  assert.match(updatedReply?.statusReason || "", /audit trail/i);
  assert.ok(logs.some((log) => log.phase === "evaluate.comments" && log.message.includes("Ignored audit-trail follow-up comment")));
  assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("no necessary fixes identified")));
});

test("babysitPR does not auto-ignore audit-trail replies when referenced timestamps are invalid", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const originalItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Previously addressed",
    action: "Please rename this variable.",
    threadResolved: true,
    createdAt: "not-a-date",
    status: "resolved",
  });
  const auditReply = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Implemented the rename and verified the failing test now passes.\n\n${originalItem.auditToken}`,
    bodyHtml: "<p>Implemented the rename and verified the failing test now passes.</p>",
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r2",
    threadId: originalItem.threadId,
    threadResolved: true,
    createdAt: "2026-03-15T10:05:00.000Z",
    auditToken: "codefactory-feedback:gh-review-comment-2",
    status: "pending",
  });

  const pr = await storage.addPR({
    number: 42,
    title: "Example PR",
    repo: "octo/example",
    branch: "feature/example",
    author: "octocat",
    url: "https://github.com/octo/example/pull/42",
    status: "watching",
    feedbackItems: [originalItem, auditReply],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let evaluateCallCount = 0;
  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [originalItem, auditReply],
      fetchPullSummary: async () => makePullSummary(pr),
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => undefined,
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => undefined,
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => {
        evaluateCallCount += 1;
        return {
          needsFix: false,
          reason: "Need a reliable timestamp before classifying this as automation follow-up",
        };
      },
      applyFixesWithAgent: async () => {
        throw new Error("malformed audit-trail timestamps should not trigger a fix run");
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  const updatedReply = updated?.feedbackItems.find((item) => item.id === auditReply.id);

  assert.equal(evaluateCallCount, 1);
  assert.equal(updated?.status, "watching");
  assert.equal(updatedReply?.decision, "reject");
  assert.equal(updatedReply?.status, "rejected");
  assert.match(updatedReply?.statusReason || "", /reliable timestamp/i);
  assert.equal(logs.some((log) => log.phase === "evaluate.comments" && log.message.includes("Ignored audit-trail follow-up comment")), false);
});

test("babysitPR marks accepted pending items as resolved after a successful run", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem({ status: "pending", decision: null });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr);
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Implemented the fix.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Implemented the fix.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) return [existingItem];
        return [{ ...existingItem, threadResolved: true }, followUp];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: true, reason: "Code change needed" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const resolvedItem = updated?.feedbackItems.find((i) => i.id === existingItem.id);
  assert.equal(resolvedItem?.status, "resolved");

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR marks claimed items as warning when audit trail verification fails but branch moved", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem({ status: "pending", decision: null });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  const pullSummary = makePullSummary(pr);

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [existingItem],
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: true, reason: "Code change needed" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const warnedItem = updated?.feedbackItems.find((i) => i.id === existingItem.id);
  // When the branch was moved (agent pushed code) but audit trail verification
  // fails (GitHub comment posting issue), items should be marked as "warning"
  // not "failed" since the actual fix was applied successfully.
  assert.equal(warnedItem?.status, "warning");
  assert.ok(warnedItem?.statusReason?.includes("GitHub comment could not be posted"));

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR picks up manually-queued items and resolves them without re-evaluating", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const queuedItem = makeFeedbackItem({
    status: "queued",
    decision: "accept",
    decisionReason: "Manual override",
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [queuedItem],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr);
  let evaluateCallCount = 0;
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Fix applied.\n\n${queuedItem.auditToken}`,
    bodyHtml: `<p>Fix applied.</p><p>${queuedItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: queuedItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) return [queuedItem];
        return [{ ...queuedItem, threadResolved: true }, followUp];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => {
        evaluateCallCount += 1;
        return { needsFix: true, reason: "Should not be called" };
      },
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const resolvedItem = updated?.feedbackItems.find((i) => i.id === queuedItem.id);
  assert.equal(evaluateCallCount, 0, "evaluateFixNecessityWithAgent should not be called for already-queued items");
  assert.equal(resolvedItem?.status, "resolved");

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR does not pull rejected or resolved items into in_progress", async () => {
  const storage = new MemStorage();
  const rejectedItem = makeFeedbackItem({
    id: "gh-review-comment-rejected",
    status: "rejected",
    decision: "reject",
    decisionReason: "Not actionable",
  });
  const resolvedItem = makeFeedbackItem({
    id: "gh-review-comment-resolved",
    status: "resolved",
    decision: "accept",
  });
  const pendingItem = makeFeedbackItem({
    id: "gh-review-comment-pending",
    status: "pending",
    decision: null,
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [rejectedItem, resolvedItem, pendingItem],
    accepted: 1,
    rejected: 1,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr);
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-followup",
    author: "code-factory",
    body: `Fix applied.\n\n${pendingItem.auditToken}`,
    bodyHtml: `<p>Fix applied.</p><p>${pendingItem.auditToken}</p>`,
    sourceId: "99",
    sourceNodeId: "PRRC_kwDO_followup99",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r99",
    threadId: pendingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-followup",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) return [rejectedItem, resolvedItem, pendingItem];
        return [rejectedItem, resolvedItem, { ...pendingItem, threadResolved: true }, followUp];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async (_params) => ({ needsFix: true, reason: "Code change needed" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const updatedRejected = updated?.feedbackItems.find((i) => i.id === rejectedItem.id);
  const updatedResolved = updated?.feedbackItems.find((i) => i.id === resolvedItem.id);
  assert.equal(updatedRejected?.status, "rejected", "rejected item should keep its status");
  assert.equal(updatedResolved?.status, "resolved", "resolved item should keep its status");

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR skips run when no items are pending or queued", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const rejectedItem = makeFeedbackItem({ status: "rejected", decision: "reject" });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [rejectedItem],
    accepted: 0,
    rejected: 1,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let evaluateCallCount = 0;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [rejectedItem],
      fetchPullSummary: async () => makePullSummary(pr),
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => {
        evaluateCallCount += 1;
        return { needsFix: true, reason: "Should not be called" };
      },
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  assert.equal(evaluateCallCount, 0, "evaluateFixNecessityWithAgent should not be called when no pending items");
  assert.equal(updated?.status, "watching");

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR suppresses docs assessment and docs remediation when autoUpdateDocs is disabled", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const pr = await storage.addPR({
    number: 106,
    title: "Docs toggle off",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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
    docsAssessment: {
      headSha: "abc123",
      status: "needed",
      summary: "README should be updated",
      assessedAt: "2026-03-28T10:00:00.000Z",
    },
  });

  let evaluateCalls = 0;
  let applyCalled = false;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
      listFailingStatuses: async () => [],
      checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => {
        evaluateCalls += 1;
        return { needsFix: true, reason: "Should not run when docs automation is disabled" };
      },
      applyFixesWithAgent: async () => {
        applyCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  assert.equal(evaluateCalls, 0);
  assert.equal(applyCalled, false);
  assert.equal(updated?.status, "watching");
  assert.ok(!logs.some((log) => log.phase === "evaluate.docs"));
});

test("babysitPR reuses same-SHA docsAssessment needed without reassessing", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Cached docs needed",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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
    docsAssessment: {
      headSha: "abc123",
      status: "needed",
      summary: "README and configuration docs should be updated",
      assessedAt: "2026-03-28T10:00:00.000Z",
    },
  });

  let evaluateCalls = 0;
  let applyCalled = false;
  let capturedPrompt = "";

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => [],
        fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postStatusReplyForFeedbackItem: async () => null,
        updateStatusReply: async () => {},
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => {
          evaluateCalls += 1;
          return { needsFix: false, reason: "Should not reassess for same SHA" };
        },
        applyFixesWithAgent: async ({ prompt }) => {
          applyCalled = true;
          capturedPrompt = prompt;
          const output = [
            "DOCS_SUMMARY_START changed",
            "Updated README and configuration docs.",
            "DOCS_SUMMARY_END",
          ].join("\n");
          return { code: 0, stdout: `${output}\n`, stderr: "" };
        },
        runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const logs = await storage.getLogs(pr.id);
    assert.equal(evaluateCalls, 0);
    assert.equal(applyCalled, true);
    assert.match(capturedPrompt, /Approved documentation tasks:/);
    assert.match(capturedPrompt, /README and configuration docs should be updated/);
    assert.match(capturedPrompt, /DOCS_SUMMARY_START <changed\|no_change>/);
    assert.ok(logs.some((log) => log.phase === "evaluate.docs" && log.message.includes("(needed)")));
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR reuses same-SHA docsAssessment not_needed and skips agent work", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Cached docs not needed",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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
    docsAssessment: {
      headSha: "abc123",
      status: "not_needed",
      summary: "No docs changes required",
      assessedAt: "2026-03-28T10:00:00.000Z",
    },
  });

  let evaluateCalls = 0;
  let applyCalled = false;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
      listFailingStatuses: async () => [],
      checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => undefined,
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => {
        evaluateCalls += 1;
        return { needsFix: true, reason: "Should not run for not_needed same SHA" };
      },
      applyFixesWithAgent: async () => {
        applyCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const logs = await storage.getLogs(pr.id);
  assert.equal(evaluateCalls, 0);
  assert.equal(applyCalled, false);
  assert.ok(logs.some((log) => log.phase === "evaluate.docs" && log.message.includes("(not_needed)")));
});

test("babysitPR reassesses docs when the head SHA changes", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Head moved docs reassessment",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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
    docsAssessment: {
      headSha: "abc123",
      status: "not_needed",
      summary: "No docs changes required for the previous head",
      assessedAt: "2026-03-28T10:00:00.000Z",
    },
  });

  let evaluateCalls = 0;
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => [],
        fetchPullSummary: async () => makePullSummary(pr, { headSha: "def456" }),
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postStatusReplyForFeedbackItem: async () => null,
        updateStatusReply: async () => {},
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => {
          evaluateCalls += 1;
          return { needsFix: false, reason: "Docs are still accurate for the new head SHA" };
        },
        applyFixesWithAgent: async () => {
          throw new Error("Should not run the agent when reassessment returns not_needed");
        },
        runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const updated = await storage.getPR(pr.id);
    assert.equal(evaluateCalls, 1);
    assert.equal(updated?.docsAssessment?.headSha, "def456");
    assert.equal(updated?.docsAssessment?.status, "not_needed");
    assert.match(updated?.docsAssessment?.summary || "", /new head SHA/);
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR retries docs assessment for same-SHA failed state", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Retry failed docs assessment",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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
    docsAssessment: {
      headSha: "abc123",
      status: "failed",
      summary: "Previous docs evaluation timed out",
      assessedAt: "2026-03-28T10:00:00.000Z",
    },
  });

  let evaluateCalls = 0;
  let applyCalled = false;
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => [],
        fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postStatusReplyForFeedbackItem: async () => null,
        updateStatusReply: async () => {},
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => {
          evaluateCalls += 1;
          return { needsFix: false, reason: "No docs updates required after retry" };
        },
        applyFixesWithAgent: async () => {
          applyCalled = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const updated = await storage.getPR(pr.id);
    assert.equal(evaluateCalls, 1);
    assert.equal(applyCalled, false);
    assert.equal(updated?.docsAssessment?.headSha, "abc123");
    assert.equal(updated?.docsAssessment?.status, "not_needed");
    assert.match(updated?.docsAssessment?.summary || "", /No docs updates required/);
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR runs agent for docs-only work when docs assessment says needed", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Docs-only remediation",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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

  let evaluateCalls = 0;
  let applyCalled = false;
  let capturedPrompt = "";
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => [],
        fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postStatusReplyForFeedbackItem: async () => null,
        updateStatusReply: async () => {},
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => {
          evaluateCalls += 1;
          return { needsFix: true, reason: "README and API docs need updates" };
        },
        applyFixesWithAgent: async ({ prompt }) => {
          applyCalled = true;
          capturedPrompt = prompt;
          const output = [
            "DOCS_SUMMARY_START changed",
            "Updated README and API docs.",
            "DOCS_SUMMARY_END",
          ].join("\n");
          return { code: 0, stdout: `${output}\n`, stderr: "" };
        },
        runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const updated = await storage.getPR(pr.id);
    assert.equal(evaluateCalls, 1);
    assert.equal(applyCalled, true);
    assert.equal(updated?.docsAssessment?.status, "needed");
    assert.match(capturedPrompt, /Approved documentation tasks:/);
    assert.match(capturedPrompt, /README and API docs need updates/);
    assert.match(capturedPrompt, /DOCS_SUMMARY_START <changed\|no_change>/);
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR allows docs no_change outcome after inspection", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Docs no-change outcome",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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
    docsAssessment: {
      headSha: "abc123",
      status: "needed",
      summary: "README may need an update",
      assessedAt: "2026-03-28T10:00:00.000Z",
    },
  });

  let applyCalls = 0;
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => [],
        fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postStatusReplyForFeedbackItem: async () => null,
        updateStatusReply: async () => {},
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async () => {
          throw new Error("Should not reassess for same SHA");
        },
        applyFixesWithAgent: async () => {
          applyCalls += 1;
          const output = [
            "DOCS_SUMMARY_START no_change",
            "The existing README already explains this behavior accurately.",
            "DOCS_SUMMARY_END",
          ].join("\n");
          return { code: 0, stdout: `${output}\n`, stderr: "" };
        },
        runCommand: makeGitRunCommand({ localHeadSha: "abc123", remoteHeadSha: "abc123" }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");
    await babysitter.babysitPR(pr.id, "codex");

    const updated = await storage.getPR(pr.id);
    const logs = await storage.getLogs(pr.id);
    assert.equal(applyCalls, 1);
    assert.equal(updated?.status, "watching");
    assert.equal(updated?.docsAssessment?.status, "not_needed");
    assert.equal(updated?.docsAssessment?.headSha, "abc123");
    assert.match(updated?.docsAssessment?.summary || "", /already explains this behavior accurately/);
    assert.ok(logs.some((log) => log.phase === "verify.docs" && log.message.includes("no_change")));
    assert.ok(logs.some((log) => log.phase === "evaluate.docs" && log.message.includes("(not_needed)")));
    assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("no necessary fixes identified")));
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR continues comment remediation when docs assessment fails", async () => {
  const storage = new MemStorage();
  const existingItem = makeFeedbackItem();
  const pr = await storage.addPR({
    number: 106,
    title: "Docs assessment failure isolation",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let feedbackFetchCount = 0;
  let applyCalled = false;
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`def456\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>def456</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  try {
    const babysitter = new PRBabysitter(
      storage,
      {
        buildOctokit: async () => ({}) as never,
        fetchFeedbackItemsForPR: async () => {
          feedbackFetchCount += 1;
          if (feedbackFetchCount === 1) {
            return [existingItem];
          }
          return [{ ...existingItem, threadResolved: true }, followUp];
        },
        fetchPullSummary: async () => makePullSummary(pr, { headSha: "abc123" }),
        listFailingStatuses: async () => [],
        checkCISettled: async () => true,
        listOpenPullsForRepo: async () => [],
        postFollowUpForFeedbackItem: async () => undefined,
        resolveReviewThread: async () => undefined,
        resolveGitHubAuthToken: async () => "test-token",
        addReactionToComment: async () => {},
        postStatusReplyForFeedbackItem: async () => null,
        updateStatusReply: async () => {},
      },
      {
        resolveAgent: async () => "codex",
        ciPollIntervalMs: 0,
        evaluateFixNecessityWithAgent: async ({ prompt }) => {
          if (prompt.includes("requires repository documentation updates")) {
            throw new Error("docs assessment exploded");
          }
          return { needsFix: true, reason: "Comment requires a code change" };
        },
        applyFixesWithAgent: async ({ onStdoutChunk, onStderrChunk }) => {
          applyCalled = true;
          const output = [
            "FEEDBACK_SUMMARY_START codefactory-feedback:gh-review-comment-1",
            "Applied requested rename.",
            "FEEDBACK_SUMMARY_END",
          ].join("\n");
          onStdoutChunk?.(`${output}\n`);
          onStderrChunk?.("");
          return { code: 0, stdout: `${output}\n`, stderr: "" };
        },
        runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
      },
    );

    await babysitter.babysitPR(pr.id, "codex");

    const updated = await storage.getPR(pr.id);
    const logs = await storage.getLogs(pr.id);
    assert.equal(applyCalled, true);
    assert.equal(updated?.status, "watching");
    assert.equal(updated?.docsAssessment?.status, "failed");
    assert.match(updated?.docsAssessment?.summary || "", /docs assessment exploded/);
    assert.ok(logs.some((log) => log.phase === "evaluate.docs" && log.message.includes("Documentation assessment failed")));
  } finally {
    delete process.env.CODEFACTORY_HOME;
  }
});

test("babysitPR retries accepted in-progress feedback items that still need GitHub follow-up without rerunning the agent", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Already fixed in a previous run",
    action: "Please rename this variable.",
    status: "in_progress",
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let feedbackFetchCount = 0;
  let applyCalled = false;
  const postedFollowUps: Array<{ id: string; body: string }> = [];
  const resolvedThreads: string[] = [];
  const pullSummary = makePullSummary(pr);
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>abc123</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem];
        }

        return [
          { ...existingItem, threadResolved: true },
          followUp,
        ];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body, options) => {
        postedFollowUps.push({ id: item.id, body });
        if (options?.resolve && item.threadId) {
          resolvedThreads.push(item.threadId);
        }
      },
      resolveReviewThread: async (_octokit, _parsed, threadId) => {
        resolvedThreads.push(threadId);
      },
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No new code change required",
      }),
      applyFixesWithAgent: async () => {
        applyCalled = true;
        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);
  const updatedItem = updated?.feedbackItems.find((item) => item.id === existingItem.id);

  assert.equal(applyCalled, false);
  assert.equal(updated?.status, "watching");
  assert.equal(updatedItem?.status, "resolved");
  assert.deepEqual(postedFollowUps, [
    {
      id: "gh-review-comment-1",
      body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n<!-- codefactory-feedback:gh-review-comment-1 -->\n\n${APP_COMMENT_FOOTER}`,
    },
  ]);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
  assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("awaiting GitHub follow-up")));
});

test("resumeInterruptedRuns replays the persisted prompt when the PR head has not moved", async () => {
  const storage = new MemStorage();
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Recovery replay",
    action: "Please rename this variable.",
    status: "in_progress",
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  await storage.upsertAgentRun({
    id: "run-replay-1",
    prId: pr.id,
    preferredAgent: "codex",
    resolvedAgent: "codex",
    status: "running",
    phase: "run.agent-running",
    prompt: "REPLAY EXACT PROMPT",
    initialHeadSha: "abc123",
    metadata: { recoveryMode: true },
    lastError: null,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  });

  let capturedPrompt = "";
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr, { headSha: "abc123" });
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`def456\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>def456</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem];
        }
        return [{ ...existingItem, threadResolved: true }, followUp];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => undefined,
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => undefined,
      postPRComment: async () => undefined,
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "No new evaluation needed" }),
      applyFixesWithAgent: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { code: 0, stdout: "", stderr: "" };
      },
      runCommand: makeGitRunCommand({ localHeadSha: "def456", remoteHeadSha: "def456" }),
    },
  );

  await babysitter.resumeInterruptedRuns();

  const run = await storage.getAgentRun("run-replay-1");
  assert.equal(capturedPrompt, "REPLAY EXACT PROMPT");
  assert.equal(run?.status, "completed");
  assert.equal(run?.phase, "run.completed");

  delete process.env.CODEFACTORY_HOME;
});

test("resumeInterruptedRuns skips prompt replay when the PR head already moved", async () => {
  const storage = new MemStorage();
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Recovery replay",
    action: "Please rename this variable.",
    status: "in_progress",
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });
  await storage.upsertAgentRun({
    id: "run-replay-2",
    prId: pr.id,
    preferredAgent: "codex",
    resolvedAgent: "codex",
    status: "running",
    phase: "run.agent-running",
    prompt: "REPLAY EXACT PROMPT",
    initialHeadSha: "abc123",
    metadata: { recoveryMode: true },
    lastError: null,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  });

  let applyCalled = false;
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr, { headSha: "moved999" });
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`moved99\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>moved99</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem];
        }
        return [{ ...existingItem, threadResolved: true }, followUp];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => undefined,
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => undefined,
      postPRComment: async () => undefined,
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "No new evaluation needed" }),
      applyFixesWithAgent: async () => {
        applyCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      runCommand: makeGitRunCommand({ localHeadSha: "moved999", remoteHeadSha: "moved999" }),
    },
  );

  await babysitter.resumeInterruptedRuns();

  const run = await storage.getAgentRun("run-replay-2");
  const logs = await storage.getLogs(pr.id);
  assert.equal(applyCalled, false);
  assert.equal(run?.status, "completed");
  assert.ok(logs.some((log) => log.phase === "run.replay" && log.message.includes("Skipping forced prompt replay")));

  delete process.env.CODEFACTORY_HOME;
});

test("resumeInterruptedRuns enqueues babysit_pr jobs when a background scheduler is provided", async () => {
  const storage = new MemStorage();
  const backgroundJobQueue = new BackgroundJobQueue(storage);
  const pr = await storage.addPR({
    number: 106,
    title: "Queued recovery PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/queued-recovery",
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
  await storage.upsertAgentRun({
    id: "run-replay-queued",
    prId: pr.id,
    preferredAgent: "codex",
    resolvedAgent: "codex",
    status: "running",
    phase: "run.agent-running",
    prompt: "REPLAY EXACT PROMPT",
    initialHeadSha: "abc123",
    metadata: { recoveryMode: true },
    lastError: null,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  });

  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService(),
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    undefined,
    async (...args) => backgroundJobQueue.enqueue(...args),
  );

  await babysitter.resumeInterruptedRuns();

  const jobs = await storage.listBackgroundJobs({
    kind: "babysit_pr",
    targetId: pr.id,
    status: "queued",
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.preferredAgent, "codex");
});

test("babysitPR resolves lingering review threads without reposting an existing audit trail", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Already fixed in a previous run",
    action: "Please rename this variable.",
    status: "in_progress",
  });
  const priorFollowUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>abc123</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: false,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "resolved",
    statusReason: null,
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem, priorFollowUp],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let feedbackFetchCount = 0;
  let applyCalled = false;
  const postedFollowUps: Array<{ id: string; body: string }> = [];
  const resolvedThreads: string[] = [];
  const pullSummary = makePullSummary(pr);

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem, priorFollowUp];
        }

        return [
          { ...existingItem, threadResolved: true },
          priorFollowUp,
        ];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body, options) => {
        postedFollowUps.push({ id: item.id, body });
        if (options?.resolve && item.threadId) {
          resolvedThreads.push(item.threadId);
        }
      },
      resolveReviewThread: async (_octokit, _parsed, threadId) => {
        resolvedThreads.push(threadId);
      },
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No new code change required",
      }),
      applyFixesWithAgent: async () => {
        applyCalled = true;
        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const updatedItem = updated?.feedbackItems.find((item) => item.id === existingItem.id);

  assert.equal(applyCalled, false);
  assert.equal(updated?.status, "watching");
  assert.equal(updatedItem?.status, "resolved");
  assert.deepEqual(postedFollowUps, []);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
});

test("babysitPR reposts GitHub follow-up when an earlier audit trail used the wrong thread", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Already fixed in a previous run",
    action: "Please rename this variable.",
    status: "in_progress",
  });
  const priorFollowUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>abc123</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: "PRRT_kwDO_other_thread",
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-2",
    decision: null,
    decisionReason: null,
    action: null,
    status: "resolved",
    statusReason: null,
  });
  const correctedFollowUp = makeFeedbackItem({
    id: "gh-review-comment-3",
    author: "code-factory",
    body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed in commit <code>abc123</code> by the latest babysitter run.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "3",
    sourceNodeId: "PRRC_kwDO_followup_corrected",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r3",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    auditToken: "codefactory-feedback:gh-review-comment-3",
    decision: null,
    decisionReason: null,
    action: null,
    status: "pending",
    statusReason: null,
  });
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem, priorFollowUp],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let feedbackFetchCount = 0;
  let applyCalled = false;
  const postedFollowUps: Array<{ id: string; body: string }> = [];
  const resolvedThreads: string[] = [];
  const pullSummary = makePullSummary(pr);

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem, priorFollowUp];
        }

        return [
          { ...existingItem, threadResolved: true },
          priorFollowUp,
          correctedFollowUp,
        ];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body, options) => {
        postedFollowUps.push({ id: item.id, body });
        if (options?.resolve && item.threadId) {
          resolvedThreads.push(item.threadId);
        }
      },
      resolveReviewThread: async (_octokit, _parsed, threadId) => {
        resolvedThreads.push(threadId);
      },
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No new code change required",
      }),
      applyFixesWithAgent: async () => {
        applyCalled = true;
        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      },
      runCommand: makeGitRunCommand(),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const updatedItem = updated?.feedbackItems.find((item) => item.id === existingItem.id);

  assert.equal(applyCalled, false);
  assert.equal(updated?.status, "watching");
  assert.equal(updatedItem?.status, "resolved");
  assert.deepEqual(postedFollowUps, [
    {
      id: "gh-review-comment-1",
      body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n<!-- codefactory-feedback:gh-review-comment-1 -->\n\n${APP_COMMENT_FOOTER}`,
    },
  ]);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
});

test("babysitPR resolves merge conflicts when PR is not mergeable", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  let conflictAgentPrompt = "";
  let fixAgentCalled = false;
  const pullSummary = makePullSummary(pr, { mergeable: false });
  const mergeAttempted = { value: false };

  const gitRunner = makeGitRunCommand({
    localHeadSha: "merge123",
    remoteHeadSha: "merge123",
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No fix needed",
      }),
      applyFixesWithAgent: async ({ prompt, onStdoutChunk, onStderrChunk }) => {
        if (prompt.includes("merge conflicts")) {
          conflictAgentPrompt = prompt;
          onStdoutChunk?.("resolved conflicts\n");
          onStderrChunk?.("");
          return { code: 0, stdout: "resolved conflicts\n", stderr: "" };
        }
        fixAgentCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      runCommand: async (command: string, args: string[], opts?: Record<string, unknown>) => {
        if (command === "git" && args[0] === "merge") {
          mergeAttempted.value = true;
          return { code: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in src/example.ts" };
        }
        if (command === "git" && args[0] === "diff" && args[1] === "--name-only" && args[2] === "--diff-filter=U") {
          return { code: 0, stdout: "src/example.ts\n", stderr: "" };
        }
        return gitRunner(command, args, opts);
      },
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(mergeAttempted.value, true);
  assert.equal(updated?.status, "watching");
  assert.equal(fixAgentCalled, false, "Should not run the fix agent when there are no comment/status tasks");
  assert.match(conflictAgentPrompt, /merge conflicts/i);
  assert.match(conflictAgentPrompt, /src\/example\.ts/);
  assert.ok(logs.some((log) => log.phase === "conflict" && log.message.includes("merge conflicts")));
  assert.ok(logs.some((log) => log.phase === "conflict.agent" && log.message.includes("merge conflict resolution")));

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR pushes a clean base merge when GitHub mergeability is stale", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  const pullSummary = makePullSummary(pr, { mergeable: false });
  const pushedCommands: string[][] = [];
  const gitRunner = makeGitRunCommand({
    localHeadSha: "merge123",
    remoteHeadSha: "merge123",
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No fix needed",
      }),
      applyFixesWithAgent: async () => {
        throw new Error("conflict agent should not run for a clean merge");
      },
      runCommand: async (command: string, args: string[], opts?: Record<string, unknown>) => {
        if (command === "git" && args[0] === "merge") {
          return { code: 0, stdout: "Merge made by the 'ort' strategy.\n", stderr: "" };
        }
        if (command === "git" && args[0] === "push") {
          pushedCommands.push(args);
        }
        return gitRunner(command, args, opts);
      },
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(updated?.status, "watching");
  assert.deepEqual(pushedCommands, [["push", "origin", "HEAD:feature/verbose"]]);
  assert.ok(logs.some((log) => log.phase === "conflict" && log.message.includes("Merge completed without conflicts")));
  assert.ok(logs.some((log) => log.phase === "conflict" && log.message.includes("Pushed merge result")));

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR skips conflict resolution when PR is mergeable", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoUpdateDocs: false });
  const existingItem = makeFeedbackItem();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/106",
    status: "watching",
    feedbackItems: [existingItem],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  let mergeAttempted = false;
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr, { mergeable: true });
  const followUp = makeFeedbackItem({
    id: "gh-review-comment-2",
    author: "code-factory",
    body: `Addressed in commit \`abc123\` by the latest babysitter run.\n\n${existingItem.auditToken}`,
    bodyHtml: `<p>Addressed.</p><p>${existingItem.auditToken}</p>`,
    sourceId: "2",
    sourceNodeId: "PRRC_kwDO_followup",
    sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r2",
    threadId: existingItem.threadId,
    threadResolved: true,
    createdAt: new Date().toISOString(),
    decision: null,
    decisionReason: null,
    action: null,
  });

  const gitRunner = makeGitRunCommand({
    localHeadSha: "def456",
    remoteHeadSha: "def456",
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) return [existingItem];
        return [{ ...existingItem, threadResolved: true }, followUp];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: true,
        reason: "Comment requires a code change",
      }),
      applyFixesWithAgent: async ({ onStdoutChunk, onStderrChunk }) => {
        onStdoutChunk?.("applied fix\n");
        onStderrChunk?.("");
        return { code: 0, stdout: "applied fix\n", stderr: "" };
      },
      runCommand: async (command: string, args: string[], opts?: Record<string, unknown>) => {
        if (command === "git" && args[0] === "merge") {
          mergeAttempted = true;
        }
        return gitRunner(command, args, opts);
      },
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(mergeAttempted, false, "Should not attempt merge when PR is mergeable");
  assert.equal(updated?.status, "watching");
  assert.ok(!logs.some((log) => log.phase === "conflict"));

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR errors when conflict resolution agent fails", async () => {
  const storage = new MemStorage();
  const pr = await storage.addPR({
    number: 106,
    title: "Verbose PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/verbose",
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

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;
  const pullSummary = makePullSummary(pr, { mergeable: false });

  const gitRunner = makeGitRunCommand({
    localHeadSha: "abc123",
    remoteHeadSha: "abc123",
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
    checkCISettled: async () => true,
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      ciPollIntervalMs: 0,
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No fix needed",
      }),
      applyFixesWithAgent: async () => {
        return { code: 1, stdout: "", stderr: "agent crashed" };
      },
      runCommand: async (command: string, args: string[], opts?: Record<string, unknown>) => {
        if (command === "git" && args[0] === "merge") {
          return { code: 1, stdout: "", stderr: "CONFLICT" };
        }
        if (command === "git" && args[0] === "diff" && args[1] === "--name-only" && args[2] === "--diff-filter=U") {
          return { code: 0, stdout: "src/conflict.ts\n", stderr: "" };
        }
        return gitRunner(command, args, opts);
      },
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(updated?.status, "error");
  assert.ok(logs.some((log) => log.level === "error" && log.message.includes("merge conflicts")));

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR skips conflict resolution when autoResolveMergeConflicts is disabled", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoResolveMergeConflicts: false, autoUpdateDocs: false });
  const pr = await storage.addPR({
    number: 107,
    title: "Conflict skip PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/conflict-skip",
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

  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "codefactory-home-"));
  process.env.CODEFACTORY_HOME = worktreeRoot;

  let mergeAttempted = false;
  let conflictAgentCalled = false;
  const pullSummary = makePullSummary(pr, { mergeable: false });

  const gitRunner = makeGitRunCommand({
    localHeadSha: "skip123",
    remoteHeadSha: "skip123",
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => [],
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => undefined,
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
      addReactionToComment: async () => {},
      postStatusReplyForFeedbackItem: async () => null,
      updateStatusReply: async () => {},
    },
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({
        needsFix: false,
        reason: "No fix needed",
      }),
      applyFixesWithAgent: async () => {
        conflictAgentCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      runCommand: async (command: string, args: string[], opts?: Record<string, unknown>) => {
        if (command === "git" && args[0] === "merge") {
          mergeAttempted = true;
          return { code: 1, stdout: "", stderr: "CONFLICT" };
        }
        return gitRunner(command, args, opts);
      },
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const updated = await storage.getPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(mergeAttempted, false, "Should not attempt merge when auto-resolve is disabled");
  assert.equal(conflictAgentCalled, false, "Should not invoke conflict agent when auto-resolve is disabled");
  assert.equal(updated?.status, "watching");
  assert.ok(logs.some((log) => log.phase === "conflict" && log.message.includes("auto-resolve is disabled")));

  delete process.env.CODEFACTORY_HOME;
});

test("syncAndBabysitTrackedRepos creates a healing session for failing watched PR checks", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    watchedRepos: ["alex-morgan-o/lolodex"],
    autoHealCI: false,
    autoUpdateDocs: false,
  });

  const pullUrl = "https://github.com/alex-morgan-o/lolodex/pull/106";
  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [{
        number: 106,
        title: "Verbose PR",
        branch: "feature/verbose",
        author: "octocat",
        url: pullUrl,
      }],
      fetchPullSummary: async () => makePullSummary({ url: pullUrl }),
      fetchCheckSnapshotsForRef: async (_octokit: unknown, _repo: unknown, prId: string, headSha: string) => [
        makeCheckSnapshot({ prId, sha: headSha }),
      ],
    }),
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const prs = await storage.getPRs();
  assert.equal(prs.length, 1);

  const sessions = await storage.listHealingSessions({ prId: prs[0]?.id });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.state, "awaiting_repair_slot");
  assert.equal(sessions[0]?.initialHeadSha, "abc123");
});

test("syncAndBabysitTrackedRepos auto-registers only the authenticated user's PRs by default", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    watchedRepos: ["alex-morgan-o/lolodex"],
    autoUpdateDocs: false,
  });

  const queuedTargets: string[] = [];
  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [
        {
          number: 106,
          title: "My PR",
          branch: "feature/mine",
          author: "octocat",
          url: "https://github.com/alex-morgan-o/lolodex/pull/106",
        },
        {
          number: 107,
          title: "Teammate PR",
          branch: "feature/teammate",
          author: "teammate",
          url: "https://github.com/alex-morgan-o/lolodex/pull/107",
        },
      ],
    }),
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    undefined,
    async (_kind, targetId) => {
      queuedTargets.push(targetId);
      return {} as never;
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const prs = await storage.getPRs();
  assert.equal(prs.length, 1);
  assert.equal(prs[0]?.number, 106);
  assert.equal(prs[0]?.author, "octocat");
  assert.deepEqual(queuedTargets, [prs[0]!.id]);
});

test("syncAndBabysitTrackedRepos can include teammate PRs when repo setting disables own-only filtering", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    watchedRepos: ["alex-morgan-o/lolodex"],
    autoUpdateDocs: false,
  });
  await storage.updateRepoSettings("alex-morgan-o/lolodex", {
    ownPrsOnly: false,
  });

  const queuedTargets: string[] = [];
  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [
        {
          number: 108,
          title: "My PR",
          branch: "feature/mine",
          author: "octocat",
          url: "https://github.com/alex-morgan-o/lolodex/pull/108",
        },
        {
          number: 109,
          title: "Teammate PR",
          branch: "feature/teammate",
          author: "teammate",
          url: "https://github.com/alex-morgan-o/lolodex/pull/109",
        },
      ],
    }),
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    undefined,
    async (_kind, targetId) => {
      queuedTargets.push(targetId);
      return {} as never;
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const prs = await storage.getPRs();
  assert.equal(prs.length, 2);
  assert.deepEqual(prs.map((pr) => pr.number).sort((a, b) => a - b), [108, 109]);
  assert.equal(queuedTargets.length, 2);
});

test("syncAndBabysitTrackedRepos keeps explicitly tracked teammate PRs active when own-only filtering is enabled", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    watchedRepos: ["alex-morgan-o/lolodex"],
    autoUpdateDocs: false,
  });
  await storage.updateRepoSettings("alex-morgan-o/lolodex", {
    ownPrsOnly: true,
  });

  const tracked = await storage.addPR({
    number: 110,
    title: "Tracked teammate PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/teammate",
    author: "teammate",
    url: "https://github.com/alex-morgan-o/lolodex/pull/110",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const queuedTargets: string[] = [];
  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [
        {
          number: 110,
          title: "Tracked teammate PR",
          branch: "feature/teammate",
          author: "teammate",
          url: "https://github.com/alex-morgan-o/lolodex/pull/110",
        },
      ],
    }),
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
    undefined,
    async (_kind, targetId) => {
      queuedTargets.push(targetId);
      return {} as never;
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const updated = await storage.getPR(tracked.id);
  assert.equal(updated?.status, "watching");
  assert.deepEqual(queuedTargets, [tracked.id]);
});

test("syncAndBabysitTrackedRepos uses the injected clock for fallback healing snapshots", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    watchedRepos: ["alex-morgan-o/lolodex"],
    autoHealCI: false,
    autoUpdateDocs: false,
  });

  const pullUrl = "https://github.com/alex-morgan-o/lolodex/pull/107";
  const observedAt = "2026-04-02T15:04:05.000Z";
  const babysitter = new PRBabysitter(
    storage,
    makeWatcherGitHubService({
      listOpenPullsForRepo: async () => [{
        number: 107,
        title: "Fallback snapshots",
        branch: "feature/fallback-snapshots",
        author: "octocat",
        url: pullUrl,
      }],
      fetchPullSummary: async () => makePullSummary({ url: pullUrl }),
      listFailingStatuses: async () => [{
        context: "build",
        description: "TypeScript compilation failed",
        targetUrl: "https://github.com/octo/example/actions/runs/1",
      }],
    }),
    {
      now: () => new Date(observedAt),
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );

  await babysitter.syncAndBabysitTrackedRepos();

  const prs = await storage.getPRs();
  const snapshots = await storage.listCheckSnapshots({ prId: prs[0]?.id, sha: "abc123" });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.observedAt, observedAt);
});

test("babysitPR blocks external CI failures without launching the healing agent", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoHealCI: true, autoUpdateDocs: false });
  const pr = await storage.addPR({
    number: 42,
    title: "Blocked CI",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/blocked-ci",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  let healingAgentCalled = false;
  const babysitter = new PRBabysitter(
    storage,
    {
      ...makeWatcherGitHubService(),
      fetchPullSummary: async () => makePullSummary(pr, { headSha: "blocked123", headRef: pr.branch, branch: pr.branch }),
      fetchCheckSnapshotsForRef: async (_octokit: unknown, _repo: unknown, prId: string, headSha: string) => [
        makeCheckSnapshot({
          prId,
          sha: headSha,
          description: "Missing GitHub token secret",
        }),
      ],
    },
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCIHealingRepairAttempt: async () => {
        healingAgentCalled = true;
        throw new Error("healing agent should not run for blocked failures");
      },
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const sessions = await storage.listHealingSessions({ prId: pr.id });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.state, "blocked");
  assert.match(sessions[0]?.blockedReason ?? "", /external ci failure/i);
  assert.equal(healingAgentCalled, false);
});

test("babysitPR marks a healing session healed when the repair push turns CI green", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoHealCI: true, autoUpdateDocs: false });
  const pr = await storage.addPR({
    number: 43,
    title: "Heal CI",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/heal-ci",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/43",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const initialFingerprint = "github.check_run:typescript:build";
  const babysitter = new PRBabysitter(
    storage,
    {
      ...makeWatcherGitHubService(),
      fetchPullSummary: async () => makePullSummary(pr, { headSha: "heal123", headRef: pr.branch, branch: pr.branch }),
      fetchCheckSnapshotsForRef: async (_octokit: unknown, _repo: unknown, prId: string, headSha: string) => {
        if (headSha === "heal123") {
          return [makeCheckSnapshot({ prId, sha: headSha })];
        }
        return [];
      },
      checkCISettled: async () => true,
      listFailingStatuses: async () => [],
    },
    {
      ciPollIntervalMs: 0,
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCIHealingRepairAttempt: async () => ({
        accepted: true,
        rejectionReason: null,
        summary: "fixed the TypeScript error and pushed",
        prompt: "repair prompt",
        promptDigest: "d".repeat(64),
        agentResult: { code: 0, stdout: "ok", stderr: "" },
        verification: {
          inputHeadSha: "heal123",
          localHeadSha: "heal456",
          remoteHeadSha: "heal456",
          localCommitCreated: true,
          worktreeDirty: false,
          branchMoved: true,
          pushedNewSha: true,
        },
        targetFingerprints: [initialFingerprint],
        classifiedFailures: [],
        worktreePath: "/tmp/worktree",
        repoCacheDir: "/tmp/repo-cache",
        remoteName: "origin",
        agent: "codex",
        headRef: pr.branch,
        baseRef: "main",
        prNumber: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        branch: pr.branch,
      }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const sessions = await storage.listHealingSessions({ prId: pr.id });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.state, "healed");
  assert.equal(sessions[0]?.currentHeadSha, "heal456");

  const attempts = await storage.listHealingAttempts({ sessionId: sessions[0]?.id });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, "verified");
  assert.equal(attempts[0]?.outputSha, "heal456");

  const updated = await storage.getPR(pr.id);
  assert.equal(updated?.testsPassed, true);
});

test("babysitPR escalates a healing session when the repaired commit still has the same failing fingerprint", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoHealCI: true, autoUpdateDocs: false });
  const pr = await storage.addPR({
    number: 44,
    title: "Unchanged CI",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/unchanged-ci",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/44",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const postedComments: string[] = [];
  const babysitter = new PRBabysitter(
    storage,
    {
      ...makeWatcherGitHubService(),
      fetchPullSummary: async () => makePullSummary(pr, { headSha: "same123", headRef: pr.branch, branch: pr.branch }),
      fetchCheckSnapshotsForRef: async (_octokit: unknown, _repo: unknown, prId: string, headSha: string) => [
        makeCheckSnapshot({ prId, sha: headSha }),
      ],
      checkCISettled: async () => true,
      listFailingStatuses: async () => [{
        context: "build",
        description: "TypeScript compilation failed",
        targetUrl: "https://github.com/octo/example/actions/runs/1",
      }],
      postPRComment: async (_octokit: unknown, _parsedPr: unknown, body: string) => {
        postedComments.push(body);
      },
    },
    {
      ciPollIntervalMs: 0,
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCIHealingRepairAttempt: async () => ({
        accepted: true,
        rejectionReason: null,
        summary: "attempted a fix and pushed",
        prompt: "repair prompt",
        promptDigest: "e".repeat(64),
        agentResult: { code: 0, stdout: "ok", stderr: "" },
        verification: {
          inputHeadSha: "same123",
          localHeadSha: "same456",
          remoteHeadSha: "same456",
          localCommitCreated: true,
          worktreeDirty: false,
          branchMoved: true,
          pushedNewSha: true,
        },
        targetFingerprints: ["github.check_run:typescript:build"],
        classifiedFailures: [],
        worktreePath: "/tmp/worktree",
        repoCacheDir: "/tmp/repo-cache",
        remoteName: "origin",
        agent: "codex",
        headRef: pr.branch,
        baseRef: "main",
        prNumber: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        branch: pr.branch,
      }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const sessions = await storage.listHealingSessions({ prId: pr.id });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.state, "escalated");
  assert.match(sessions[0]?.escalationReason ?? "", /unchanged or worsened/i);

  const attempts = await storage.listHealingAttempts({ sessionId: sessions[0]?.id });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, "verified");
  assert.ok((attempts[0]?.improvementScore ?? 1) <= 0);
  assert.ok(postedComments.some((body) => body.includes("[oh-my-pr](https://github.com/yungookim/oh-my-pr) CI Alert")));
  assert.ok(postedComments.every((body) => body.endsWith(APP_COMMENT_FOOTER)));

  const updated = await storage.getPR(pr.id);
  assert.equal(updated?.testsPassed, false);
});

test("babysitPR supersedes older healing sessions when the PR head SHA changes", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoHealCI: false, autoUpdateDocs: false });
  const pr = await storage.addPR({
    number: 45,
    title: "Moved head",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/moved-head",
    author: "octocat",
    url: "https://github.com/alex-morgan-o/lolodex/pull/45",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
  });

  const previous = await storage.createHealingSession({
    prId: pr.id,
    repo: pr.repo,
    prNumber: pr.number,
    initialHeadSha: "old123",
    currentHeadSha: "old123",
    state: "awaiting_repair_slot",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: "github.check_run:typescript:build",
    attemptCount: 0,
    lastImprovementScore: null,
  });

  const babysitter = new PRBabysitter(
    storage,
    {
      ...makeWatcherGitHubService(),
      fetchPullSummary: async () => makePullSummary(pr, { headSha: "new999", headRef: pr.branch, branch: pr.branch }),
      fetchCheckSnapshotsForRef: async (_octokit: unknown, _repo: unknown, prId: string, headSha: string) => [
        makeCheckSnapshot({ prId, sha: headSha }),
      ],
    },
    {
      resolveAgent: async () => "codex",
      evaluateFixNecessityWithAgent: async () => ({ needsFix: false, reason: "unused" }),
      applyFixesWithAgent: async () => ({ code: 0, stdout: "", stderr: "" }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  );

  await babysitter.babysitPR(pr.id, "codex");

  const oldSession = await storage.getHealingSession(previous.id);
  assert.equal(oldSession?.state, "superseded");
  assert.match(oldSession?.escalationReason ?? "", /PR head moved to new999/);

  const sessions = await storage.listHealingSessions({ prId: pr.id });
  assert.equal(sessions.length, 2);
  const active = sessions.find((session) => session.id !== previous.id);
  assert.equal(active?.initialHeadSha, "new999");
  assert.equal(active?.state, "awaiting_repair_slot");
});
