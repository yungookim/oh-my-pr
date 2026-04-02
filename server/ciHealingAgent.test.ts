import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifiedCIFailure } from "./ciFailureClassifier";
import {
  buildCIHealingRepairPrompt,
  extractCIHealingSummary,
  runCIHealingRepairAttempt,
} from "./ciHealingAgent";

function makeFailure(overrides: Partial<ClassifiedCIFailure> = {}): ClassifiedCIFailure {
  return {
    fingerprint: "github.check_run:typescript:build",
    category: "typescript",
    classification: "healable_in_branch",
    summary: "TypeScript compilation failed",
    selectedEvidence: ["src/index.ts", "TS2345", "extra context"],
    ...overrides,
  };
}

test("buildCIHealingRepairPrompt bounds failures and evidence", () => {
  const prompt = buildCIHealingRepairPrompt({
    prNumber: 42,
    repoFullName: "acme/widgets",
    headRef: "feature/heal-ci",
    baseRef: "main",
    headSha: "abc123",
    title: "Fix the compiler",
    url: "https://github.com/acme/widgets/pull/42",
    author: "octocat",
    branch: "feature/heal-ci",
    agent: "claude",
    failures: [
      makeFailure({
        fingerprint: "github.check_run:typescript:build",
        selectedEvidence: ["src/index.ts", "TS2345", "another detail"],
      }),
      makeFailure({
        fingerprint: "github.check_run:lint:eslint",
        category: "lint",
        summary: "Lint failed",
        selectedEvidence: ["eslint output"],
      }),
      makeFailure({
        fingerprint: "github.check_run:tests:unit",
        category: "tests",
        summary: "Unit tests failed",
        selectedEvidence: ["jest", "more evidence"],
      }),
    ],
    maxFailuresToInclude: 2,
    maxEvidencePerFailure: 1,
  });

  assert.match(prompt, /Repository: acme\/widgets/);
  assert.match(prompt, /Fingerprint: github\.check_run:typescript:build/);
  assert.match(prompt, /Fingerprint: github\.check_run:lint:eslint/);
  assert.doesNotMatch(prompt, /Fingerprint: github\.check_run:tests:unit/);
  assert.match(prompt, /- src\/index\.ts/);
  assert.doesNotMatch(prompt, /- TS2345/);
  assert.match(prompt, /1 additional failure fingerprint\(s\) omitted/);
  assert.match(prompt, /CI_HEALING_SUMMARY:/);
});

test("extractCIHealingSummary prefers the summary marker", () => {
  const summary = extractCIHealingSummary([
    "work in progress",
    "CI_HEALING_SUMMARY: fixed the tsconfig path",
    "more output",
  ].join("\n"));

  assert.equal(summary, "fixed the tsconfig path");
});

test("extractCIHealingSummary falls back to the last non-empty line", () => {
  const summary = extractCIHealingSummary([
    "collecting context",
    "",
    "still working through the failure",
    "fixed the tsconfig path",
  ].join("\n"));

  assert.equal(summary, "fixed the tsconfig path");
});

test("runCIHealingRepairAttempt captures verification metadata when the push lands", async () => {
  const callLog: Array<{ command: string; args: string[] }> = [];
  let cleanupCalled = false;
  const result = await runCIHealingRepairAttempt({
    prNumber: 42,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature/heal-ci",
    baseRef: "main",
    headSha: "old-sha",
    title: "Fix the compiler",
    url: "https://github.com/acme/widgets/pull/42",
    author: "octocat",
    branch: "feature/heal-ci",
    agent: "claude",
    failures: [makeFailure()],
    runId: "run-1",
    dependencies: {
      preparePrWorktree: async () => ({
        repoCacheDir: "/tmp/repo-cache",
        worktreePath: "/tmp/worktree",
        healed: false,
        remoteName: "origin",
      }),
      removePrWorktree: async () => {
        cleanupCalled = true;
      },
      applyFixesWithAgent: async ({ prompt }) => {
        assert.match(prompt, /CI_HEALING_SUMMARY:/);
        return {
          code: 0,
          stdout: [
            "agent output",
            "CI_HEALING_SUMMARY: fixed the compiler and pushed the change",
          ].join("\n"),
          stderr: "",
        };
      },
      runCommand: async (command, args) => {
        callLog.push({ command, args });

        if (command !== "git") {
          return { code: 1, stdout: "", stderr: `unexpected command ${command}` };
        }

        const signature = args.join(" ");
        if (signature.includes("-C /tmp/worktree rev-parse HEAD")) {
          return { code: 0, stdout: "local-new-sha\n", stderr: "" };
        }

        if (signature.includes("-C /tmp/worktree status --porcelain")) {
          return { code: 0, stdout: "", stderr: "" };
        }

        if (signature.includes("-C /tmp/repo-cache fetch origin feature/heal-ci")) {
          return { code: 0, stdout: "fetched\n", stderr: "" };
        }

        if (signature.includes("-C /tmp/repo-cache rev-parse FETCH_HEAD")) {
          return { code: 0, stdout: "remote-new-sha\n", stderr: "" };
        }

        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.rejectionReason, null);
  assert.equal(result.summary, "fixed the compiler and pushed the change");
  assert.equal(result.verification.inputHeadSha, "old-sha");
  assert.equal(result.verification.localHeadSha, "local-new-sha");
  assert.equal(result.verification.remoteHeadSha, "remote-new-sha");
  assert.equal(result.verification.localCommitCreated, true);
  assert.equal(result.verification.worktreeDirty, false);
  assert.equal(result.verification.branchMoved, true);
  assert.equal(result.verification.pushedNewSha, true);
  assert.equal(result.targetFingerprints.length, 1);
  assert.equal(result.promptDigest.length, 64);
  assert.ok(callLog.some((entry) => entry.args.join(" ").includes("fetch origin feature/heal-ci")));
  assert.equal(cleanupCalled, true);
});

test("runCIHealingRepairAttempt rejects when the remote SHA does not move", async () => {
  let cleanupCalled = false;
  const result = await runCIHealingRepairAttempt({
    prNumber: 42,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature/heal-ci",
    baseRef: "main",
    headSha: "old-sha",
    title: "Fix the compiler",
    url: "https://github.com/acme/widgets/pull/42",
    author: "octocat",
    branch: "feature/heal-ci",
    agent: "claude",
    failures: [makeFailure()],
    runId: "run-2",
    dependencies: {
      preparePrWorktree: async () => ({
        repoCacheDir: "/tmp/repo-cache",
        worktreePath: "/tmp/worktree",
        healed: false,
        remoteName: "origin",
      }),
      removePrWorktree: async () => {
        cleanupCalled = true;
      },
      applyFixesWithAgent: async () => ({
        code: 0,
        stdout: "CI_HEALING_SUMMARY: made a local change but did not push",
        stderr: "",
      }),
      runCommand: async (command, args) => {
        if (command !== "git") {
          return { code: 1, stdout: "", stderr: `unexpected command ${command}` };
        }

        const signature = args.join(" ");
        if (signature.includes("-C /tmp/worktree rev-parse HEAD")) {
          return { code: 0, stdout: "local-new-sha\n", stderr: "" };
        }

        if (signature.includes("-C /tmp/repo-cache fetch origin feature/heal-ci")) {
          return { code: 0, stdout: "fetched\n", stderr: "" };
        }

        if (signature.includes("-C /tmp/repo-cache rev-parse FETCH_HEAD")) {
          return { code: 0, stdout: "old-sha\n", stderr: "" };
        }

        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.rejectionReason, "local commit local-new-sha was created but not pushed");
  assert.equal(result.verification.inputHeadSha, "old-sha");
  assert.equal(result.verification.localHeadSha, "local-new-sha");
  assert.equal(result.verification.remoteHeadSha, "old-sha");
  assert.equal(result.verification.localCommitCreated, true);
  assert.equal(result.verification.worktreeDirty, false);
  assert.equal(result.verification.branchMoved, false);
  assert.equal(result.verification.pushedNewSha, false);
  assert.equal(cleanupCalled, true);
});

test("runCIHealingRepairAttempt rejects dirty worktrees before remote verification", async () => {
  const callLog: Array<{ command: string; args: string[] }> = [];
  const result = await runCIHealingRepairAttempt({
    prNumber: 42,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature/heal-ci",
    baseRef: "main",
    headSha: "old-sha",
    title: "Fix the compiler",
    url: "https://github.com/acme/widgets/pull/42",
    author: "octocat",
    branch: "feature/heal-ci",
    agent: "claude",
    failures: [makeFailure()],
    runId: "run-3",
    dependencies: {
      preparePrWorktree: async () => ({
        repoCacheDir: "/tmp/repo-cache",
        worktreePath: "/tmp/worktree",
        healed: false,
        remoteName: "origin",
      }),
      removePrWorktree: async () => {},
      applyFixesWithAgent: async () => ({
        code: 0,
        stdout: "CI_HEALING_SUMMARY: left the worktree dirty",
        stderr: "",
      }),
      runCommand: async (command, args) => {
        callLog.push({ command, args });

        if (command !== "git") {
          return { code: 1, stdout: "", stderr: `unexpected command ${command}` };
        }

        const signature = args.join(" ");
        if (signature.includes("-C /tmp/worktree rev-parse HEAD")) {
          return { code: 0, stdout: "local-new-sha\n", stderr: "" };
        }

        if (signature.includes("-C /tmp/worktree status --porcelain")) {
          return { code: 0, stdout: " M server/index.ts\n", stderr: "" };
        }

        if (signature.includes("fetch origin")) {
          return { code: 0, stdout: "fetched\n", stderr: "" };
        }

        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(result.accepted, false);
  assert.match(result.rejectionReason ?? "", /dirty worktree after agent run/);
  assert.equal(result.verification.worktreeDirty, true);
  assert.equal(result.verification.localCommitCreated, true);
  assert.equal(result.verification.remoteHeadSha, "old-sha");
  assert.ok(!callLog.some((entry) => entry.args.join(" ").includes("fetch origin feature/heal-ci")), "dirty worktree should fail before remote fetch");
});
