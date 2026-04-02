import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCheckRunSnapshot,
  normalizeCheckSnapshotsFromRef,
  normalizeCommitStatusSnapshot,
} from "./ciCheckIngestor";

test("normalizeCommitStatusSnapshot maps commit status payloads into CheckSnapshot", () => {
  const snapshot = normalizeCommitStatusSnapshot({
    prId: "pr-1",
    sha: "abc123",
    status: {
      context: "build",
      description: "Build failed",
      state: "failure",
      target_url: "https://example.com/status/1",
      updated_at: "2026-04-01T12:00:00.000Z",
    },
  });

  assert.equal(snapshot.prId, "pr-1");
  assert.equal(snapshot.sha, "abc123");
  assert.equal(snapshot.provider, "github.commit_status");
  assert.equal(snapshot.context, "build");
  assert.equal(snapshot.status, "failure");
  assert.equal(snapshot.conclusion, null);
  assert.equal(snapshot.description, "Build failed");
  assert.equal(snapshot.targetUrl, "https://example.com/status/1");
  assert.equal(snapshot.observedAt, "2026-04-01T12:00:00.000Z");
  assert.ok(snapshot.id);
});

test("normalizeCheckRunSnapshot maps check run payloads into CheckSnapshot", () => {
  const snapshot = normalizeCheckRunSnapshot({
    prId: "pr-1",
    sha: "abc123",
    run: {
      name: "tests",
      status: "completed",
      conclusion: "timed_out",
      html_url: "https://example.com/check/1",
      output: {
        title: "Tests timed out",
        summary: "The test job timed out after 10 minutes.",
      },
      completed_at: "2026-04-01T12:05:00.000Z",
    },
  });

  assert.equal(snapshot.prId, "pr-1");
  assert.equal(snapshot.sha, "abc123");
  assert.equal(snapshot.provider, "github.check_run");
  assert.equal(snapshot.context, "tests");
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.conclusion, "timed_out");
  assert.equal(snapshot.description, "The test job timed out after 10 minutes.");
  assert.equal(snapshot.targetUrl, "https://example.com/check/1");
  assert.equal(snapshot.observedAt, "2026-04-01T12:05:00.000Z");
  assert.ok(snapshot.id);
});

test("normalizeCheckSnapshotsFromRef preserves ordering across commit statuses and check runs", () => {
  const snapshots = normalizeCheckSnapshotsFromRef({
    prId: "pr-1",
    sha: "abc123",
    statuses: [
      {
        context: "lint",
        state: "success",
        updated_at: "2026-04-01T12:01:00.000Z",
      },
    ],
    checkRuns: [
      {
        name: "build",
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-04-01T12:02:00.000Z",
      },
    ],
  });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]?.provider, "github.commit_status");
  assert.equal(snapshots[1]?.provider, "github.check_run");
});
