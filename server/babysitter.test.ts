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
    ...overrides,
  };
}

function makePullSummary(pr: { url: string }) {
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
  });

  const updated = await babysitter.syncFeedbackForPR(pr.id);
  const logs = await storage.getLogs(pr.id);

  assert.equal(updated.status, "watching");
  assert.equal(logs.at(-1)?.message, "GitHub sync complete: 1 feedback item (0 new)");
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

  assert.equal(updated?.status, "watching");
  assert.equal(updated?.accepted, 1);
  assert.deepEqual(postedFollowUps, [
    {
      id: "gh-review-comment-1",
      body: "Addressed in commit `def456` by the latest babysitter run.\n\ncodefactory-feedback:gh-review-comment-1",
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
  assert.equal(receivedEnv?.GITHUB_TOKEN, "test-token");
  assert.equal(receivedEnv?.GH_TOKEN, "test-token");

  delete process.env.CODEFACTORY_HOME;
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
  let feedbackFetchCount = 0;
  const pullSummary = makePullSummary(pr);
  let applyCalled = false;

  const babysitter = new PRBabysitter(
    storage,
    {
      buildOctokit: async () => ({}) as never,
      fetchFeedbackItemsForPR: async () => {
        feedbackFetchCount += 1;
        if (feedbackFetchCount === 1) {
          return [existingItem];
        }

        return [existingItem];
      },
      fetchPullSummary: async () => pullSummary,
      listFailingStatuses: async () => [],
      listOpenPullsForRepo: async () => [],
      postFollowUpForFeedbackItem: async () => {
        throw new Error("GitHub follow-up failed");
      },
      resolveReviewThread: async () => undefined,
      resolveGitHubAuthToken: async () => "test-token",
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

test("babysitPR retries accepted feedback items that still need GitHub follow-up without rerunning the agent", async () => {
  const storage = new MemStorage();
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Already fixed in a previous run",
    action: "Please rename this variable.",
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

  assert.equal(applyCalled, false);
  assert.equal(updated?.status, "watching");
  assert.deepEqual(postedFollowUps, [
    {
      id: "gh-review-comment-1",
      body: "Addressed in commit `abc123` by the latest babysitter run.\n\ncodefactory-feedback:gh-review-comment-1",
    },
  ]);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
  assert.ok(logs.some((log) => log.phase === "run" && log.message.includes("awaiting GitHub follow-up")));
});

test("babysitPR resolves lingering review threads without reposting an existing audit trail", async () => {
  const storage = new MemStorage();
  const existingItem = makeFeedbackItem({
    decision: "accept",
    decisionReason: "Already fixed in a previous run",
    action: "Please rename this variable.",
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
    decision: null,
    decisionReason: null,
    action: null,
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

  assert.equal(applyCalled, false);
  assert.equal(updated?.status, "watching");
  assert.deepEqual(postedFollowUps, []);
  assert.deepEqual(resolvedThreads, ["PRRT_kwDO_example"]);
});
