import { createHash } from "crypto";
import type { CodingAgent, CommandResult } from "./agentRunner";
import { applyFixesWithAgent, runCommand } from "./agentRunner";
import type { ClassifiedCIFailure } from "./ciFailureClassifier";
import { preparePrWorktree, removePrWorktree } from "./repoWorkspace";

export type CIHealingRepairDependencies = {
  preparePrWorktree: typeof preparePrWorktree;
  removePrWorktree: typeof removePrWorktree;
  applyFixesWithAgent: typeof applyFixesWithAgent;
  runCommand: typeof runCommand;
};

export type CIHealingRepairPromptInput = {
  prNumber: number;
  repoFullName: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  title: string;
  url: string;
  author: string;
  branch: string;
  agent: CodingAgent;
  failures: ClassifiedCIFailure[];
  maxFailuresToInclude?: number;
  maxEvidencePerFailure?: number;
};

export type CIHealingWorktreeInput = CIHealingRepairPromptInput & {
  repoCloneUrl: string;
  headRepoFullName: string;
  headRepoCloneUrl: string;
  runId: string;
  rootDir?: string;
};

export type CIHealingVerificationMetadata = {
  inputHeadSha: string;
  localHeadSha: string;
  remoteHeadSha: string;
  localCommitCreated: boolean;
  worktreeDirty: boolean;
  branchMoved: boolean;
  pushedNewSha: boolean;
};

export type CIHealingRepairAttemptResult = {
  accepted: boolean;
  rejectionReason: string | null;
  summary: string;
  prompt: string;
  promptDigest: string;
  agentResult: CommandResult;
  verification: CIHealingVerificationMetadata;
  targetFingerprints: string[];
  classifiedFailures: ClassifiedCIFailure[];
  worktreePath: string;
  repoCacheDir: string;
  remoteName: string;
  agent: CodingAgent;
  headRef: string;
  baseRef: string;
  prNumber: number;
  title: string;
  url: string;
  author: string;
  branch: string;
};

const DEFAULT_MAX_FAILURES_TO_INCLUDE = 3;
const DEFAULT_MAX_EVIDENCE_PER_FAILURE = 3;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;

function buildDeps(overrides?: Partial<CIHealingRepairDependencies>): CIHealingRepairDependencies {
  return {
    preparePrWorktree: overrides?.preparePrWorktree ?? preparePrWorktree,
    removePrWorktree: overrides?.removePrWorktree ?? removePrWorktree,
    applyFixesWithAgent: overrides?.applyFixesWithAgent ?? applyFixesWithAgent,
    runCommand: overrides?.runCommand ?? runCommand,
  };
}

function shaDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function trimLine(value: string, maxLength = 180): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function dedupeFailures(failures: ClassifiedCIFailure[]): ClassifiedCIFailure[] {
  const seen = new Map<string, ClassifiedCIFailure>();

  for (const failure of failures) {
    if (!seen.has(failure.fingerprint)) {
      seen.set(failure.fingerprint, failure);
    }
  }

  return Array.from(seen.values());
}

function limitEvidence(evidence: string[], maxEvidencePerFailure: number): string[] {
  return evidence
    .map((value) => trimLine(value))
    .filter((value) => value.length > 0)
    .slice(0, Math.max(0, maxEvidencePerFailure));
}

function formatFailureBlock(failure: ClassifiedCIFailure, maxEvidencePerFailure: number): string {
  const evidence = limitEvidence(failure.selectedEvidence, maxEvidencePerFailure);
  const evidenceLines = evidence.length > 0
    ? evidence.map((line) => `  - ${line}`).join("\n")
    : "  - No additional evidence provided";

  return [
    `- Fingerprint: ${failure.fingerprint}`,
    `  Category: ${failure.category}`,
    `  Classification: ${failure.classification}`,
    `  Summary: ${trimLine(failure.summary, 220)}`,
    `  Evidence:`,
    evidenceLines,
  ].join("\n");
}

export function buildCIHealingRepairPrompt(input: CIHealingRepairPromptInput): string {
  const maxFailures = Math.max(0, input.maxFailuresToInclude ?? DEFAULT_MAX_FAILURES_TO_INCLUDE);
  const maxEvidencePerFailure = Math.max(0, input.maxEvidencePerFailure ?? DEFAULT_MAX_EVIDENCE_PER_FAILURE);
  const uniqueFailures = dedupeFailures(input.failures);
  const failures = uniqueFailures.slice(0, maxFailures);
  const omittedFailures = Math.max(0, uniqueFailures.length - failures.length);

  const lines = [
    "You are fixing failing CI checks for a pull request.",
    "Work only on the failures listed below.",
    "Do not expand scope to unrelated files or tasks.",
    "Make the smallest safe code change that clears the listed checks.",
    "Commit and push your fix to the PR branch.",
    "At the end of your response, include exactly one line in this format:",
    "CI_HEALING_SUMMARY: <one short sentence about what changed and how it was verified>",
    "",
    `Repository: ${input.repoFullName}`,
    `Pull request: #${input.prNumber}`,
    `Title: ${input.title}`,
    `Author: ${input.author}`,
    `PR URL: ${input.url}`,
    `Branch: ${input.branch}`,
    `Base ref: ${input.baseRef}`,
    `Head ref: ${input.headRef}`,
    `Current head SHA: ${input.headSha}`,
    `Agent: ${input.agent}`,
    "",
    "Targeted failures:",
  ];

  if (failures.length === 0) {
    lines.push("- No failures were supplied.");
  } else {
    for (const failure of failures) {
      lines.push(formatFailureBlock(failure, maxEvidencePerFailure));
    }
  }

  if (omittedFailures > 0) {
    lines.push(`- ${omittedFailures} additional failure fingerprint(s) omitted to keep the prompt bounded.`);
  }

  lines.push(
    "",
    "Verification requirements:",
    "1. If you make code changes, ensure the branch is pushed before you finish.",
    "2. Keep the diff focused on the targeted fingerprints above.",
    "3. If you cannot make progress, explain the blocker in the summary line.",
  );

  return lines.join("\n");
}

export function extractCIHealingSummary(stdout: string): string {
  const marker = stdout.match(/^CI_HEALING_SUMMARY:\s*(.+)$/m);
  if (marker?.[1]) {
    return marker[1].trim();
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return "No agent summary provided";
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return trimLine(lines.slice(-1).join(" "), 240);
}

async function readHeadSha(
  deps: CIHealingRepairDependencies,
  cwd: string,
): Promise<string> {
  const result = await deps.runCommand("git", ["-C", cwd, "rev-parse", "HEAD"], {
    timeoutMs: 10000,
  });

  if (result.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

async function readGitStatusPorcelain(
  deps: CIHealingRepairDependencies,
  cwd: string,
): Promise<string[]> {
  const result = await deps.runCommand("git", ["-C", cwd, "status", "--porcelain"], {
    timeoutMs: 10000,
  });

  if (result.code !== 0) {
    throw new Error(`git status --porcelain failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

async function readRemoteHeadSha(
  deps: CIHealingRepairDependencies,
  repoCacheDir: string,
  remoteName: string,
  headRef: string,
): Promise<string> {
  const fetchResult = await deps.runCommand("git", ["-C", repoCacheDir, "fetch", remoteName, headRef], {
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });

  if (fetchResult.code !== 0) {
    throw new Error(`git fetch ${remoteName} ${headRef} failed: ${fetchResult.stderr || fetchResult.stdout}`);
  }

  const headResult = await deps.runCommand("git", ["-C", repoCacheDir, "rev-parse", "FETCH_HEAD"], {
    timeoutMs: 10000,
  });

  if (headResult.code !== 0) {
    throw new Error(`git rev-parse FETCH_HEAD failed: ${headResult.stderr || headResult.stdout}`);
  }

  return headResult.stdout.trim();
}

export async function runCIHealingRepairAttempt(input: CIHealingWorktreeInput & {
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<CIHealingRepairDependencies>;
}): Promise<CIHealingRepairAttemptResult> {
  const deps = buildDeps(input.dependencies);
  const prompt = buildCIHealingRepairPrompt(input);
  const promptDigest = shaDigest(prompt);
  const targetFailures = dedupeFailures(input.failures).slice(0, Math.max(0, input.maxFailuresToInclude ?? DEFAULT_MAX_FAILURES_TO_INCLUDE));

  const worktree = await deps.preparePrWorktree({
    rootDir: input.rootDir,
    repoFullName: input.repoFullName,
    repoCloneUrl: input.repoCloneUrl,
    headRepoFullName: input.headRepoFullName,
    headRepoCloneUrl: input.headRepoCloneUrl,
    headRef: input.headRef,
    prNumber: input.prNumber,
    runId: input.runId,
    runCommand: deps.runCommand,
  });

  try {
    const agentResult = await deps.applyFixesWithAgent({
      agent: input.agent,
      cwd: worktree.worktreePath,
      prompt,
      env: input.env,
    });

    const localHeadSha = await readHeadSha(deps, worktree.worktreePath);
    const worktreeStatus = await readGitStatusPorcelain(deps, worktree.worktreePath);
    const worktreeDirty = worktreeStatus.length > 0;

    const remoteHeadSha = worktreeDirty
      ? input.headSha
      : await readRemoteHeadSha(deps, worktree.repoCacheDir, worktree.remoteName, input.headRef);

    const localCommitCreated = localHeadSha !== input.headSha;
    const pushedNewSha = remoteHeadSha !== input.headSha;
    const branchMoved = pushedNewSha;
    const accepted = agentResult.code === 0 && !worktreeDirty && pushedNewSha;
    let rejectionReason: string | null = null;

    if (!accepted) {
      if (agentResult.code !== 0) {
        rejectionReason = `agent exited with code ${agentResult.code}`;
      } else if (worktreeDirty) {
        rejectionReason = `dirty worktree after agent run: ${worktreeStatus[0] ?? "unknown changes"}`;
      } else if (localCommitCreated && !pushedNewSha) {
        rejectionReason = `local commit ${localHeadSha} was created but not pushed`;
      } else if (!pushedNewSha) {
        rejectionReason = `remote ${worktree.remoteName}/${input.headRef} did not move from ${input.headSha}`;
      } else {
        rejectionReason = "agent run did not satisfy verification requirements";
      }
    }

    return {
      accepted,
      rejectionReason,
      summary: extractCIHealingSummary(agentResult.stdout),
      prompt,
      promptDigest,
      agentResult,
      verification: {
        inputHeadSha: input.headSha,
        localHeadSha,
        remoteHeadSha,
        localCommitCreated,
        worktreeDirty,
        branchMoved,
        pushedNewSha,
      },
      targetFingerprints: targetFailures.map((failure) => failure.fingerprint),
      classifiedFailures: targetFailures,
      worktreePath: worktree.worktreePath,
      repoCacheDir: worktree.repoCacheDir,
      remoteName: worktree.remoteName,
      agent: input.agent,
      headRef: input.headRef,
      baseRef: input.baseRef,
      prNumber: input.prNumber,
      title: input.title,
      url: input.url,
      author: input.author,
      branch: input.branch,
    };
  } finally {
    await deps.removePrWorktree({
      repoCacheDir: worktree.repoCacheDir,
      worktreePath: worktree.worktreePath,
      runCommand: deps.runCommand,
    });
  }
}
