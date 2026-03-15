import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { SqliteStorage } from "./sqliteStorage";

test("SqliteStorage reloads config and PR state from the same root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codefactory-storage-"));
  const first = new SqliteStorage(root);
  await first.updateConfig({
    pollIntervalMs: 45000,
    watchedRepos: ["alex-morgan-o/lolodex"],
  });

  const pr = await first.addPR({
    number: 106,
    title: "Example PR",
    repo: "alex-morgan-o/lolodex",
    branch: "feature/test",
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
  await first.updatePR(pr.id, {
    feedbackItems: [
      {
        id: "feedback-1",
        author: "octocat",
        body: "Please fix `thing`",
        bodyHtml: "<p>Please fix <code>thing</code></p>",
        replyKind: "review_thread",
        sourceId: "101",
        sourceNodeId: "PRRC_kwDO_test",
        sourceUrl: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r101",
        threadId: "PRRT_kwDO_thread",
        threadResolved: false,
        auditToken: "codefactory-feedback:feedback-1",
        file: "src/app.ts",
        line: 42,
        type: "review_comment",
        createdAt: "2026-03-15T07:30:00.000Z",
        decision: "accept",
        decisionReason: "Actionable request",
        action: "Fix thing",
        status: "resolved",
        statusReason: "GitHub audit trail verified",
      },
    ],
    accepted: 1,
    rejected: 0,
    flagged: 0,
    lastChecked: "2026-03-15T07:31:00.000Z",
  });
  await first.addLog(pr.id, "info", "Agent started", {
    runId: "run-1",
    phase: "agent",
    metadata: { attempt: 1 },
  });
  first.close();

  const second = new SqliteStorage(root);
  const config = await second.getConfig();
  const reloadedPr = await second.getPR(pr.id);
  const logs = await second.getLogs(pr.id);

  assert.equal(config.pollIntervalMs, 45000);
  assert.deepEqual(config.watchedRepos, ["alex-morgan-o/lolodex"]);
  assert.equal(reloadedPr?.repo, "alex-morgan-o/lolodex");
  assert.equal(reloadedPr?.feedbackItems.length, 1);
  assert.equal(reloadedPr?.feedbackItems[0]?.bodyHtml, "<p>Please fix <code>thing</code></p>");
  assert.equal(reloadedPr?.feedbackItems[0]?.replyKind, "review_thread");
  assert.equal(reloadedPr?.feedbackItems[0]?.threadId, "PRRT_kwDO_thread");
  assert.equal(reloadedPr?.feedbackItems[0]?.auditToken, "codefactory-feedback:feedback-1");
  assert.equal(reloadedPr?.accepted, 1);
  assert.equal(reloadedPr?.feedbackItems[0]?.status, "resolved");
  assert.equal(reloadedPr?.feedbackItems[0]?.statusReason, "GitHub audit trail verified");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.phase, "agent");
  assert.deepEqual(logs[0]?.metadata, { attempt: 1 });
  second.close();
});
