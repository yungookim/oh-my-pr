import type { CodingAgent, CommandResult } from "./agentRunner";
import { applyFixesWithAgent, runCommand } from "./agentRunner";
import { ensureRepoCache } from "./repoWorkspace";
import type { DeploymentPlatform } from "@shared/schema";

export type DeploymentHealingPromptInput = {
  repo: string;
  platform: DeploymentPlatform;
  mergeSha: string;
  triggerPrNumber: number;
  triggerPrTitle: string;
  triggerPrUrl: string;
  deploymentLog: string;
  baseBranch: string;
};

export type DeploymentHealingRepairInput = DeploymentHealingPromptInput & {
  repoCloneUrl: string;
  agent: CodingAgent;
  githubToken: string;
  rootDir?: string;
};

export type DeploymentHealingRepairResult = {
  accepted: boolean;
  rejectionReason: string | null;
  summary: string;
  fixBranch: string;
  agentResult: CommandResult;
};

export type DeploymentHealingRepairDependencies = {
  ensureRepoCache: typeof ensureRepoCache;
  applyFixesWithAgent: typeof applyFixesWithAgent;
  runCommand: typeof runCommand;
};

function buildDeps(overrides?: Partial<DeploymentHealingRepairDependencies>): DeploymentHealingRepairDependencies {
  return {
    ensureRepoCache: overrides?.ensureRepoCache ?? ensureRepoCache,
    applyFixesWithAgent: overrides?.applyFixesWithAgent ?? applyFixesWithAgent,
    runCommand: overrides?.runCommand ?? runCommand,
  };
}

export function buildDeploymentHealingPrompt(input: DeploymentHealingPromptInput): string {
  const lines = [
    "You are fixing a failed deployment for a repository.",
    "A pull request was merged but the deployment to the platform failed.",
    "Your task is to diagnose the deployment failure and apply the minimal fix.",
    "Create a new branch named deploy-fix/<platform>-<timestamp> from the merge SHA.",
    "Commit your fix to that branch and push it.",
    "At the end of your response, include exactly one line in this format:",
    "DEPLOYMENT_FIX_SUMMARY: <one short sentence describing what was fixed>",
    "",
    `Repository: ${input.repo}`,
    `Platform: ${input.platform}`,
    `Merge SHA: ${input.mergeSha}`,
    `Base branch: ${input.baseBranch}`,
    `Trigger PR: #${input.triggerPrNumber}`,
    `Trigger PR title: ${input.triggerPrTitle}`,
    `Trigger PR URL: ${input.triggerPrUrl}`,
    "",
    "Deployment failure log:",
    "```",
    input.deploymentLog,
    "```",
    "",
    "Instructions:",
    "1. Analyze the deployment log to identify the root cause of the failure.",
    "2. Apply the minimal code change needed to fix the deployment error.",
    "3. Commit your changes with a descriptive commit message.",
    "4. Push the fix branch to origin.",
    "5. Do not merge the branch — a PR will be created automatically.",
    "6. Include the DEPLOYMENT_FIX_SUMMARY line at the end of your output.",
  ];

  return lines.join("\n");
}

export function extractDeploymentHealingSummary(stdout: string): string {
  const marker = stdout.match(/^DEPLOYMENT_FIX_SUMMARY:\s*(.+)$/m);
  if (marker?.[1]) {
    return marker[1].trim();
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return "No agent summary provided";
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "No agent summary provided";
}

export async function runDeploymentHealingRepair(
  input: DeploymentHealingRepairInput & {
    env?: NodeJS.ProcessEnv;
    dependencies?: Partial<DeploymentHealingRepairDependencies>;
  },
): Promise<DeploymentHealingRepairResult> {
  const deps = buildDeps(input.dependencies);
  const fixBranch = `deploy-fix/${input.platform}-${Math.floor(Date.now() / 1000)}`;
  const prompt = buildDeploymentHealingPrompt(input);

  const { repoCacheDir } = await deps.ensureRepoCache({
    rootDir: input.rootDir,
    repoFullName: input.repo,
    repoCloneUrl: input.repoCloneUrl,
    runCommand: deps.runCommand,
  });

  const checkoutResult = await deps.runCommand(
    "git",
    ["-C", repoCacheDir, "checkout", "-b", fixBranch, input.mergeSha],
    { timeoutMs: 30000 },
  );

  if (checkoutResult.code !== 0) {
    return {
      accepted: false,
      rejectionReason: `branch creation failed: ${checkoutResult.stderr || checkoutResult.stdout}`,
      summary: "No agent summary provided",
      fixBranch,
      agentResult: checkoutResult,
    };
  }

  try {
    const agentResult = await deps.applyFixesWithAgent({
      agent: input.agent,
      cwd: repoCacheDir,
      prompt,
      env: input.env,
    });

    const logResult = await deps.runCommand(
      "git",
      ["-C", repoCacheDir, "log", `${input.mergeSha}..HEAD`, "--oneline"],
      { timeoutMs: 10000 },
    );

    const hasNewCommits = logResult.code === 0 && logResult.stdout.trim().length > 0;

    if (!hasNewCommits) {
      return {
        accepted: false,
        rejectionReason: "agent did not produce any new commits",
        summary: extractDeploymentHealingSummary(agentResult.stdout),
        fixBranch,
        agentResult,
      };
    }

    const pushResult = await deps.runCommand(
      "git",
      ["-C", repoCacheDir, "push", "origin", fixBranch],
      { timeoutMs: 60000 },
    );

    if (pushResult.code !== 0) {
      return {
        accepted: false,
        rejectionReason: `push failed: ${pushResult.stderr || pushResult.stdout}`,
        summary: extractDeploymentHealingSummary(agentResult.stdout),
        fixBranch,
        agentResult,
      };
    }

    return {
      accepted: true,
      rejectionReason: null,
      summary: extractDeploymentHealingSummary(agentResult.stdout),
      fixBranch,
      agentResult,
    };
  } finally {
    await deps.runCommand(
      "git",
      ["-C", repoCacheDir, "checkout", "--detach"],
      { timeoutMs: 15000 },
    );
  }
}
