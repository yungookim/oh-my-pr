import { mkdtemp, mkdir } from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem } from "@shared/schema";
import { PRBabysitter } from "./babysitter";
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
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body) => {
        postedFollowUps.push({ id: item.id, body });
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
    "Babysitter preparing fix run with 1 comment task(s), 0 status task(s), and 1 GitHub follow-up task(s) using codex",
  );
  assert.equal(fixRunLog.metadata?.followUpTasks, 1);
  assert.deepEqual(postedFollowUps, [
    {
      id: "gh-review-comment-1",
      body: "Addressed in commit `def456` by the latest babysitter run.\n\nRenamed the variable from `foo` to `bar` as requested.\n\ncodefactory-feedback:gh-review-comment-1",
    },
  ]);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
  assert.ok(logs.some((log) => log.phase === "worktree" && log.message.includes(`Preparing worktree in ${worktreeRoot}`)));
  assert.ok(logs.some((log) => log.phase === "github.followup" && log.message.includes("GitHub follow-up complete for gh-review-comment-1")));
  assert.ok(logs.some((log) => log.phase === "verify.github" && log.message.includes("GitHub audit trail verified")));
  assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("Babysitter run complete")));
  assert.match(receivedPrompt, /commit it and push it to origin HEAD:feature\/verbose/i);
  assert.match(receivedPrompt, /GitHub follow-up replies and review-thread resolution will be handled by the babysitter/i);
  assert.match(receivedPrompt, /auditToken=codefactory-feedback:gh-review-comment-1/);
  assert.match(receivedPrompt, /FEEDBACK_SUMMARY_START/);
  assert.equal(receivedEnv?.GITHUB_TOKEN, "test-token");
  assert.equal(receivedEnv?.GH_TOKEN, "test-token");

  delete process.env.CODEFACTORY_HOME;
});

test("babysitPR centralizes status replies, logs best-effort failures, and updates replies in parallel", async () => {
  const storage = new MemStorage();
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
        createdAt: "2026-03-15T10:02:00.000Z",
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
        createdAt: "2026-03-15T10:03:00.000Z",
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
    const expectedAcceptedStatus = "\u23f3 **Accepted** \u2014 this comment requires code changes. Queuing fix...";
    const expectedFinalStatusBody = [
      expectedAcceptedStatus,
      "\ud83e\uddf0 **Agent running** \u2014 `codex` is working on the fix...",
      "\u2705 **Agent completed** \u2014 verifying changes...",
      "\ud83c\udf89 **Resolved** \u2014 addressed in commit `def456`.",
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

test("babysitPR retries accepted in-progress feedback items that still need GitHub follow-up without rerunning the agent", async () => {
  const storage = new MemStorage();
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
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body) => {
        postedFollowUps.push({ id: item.id, body });
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
      body: "Addressed in commit `abc123` by the latest babysitter run.\n\ncodefactory-feedback:gh-review-comment-1",
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

test("babysitPR resolves lingering review threads without reposting an existing audit trail", async () => {
  const storage = new MemStorage();
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
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body) => {
        postedFollowUps.push({ id: item.id, body });
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
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async (_octokit, _parsed, item, body) => {
        postedFollowUps.push({ id: item.id, body });
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
      body: "Addressed in commit `abc123` by the latest babysitter run.\n\ncodefactory-feedback:gh-review-comment-1",
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
