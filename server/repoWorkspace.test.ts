import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { ensureRepoCache, preparePrWorktree, removePrWorktree } from "./repoWorkspace";

test("preparePrWorktree reuses the watched-repo cache and fetches fork heads on demand", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let cloned = false;

  const result = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "contrib/widgets",
    headRepoCloneUrl: "https://github.com/contrib/widgets.git",
    headRef: "fix-branch",
    prNumber: 42,
    runId: "run-1",
    runCommand: async (command, args) => {
      calls.push({ command, args });

      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }

      if (args[0] === "-C" && args[2] === "rev-parse") {
        return cloned ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }

      if (args[0] === "clone") {
        cloned = true;
        await mkdir(args[2], { recursive: true });
        return { code: 0, stdout: "cloned\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.fork-contrib.url") {
        return { code: 1, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "fetch") {
        return { code: 0, stdout: "fetched\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "remote" && args[3] === "add") {
        return { code: 0, stdout: "remote added\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "worktree" && args[3] === "add") {
        await mkdir(args[5], { recursive: true });
        return { code: 0, stdout: "worktree added\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.match(result.repoCacheDir, /\/repos\/acme__widgets$/);
  assert.match(result.worktreePath, /\/worktrees\/acme__widgets\/pr-42-run-1$/);
  assert.equal(result.remoteName, "fork-contrib");
  assert.equal(result.healed, true);
  assert.ok(calls.some((call) => call.args[2] === "remote" && call.args[3] === "add" && call.args[4] === "fork-contrib"));
});

test("preparePrWorktree reclones the cache when git health checks fail", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-heal-"));
  let cloneCount = 0;

  const result = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature-branch",
    prNumber: 18,
    runId: "run-2",
    runCommand: async (command, args) => {
      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }

      if (args[0] === "-C" && args[2] === "rev-parse") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
        if (cloneCount === 0) {
          return { code: 0, stdout: "https://github.com/other/repo.git\n", stderr: "" };
        }

        return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      }

      if (args[0] === "clone") {
        cloneCount += 1;
        await mkdir(args[2], { recursive: true });
        return { code: 0, stdout: "cloned\n", stderr: "" };
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

      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(cloneCount, 1);
  assert.equal(result.healed, true);
  assert.equal(result.remoteName, "origin");
});

test("ensureRepoCache treats tokenized and public GitHub clone URLs as the same remote", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-auth-"));
  let cloneCount = 0;

  const result = await ensureRepoCache({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://x-access-token:ghs_123@github.com/acme/widgets.git",
    runCommand: async (command, args) => {
      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }

      if (args[0] === "-C" && args[2] === "rev-parse") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "fetch") {
        return { code: 0, stdout: "fetched\n", stderr: "" };
      }

      if (args[0] === "clone") {
        cloneCount += 1;
        return { code: 0, stdout: "cloned\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.healed, false);
  assert.equal(cloneCount, 0);
});

test("ensureRepoCache refuses to reclone while an active worktree still depends on the shared cache", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-active-"));
  let cloned = false;
  let cloneCount = 0;

  const runCommand = async (command: string, args: string[]) => {
    if (command !== "git") {
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    }

    if (args[0] === "-C" && args[2] === "rev-parse") {
      return cloned ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }

    if (args[0] === "clone") {
      cloned = true;
      cloneCount += 1;
      await mkdir(args[2], { recursive: true });
      return { code: 0, stdout: "cloned\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
      return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
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

    if (args[0] === "-C" && args[2] === "worktree" && args[3] === "remove") {
      return { code: 0, stdout: "worktree removed\n", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  };

  const worktree = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature-branch",
    prNumber: 18,
    runId: "run-2",
    runCommand,
  });

  await assert.rejects(
    () => ensureRepoCache({
      rootDir,
      repoFullName: "acme/widgets",
      repoCloneUrl: "https://github.com/acme/widgets.git",
      runCommand,
      forceReclone: true,
    }),
    /active workspace/,
  );
  assert.equal(cloneCount, 1);

  await removePrWorktree({
    repoCacheDir: worktree.repoCacheDir,
    worktreePath: worktree.worktreePath,
    runCommand,
  });

  const healed = await ensureRepoCache({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    runCommand,
    forceReclone: true,
  });

  assert.equal(healed.healed, true);
  assert.equal(cloneCount, 2);
});

test("ensureRepoCache refuses to reclone when registered worktrees still exist on disk", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-registered-"));
  const repoCacheDir = path.join(rootDir, "repos", "acme__widgets");
  await mkdir(path.join(repoCacheDir, ".git", "worktrees", "pr-18-run-2"), { recursive: true });
  let cloneCount = 0;

  await assert.rejects(
    () => ensureRepoCache({
      rootDir,
      repoFullName: "acme/widgets",
      repoCloneUrl: "https://github.com/acme/widgets.git",
      forceReclone: true,
      runCommand: async (command, args) => {
        if (command !== "git") {
          return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
        }

        if (args[0] === "-C" && args[2] === "worktree" && args[3] === "prune") {
          return { code: 0, stdout: "", stderr: "" };
        }

        if (args[0] === "clone") {
          cloneCount += 1;
          return { code: 0, stdout: "cloned\n", stderr: "" };
        }

        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    /registered worktree/,
  );

  assert.equal(cloneCount, 0);
});
