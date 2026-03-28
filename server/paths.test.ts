import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { getCodeFactoryPaths } from "./paths";

test("getCodeFactoryPaths prefers OH_MY_PR_HOME, then CODEFACTORY_HOME, then ~/.oh-my-pr", () => {
  const previousOhMyPrHome = process.env.OH_MY_PR_HOME;
  const previousCodeFactoryHome = process.env.CODEFACTORY_HOME;

  try {
    process.env.OH_MY_PR_HOME = "/tmp/oh-my-pr-test";
    process.env.CODEFACTORY_HOME = "/tmp/codefactory-test";

    const preferred = getCodeFactoryPaths();
    assert.equal(preferred.rootDir, "/tmp/oh-my-pr-test");
    assert.equal(preferred.repoRootDir, "/tmp/oh-my-pr-test/repos");
    assert.equal(preferred.worktreeRootDir, "/tmp/oh-my-pr-test/worktrees");

    delete process.env.OH_MY_PR_HOME;

    const legacy = getCodeFactoryPaths();
    assert.equal(legacy.rootDir, "/tmp/codefactory-test");
    assert.equal(legacy.repoRootDir, "/tmp/codefactory-test/repos");
    assert.equal(legacy.worktreeRootDir, "/tmp/codefactory-test/worktrees");

    delete process.env.CODEFACTORY_HOME;

    const fallback = getCodeFactoryPaths();
    assert.equal(fallback.rootDir, path.join(os.homedir(), ".oh-my-pr"));
    assert.equal(fallback.repoRootDir, path.join(os.homedir(), ".oh-my-pr", "repos"));
    assert.equal(fallback.worktreeRootDir, path.join(os.homedir(), ".oh-my-pr", "worktrees"));
  } finally {
    if (previousOhMyPrHome === undefined) {
      delete process.env.OH_MY_PR_HOME;
    } else {
      process.env.OH_MY_PR_HOME = previousOhMyPrHome;
    }

    if (previousCodeFactoryHome === undefined) {
      delete process.env.CODEFACTORY_HOME;
    } else {
      process.env.CODEFACTORY_HOME = previousCodeFactoryHome;
    }
  }
});
