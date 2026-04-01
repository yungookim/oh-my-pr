import test from "node:test";
import assert from "node:assert/strict";
import { createCheckSnapshot } from "@shared/models";
import {
  classifyCIFailure,
  classifyCIFailures,
} from "./ciFailureClassifier";

test("classifyCIFailure marks build failures as healable in branch", () => {
  const snapshot = createCheckSnapshot({
    prId: "pr-1",
    sha: "abc123",
    provider: "github.check_run",
    context: "Build",
    status: "completed",
    conclusion: "failure",
    description: "Build failed because the bundle step broke",
    targetUrl: "https://github.com/owner/repo/actions/runs/1",
    observedAt: "2026-04-01T12:00:00.000Z",
  });

  const result = classifyCIFailure(snapshot);

  assert.equal(result.classification, "healable_in_branch");
  assert.equal(result.category, "build");
  assert.equal(result.fingerprint, "github-check-run:build:build");
  assert.match(result.summary, /In-branch fix likely available/);
  assert.deepEqual(result.selectedEvidence, [
    "Build",
    "Build failed because the bundle step broke",
    "https://github.com/owner/repo/actions/runs/1",
  ]);
});

test("classifyCIFailure marks secret and permission failures as blocked external", () => {
  const snapshot = createCheckSnapshot({
    prId: "pr-1",
    sha: "abc123",
    provider: "github.commit_status",
    context: "deploy",
    status: "failure",
    conclusion: null,
    description: "Deployment failed: missing GitHub token permissions",
    targetUrl: null,
    observedAt: "2026-04-01T12:00:00.000Z",
  });

  const result = classifyCIFailure(snapshot);

  assert.equal(result.classification, "blocked_external");
  assert.equal(result.category, "missing-secret");
  assert.equal(result.fingerprint, "github-commit-status:missing-secret:deploy");
  assert.match(result.summary, /External CI failure/);
});

test("classifyCIFailure marks timeouts as flaky or ambiguous", () => {
  const snapshot = createCheckSnapshot({
    prId: "pr-1",
    sha: "abc123",
    provider: "github.check_run",
    context: "integration tests",
    status: "completed",
    conclusion: "timed_out",
    description: "The test job timed out after 10 minutes",
    targetUrl: null,
    observedAt: "2026-04-01T12:00:00.000Z",
  });

  const result = classifyCIFailure(snapshot);

  assert.equal(result.classification, "flaky_or_ambiguous");
  assert.equal(result.category, "timeout");
  assert.equal(result.fingerprint, "github-check-run:timeout:integration-tests");
  assert.match(result.summary, /Flaky or ambiguous/);
});

test("classifyCIFailure returns unknown for signals it cannot categorize", () => {
  const snapshot = createCheckSnapshot({
    prId: "pr-1",
    sha: "abc123",
    provider: "github.check_run",
    context: "mystery job",
    status: "completed",
    conclusion: "failure",
    description: "Unexpected exit code 7",
    targetUrl: null,
    observedAt: "2026-04-01T12:00:00.000Z",
  });

  const result = classifyCIFailure(snapshot);

  assert.equal(result.classification, "unknown");
  assert.equal(result.category, "unknown");
  assert.equal(result.fingerprint, "github-check-run:unknown:mystery-job:failure");
  assert.match(result.summary, /Unclassified CI failure/);
});

test("classifyCIFailures deduplicates stable fingerprints and merges evidence", () => {
  const snapshots = [
    createCheckSnapshot({
      prId: "pr-1",
      sha: "abc123",
      provider: "github.check_run",
      context: "Build",
      status: "completed",
      conclusion: "failure",
      description: "Build failed",
      targetUrl: null,
      observedAt: "2026-04-01T12:00:00.000Z",
    }),
    createCheckSnapshot({
      prId: "pr-1",
      sha: "abc123",
      provider: "github.check_run",
      context: "build",
      status: "completed",
      conclusion: "failure",
      description: "Build failed again",
      targetUrl: "https://github.com/owner/repo/actions/runs/2",
      observedAt: "2026-04-01T12:01:00.000Z",
    }),
  ];

  const results = classifyCIFailures(snapshots);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.fingerprint, "github-check-run:build:build");
  assert.deepEqual(results[0]?.selectedEvidence, [
    "Build",
    "Build failed",
    "build",
    "Build failed again",
    "https://github.com/owner/repo/actions/runs/2",
  ]);
});
