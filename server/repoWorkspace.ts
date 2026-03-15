import { mkdir, rm } from "fs/promises";
import path from "path";
import { type CommandResult, runCommand } from "./agentRunner";
import { getCodeFactoryPaths } from "./paths";

type GitRunner = typeof runCommand;

type EnsureRepoCacheParams = {
  rootDir?: string;
  repoFullName: string;
  repoCloneUrl: string;
  runCommand: GitRunner;
  forceReclone?: boolean;
};

type PreparePrWorktreeParams = {
  rootDir?: string;
  repoFullName: string;
  repoCloneUrl: string;
  headRepoFullName: string;
  headRepoCloneUrl: string;
  headRef: string;
  prNumber: number;
  runId: string;
  runCommand: GitRunner;
};

type RemovePrWorktreeParams = {
  repoCacheDir: string;
  worktreePath: string;
  runCommand: GitRunner;
};

function summarizeCommandFailure(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || "no output";
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function runGit(
  run: GitRunner,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return run("git", args, { timeoutMs });
}

function getRepoCacheDir(rootDir: string | undefined, repoFullName: string): string {
  const paths = getCodeFactoryPaths(rootDir);
  return path.join(paths.repoRootDir, sanitizeRepoName(repoFullName));
}

function getWorktreePath(rootDir: string | undefined, repoFullName: string, prNumber: number, runId: string): string {
  const paths = getCodeFactoryPaths(rootDir);
  const repoDir = sanitizeRepoName(repoFullName);
  return path.join(paths.worktreeRootDir, repoDir, `pr-${prNumber}-${runId}`);
}

function getForkRemoteName(headRepoFullName: string): string {
  const owner = headRepoFullName.split("/")[0] || "fork";
  const safeOwner = owner.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return `fork-${safeOwner}`;
}

async function isRepoCacheHealthy(repoCacheDir: string, repoCloneUrl: string, run: GitRunner): Promise<boolean> {
  const repoCheck = await runGit(run, ["-C", repoCacheDir, "rev-parse", "--is-inside-work-tree"], 4000);
  if (repoCheck.code !== 0) {
    return false;
  }

  const originUrl = await runGit(run, ["-C", repoCacheDir, "config", "--get", "remote.origin.url"], 4000);
  if (originUrl.code !== 0 || originUrl.stdout.trim() !== repoCloneUrl) {
    return false;
  }

  const status = await runGit(run, ["-C", repoCacheDir, "status", "--porcelain"], 4000);
  if (status.code !== 0 || status.stdout.trim().length > 0) {
    return false;
  }

  return true;
}

async function cloneRepoCache(repoCacheDir: string, repoCloneUrl: string, run: GitRunner): Promise<void> {
  await ensureDirectory(path.dirname(repoCacheDir));
  await rm(repoCacheDir, { recursive: true, force: true });

  const cloneResult = await runGit(run, ["clone", repoCloneUrl, repoCacheDir], 180000);
  if (cloneResult.code !== 0) {
    throw new Error(`git clone failed: ${summarizeCommandFailure(cloneResult)}`);
  }
}

async function fetchOrigin(repoCacheDir: string, run: GitRunner): Promise<CommandResult> {
  return runGit(run, ["-C", repoCacheDir, "fetch", "origin", "--prune"], 120000);
}

async function ensureRemote(repoCacheDir: string, remoteName: string, cloneUrl: string, run: GitRunner): Promise<void> {
  const currentUrl = await runGit(run, ["-C", repoCacheDir, "config", "--get", `remote.${remoteName}.url`], 4000);
  if (currentUrl.code !== 0 || !currentUrl.stdout.trim()) {
    const addResult = await runGit(run, ["-C", repoCacheDir, "remote", "add", remoteName, cloneUrl], 8000);
    if (addResult.code !== 0) {
      throw new Error(`git remote add ${remoteName} failed: ${summarizeCommandFailure(addResult)}`);
    }
    return;
  }

  if (currentUrl.stdout.trim() !== cloneUrl) {
    const setUrlResult = await runGit(run, ["-C", repoCacheDir, "remote", "set-url", remoteName, cloneUrl], 8000);
    if (setUrlResult.code !== 0) {
      throw new Error(`git remote set-url ${remoteName} failed: ${summarizeCommandFailure(setUrlResult)}`);
    }
  }
}

async function fetchHeadRef(params: {
  repoCacheDir: string;
  repoFullName: string;
  headRepoFullName: string;
  headRepoCloneUrl: string;
  headRef: string;
  runCommand: GitRunner;
}): Promise<string> {
  const { repoCacheDir, repoFullName, headRepoFullName, headRepoCloneUrl, headRef, runCommand: run } = params;
  const remoteName = headRepoFullName === repoFullName ? "origin" : getForkRemoteName(headRepoFullName);

  if (remoteName !== "origin") {
    await ensureRemote(repoCacheDir, remoteName, headRepoCloneUrl, run);
  }

  let fetchResult = await runGit(run, ["-C", repoCacheDir, "fetch", remoteName, headRef], 120000);
  if (fetchResult.code === 0) {
    return remoteName;
  }

  if (remoteName !== "origin") {
    await runGit(run, ["-C", repoCacheDir, "remote", "remove", remoteName], 8000);
    await ensureRemote(repoCacheDir, remoteName, headRepoCloneUrl, run);
    fetchResult = await runGit(run, ["-C", repoCacheDir, "fetch", remoteName, headRef], 120000);
    if (fetchResult.code === 0) {
      return remoteName;
    }
  }

  throw new Error(`git fetch ${remoteName} ${headRef} failed: ${summarizeCommandFailure(fetchResult)}`);
}

async function addWorktree(repoCacheDir: string, worktreePath: string, run: GitRunner): Promise<void> {
  await ensureDirectory(path.dirname(worktreePath));
  await rm(worktreePath, { recursive: true, force: true });

  const worktreeCreate = await runGit(
    run,
    ["-C", repoCacheDir, "worktree", "add", "--detach", worktreePath, "FETCH_HEAD"],
    60000,
  );

  if (worktreeCreate.code !== 0) {
    throw new Error(`git worktree add failed: ${summarizeCommandFailure(worktreeCreate)}`);
  }
}

export function sanitizeRepoName(repoFullName: string): string {
  return repoFullName.replace(/[^a-zA-Z0-9_.-]+/g, "__");
}

export async function ensureRepoCache(params: EnsureRepoCacheParams): Promise<{
  repoCacheDir: string;
  healed: boolean;
}> {
  const { rootDir, repoFullName, repoCloneUrl, runCommand: run, forceReclone = false } = params;
  const paths = getCodeFactoryPaths(rootDir);
  const repoCacheDir = getRepoCacheDir(rootDir, repoFullName);

  await ensureDirectory(paths.repoRootDir);

  let healed = forceReclone;
  if (forceReclone || !await isRepoCacheHealthy(repoCacheDir, repoCloneUrl, run)) {
    await cloneRepoCache(repoCacheDir, repoCloneUrl, run);
    healed = true;
  }

  const fetchResult = await fetchOrigin(repoCacheDir, run);
  if (fetchResult.code !== 0) {
    await cloneRepoCache(repoCacheDir, repoCloneUrl, run);
    healed = true;

    const retryFetchResult = await fetchOrigin(repoCacheDir, run);
    if (retryFetchResult.code !== 0) {
      throw new Error(`git fetch origin failed: ${summarizeCommandFailure(retryFetchResult)}`);
    }
  }

  return { repoCacheDir, healed };
}

export async function preparePrWorktree(params: PreparePrWorktreeParams): Promise<{
  repoCacheDir: string;
  worktreePath: string;
  healed: boolean;
  remoteName: string;
}> {
  const {
    rootDir,
    repoFullName,
    repoCloneUrl,
    headRepoFullName,
    headRepoCloneUrl,
    headRef,
    prNumber,
    runId,
    runCommand: run,
  } = params;

  const worktreePath = getWorktreePath(rootDir, repoFullName, prNumber, runId);

  let healed = false;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cache = await ensureRepoCache({
      rootDir,
      repoFullName,
      repoCloneUrl,
      runCommand: run,
      forceReclone: attempt > 0,
    });
    healed = healed || cache.healed;

    try {
      const remoteName = await fetchHeadRef({
        repoCacheDir: cache.repoCacheDir,
        repoFullName,
        headRepoFullName,
        headRepoCloneUrl,
        headRef,
        runCommand: run,
      });

      await addWorktree(cache.repoCacheDir, worktreePath, run);
      return {
        repoCacheDir: cache.repoCacheDir,
        worktreePath,
        healed,
        remoteName,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Failed to prepare PR worktree");
}

export async function removePrWorktree(params: RemovePrWorktreeParams): Promise<void> {
  const { repoCacheDir, worktreePath, runCommand: run } = params;
  await runGit(run, ["-C", repoCacheDir, "worktree", "remove", "--force", worktreePath], 30000);
  await rm(worktreePath, { recursive: true, force: true });
}
