import os from "os";
import path from "path";

export type CodeFactoryPaths = {
  rootDir: string;
  stateDbPath: string;
  logRootDir: string;
  repoRootDir: string;
  worktreeRootDir: string;
};

export function getCodeFactoryPaths(rootDirOverride?: string): CodeFactoryPaths {
  const rootDir = rootDirOverride
    || process.env.OH_MY_PR_HOME
    || process.env.CODEFACTORY_HOME
    || path.join(os.homedir(), ".oh-my-pr");

  return {
    rootDir,
    stateDbPath: path.join(rootDir, "state.sqlite"),
    logRootDir: path.join(rootDir, "log"),
    repoRootDir: path.join(rootDir, "repos"),
    worktreeRootDir: path.join(rootDir, "worktrees"),
  };
}
