import type { BackgroundJob, DeploymentPlatform } from "@shared/schema";
import type { CodingAgent } from "./agentRunner";
import type { PRBabysitter } from "./babysitter";
import { CancelBackgroundJobError, type BackgroundJobHandlers } from "./backgroundJobDispatcher";
import { createAdapter } from "./deploymentAdapters";
import type { DeploymentHealingManager } from "./deploymentHealingManager";
import { runDeploymentHealingRepair } from "./deploymentHealingAgent";
import { buildGitHubCloneUrl, buildOctokit, parseRepoSlug, resolveGitHubAuthToken } from "./github";
import { answerPRQuestion } from "./prQuestionAgent";
import type { ReleaseManager } from "./releaseManager";
import { generateSocialChangelog } from "./socialChangelogAgent";
import type { IStorage } from "./storage";

type BackgroundJobHandlerDeps = {
  buildOctokitFn?: typeof buildOctokit;
  createAdapterFn?: typeof createAdapter;
  resolveGitHubAuthTokenFn?: typeof resolveGitHubAuthToken;
  runDeploymentHealingRepairFn?: typeof runDeploymentHealingRepair;
};

function readStringPayload(job: BackgroundJob, key: string): string | null {
  const value = job.payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCodingAgentPayload(job: BackgroundJob, key: string): CodingAgent | null {
  const value = readStringPayload(job, key);
  if (value === "codex" || value === "claude") {
    return value;
  }

  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBackgroundJobHandlers(params: {
  storage: IStorage;
  babysitter?: Pick<PRBabysitter, "runQueuedBabysitPR" | "syncAndBabysitTrackedRepos">;
  releaseManager?: Pick<ReleaseManager, "processReleaseRun">;
  deploymentHealingManager?: DeploymentHealingManager;
  questionAnswerer?: typeof answerPRQuestion;
  socialChangelogGenerator?: typeof generateSocialChangelog;
  deps?: BackgroundJobHandlerDeps;
}): BackgroundJobHandlers {
  const storage = params.storage;
  const babysitter = params.babysitter;
  const releaseManager = params.releaseManager;
  const deploymentHealingManager = params.deploymentHealingManager;
  const questionAnswerer = params.questionAnswerer ?? answerPRQuestion;
  const socialChangelogGenerator = params.socialChangelogGenerator ?? generateSocialChangelog;
  const buildOctokitFn = params.deps?.buildOctokitFn ?? buildOctokit;
  const createAdapterFn = params.deps?.createAdapterFn ?? createAdapter;
  const resolveGitHubAuthTokenFn = params.deps?.resolveGitHubAuthTokenFn ?? resolveGitHubAuthToken;
  const runDeploymentHealingRepairFn = params.deps?.runDeploymentHealingRepairFn ?? runDeploymentHealingRepair;

  return {
    sync_watched_repos: babysitter
      ? async () => {
        await babysitter.syncAndBabysitTrackedRepos();
      }
      : undefined,

    babysit_pr: babysitter
      ? async (job) => {
        const pr = await storage.getPR(job.targetId);
        if (!pr) {
          throw new CancelBackgroundJobError(`PR ${job.targetId} no longer exists`);
        }

        const preferredAgent = readCodingAgentPayload(job, "preferredAgent")
          ?? (await storage.getConfig()).codingAgent;
        await babysitter.runQueuedBabysitPR(pr.id, preferredAgent);
      }
      : undefined,

    answer_pr_question: async (job) => {
      const prId = readStringPayload(job, "prId");
      if (!prId) {
        throw new CancelBackgroundJobError(`Background job ${job.id} is missing question PR context`);
      }

      const question = (await storage.getQuestions(prId)).find((entry) => entry.id === job.targetId);
      if (!question) {
        throw new CancelBackgroundJobError(`PR question ${job.targetId} no longer exists`);
      }

      if (question.status === "answered" || question.status === "error") {
        return;
      }

      const config = await storage.getConfig();
      await questionAnswerer({
        storage,
        prId: question.prId,
        questionId: question.id,
        question: question.question,
        preferredAgent: config.codingAgent,
      });
    },

    generate_social_changelog: async (job) => {
      const changelog = await storage.getSocialChangelog(job.targetId);
      if (!changelog) {
        throw new CancelBackgroundJobError(`Social changelog ${job.targetId} no longer exists`);
      }

      if (changelog.status === "done" || changelog.status === "error") {
        return;
      }

      const config = await storage.getConfig();
      await socialChangelogGenerator({
        storage,
        changelogId: changelog.id,
        prSummaries: changelog.prSummaries,
        date: changelog.date,
        preferredAgent: config.codingAgent,
      });
    },

    process_release_run: releaseManager
      ? async (job) => {
        const releaseRun = await storage.getReleaseRun(job.targetId);
        if (!releaseRun) {
          throw new CancelBackgroundJobError(`Release run ${job.targetId} no longer exists`);
        }

        if (releaseRun.status === "published" || releaseRun.status === "skipped") {
          return;
        }

        await releaseManager.processReleaseRun(releaseRun.id);
      }
      : undefined,

    heal_deployment: deploymentHealingManager
      ? async (job) => {
        const manager = deploymentHealingManager;
        const repo = readStringPayload(job, "repo");
        const platform = readStringPayload(job, "platform") as DeploymentPlatform | null;
        const mergeSha = readStringPayload(job, "mergeSha");
        const triggerPrNumber = Number(job.payload.triggerPrNumber);
        const triggerPrTitle = readStringPayload(job, "triggerPrTitle");
        const triggerPrUrl = readStringPayload(job, "triggerPrUrl");
        const baseBranch = readStringPayload(job, "baseBranch");

        if (!repo || !platform || !mergeSha || !triggerPrNumber || !triggerPrTitle || !triggerPrUrl || !baseBranch) {
          throw new CancelBackgroundJobError(
            `Background job ${job.id} is missing required deployment healing fields`,
          );
        }

        const session = await manager.ensureSession({
          repo,
          platform,
          triggerPrNumber,
          triggerPrTitle,
          triggerPrUrl,
          mergeSha,
        });

        const config = await storage.getConfig();

        // Wait for deployment to start
        await wait(config.deploymentCheckDelayMs);

        // Poll deployment status
        const adapter = createAdapterFn(platform);
        const deadline = Date.now() + config.deploymentCheckTimeoutMs;
        let lastStatus = await adapter.getDeploymentStatus({ repo, sha: mergeSha });

        while (lastStatus.state !== "ready" && lastStatus.state !== "error" && Date.now() < deadline) {
          await wait(config.deploymentCheckPollIntervalMs);
          lastStatus = await adapter.getDeploymentStatus({ repo, sha: mergeSha });
        }

        // Deployment succeeded — nothing to fix
        if (lastStatus.state === "ready") {
          return;
        }

        // Timed out without reaching error — escalate
        if (lastStatus.state !== "error") {
          await manager.transitionTo(session.id, "escalated", {
            error: `Deployment status timed out in state: ${lastStatus.state}`,
          });
          return;
        }

        // Get deployment logs
        const deploymentId = lastStatus.deploymentId ?? "unknown";
        const deploymentLog = await adapter.getDeploymentLogs({ repo, deploymentId });

        await manager.transitionTo(session.id, "failed", {
          deploymentId,
          deploymentLog,
        });
        await manager.transitionTo(session.id, "fixing");

        try {
          const parsedRepo = parseRepoSlug(repo);
          if (!parsedRepo) {
            throw new Error(`Cannot parse repo slug: ${repo}`);
          }

          const githubToken = await resolveGitHubAuthTokenFn(config);
          const octokit = await buildOctokitFn(config);

          const repairResult = await runDeploymentHealingRepairFn({
            repo,
            platform,
            mergeSha,
            triggerPrNumber,
            triggerPrTitle,
            triggerPrUrl,
            deploymentLog,
            baseBranch,
            repoCloneUrl: buildGitHubCloneUrl(repo, githubToken),
            agent: config.codingAgent,
            githubToken: githubToken ?? "",
          });

          if (!repairResult.accepted) {
            await manager.transitionTo(session.id, "escalated", {
              error: repairResult.rejectionReason ?? "Repair not accepted",
            });
            return;
          }

          // Create PR for the fix
          const prResult = await octokit.pulls.create({
            owner: parsedRepo.owner,
            repo: parsedRepo.repo,
            title: `fix(deploy): ${repairResult.summary}`,
            head: repairResult.fixBranch,
            base: baseBranch,
            body: [
              `Automated deployment fix for ${platform} failure after #${triggerPrNumber}.`,
              "",
              `**Summary:** ${repairResult.summary}`,
              "",
              `Triggered by merge of ${triggerPrUrl}.`,
            ].join("\n"),
          });

          await manager.transitionTo(session.id, "fix_submitted", {
            fixBranch: repairResult.fixBranch,
            fixPrNumber: prResult.data.number,
            fixPrUrl: prResult.data.html_url,
          });
        } catch (error) {
          await manager.transitionTo(session.id, "escalated", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      : undefined,
  };
}
