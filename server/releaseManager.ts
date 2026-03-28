import type { Octokit } from "@octokit/rest";
import type { Config, ReleaseRun, ReleaseRunIncludedPR } from "@shared/schema";
import type { CodingAgent } from "./agentRunner";
import { parseRepoSlug } from "./github";
import type { IStorage } from "./storage";
import {
  evaluateReleaseWorthinessWithAgent,
  type ReleaseAgentPullSummary,
  type ReleaseBump,
  type ReleaseEvaluationDecision,
} from "./releaseAgent";

type ReleaseRepo = {
  owner: string;
  repo: string;
};

type PublishedRelease = {
  id: number;
  url: string;
  tagName: string;
  name: string | null;
};

export type ReleaseGitHubService = {
  buildOctokit(config: Config): Promise<Octokit>;
  findLatestSemverReleaseTag(octokit: Octokit, repo: ReleaseRepo): Promise<string | null>;
  bumpReleaseTag(latestTag: string | null, bump: ReleaseBump): string;
  listMergedPullsForReleaseCandidate?(
    octokit: Octokit,
    repo: ReleaseRepo,
    options: {
      baseBranch: string;
      untilMergedAt: string;
      triggerPr: ReleaseAgentPullSummary;
    },
  ): Promise<ReleaseAgentPullSummary[]>;
  findReleaseByTag?(octokit: Octokit, repo: ReleaseRepo, tagName: string): Promise<PublishedRelease | null>;
  createGitHubRelease(
    octokit: Octokit,
    repo: ReleaseRepo,
    params: {
      tagName: string;
      targetCommitish: string;
      name: string;
      body: string;
    },
  ): Promise<PublishedRelease>;
};

export class ReleaseManager {
  private readonly storage: IStorage;
  private readonly github: ReleaseGitHubService;
  private readonly evaluateRelease: typeof evaluateReleaseWorthinessWithAgent;
  private readonly inProgress = new Set<string>();
  private readonly backgroundJobs = new Set<Promise<void>>();
  private readonly repoLocks = new Map<string, Promise<void>>();

  constructor(
    storage: IStorage,
    params: {
      github: ReleaseGitHubService;
      evaluateRelease?: typeof evaluateReleaseWorthinessWithAgent;
    },
  ) {
    this.storage = storage;
    this.github = params.github;
    this.evaluateRelease = params.evaluateRelease ?? evaluateReleaseWorthinessWithAgent;
  }

  getActiveRunCount(): number {
    return this.inProgress.size;
  }

  async waitForIdle(timeoutMs = 120_000): Promise<boolean> {
    const startedAt = Date.now();

    while (this.inProgress.size > 0 || this.backgroundJobs.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await wait(50);
    }

    return true;
  }

  async enqueueMergedPullReleaseEvaluation(input: {
    repo: string;
    baseBranch: string;
    triggerPrNumber: number;
    triggerPrTitle: string;
    triggerPrUrl: string;
    triggerMergeSha: string;
    triggerMergedAt: string;
  }): Promise<ReleaseRun> {
    const existing = await this.storage.getReleaseRunByTrigger(
      input.repo,
      input.triggerPrNumber,
      input.triggerMergeSha,
    );
    if (existing) {
      if (!isTerminalReleaseStatus(existing.status)) {
        this.scheduleProcessing(existing.id);
      }
      return existing;
    }

    const created = await this.storage.createReleaseRun({
      repo: input.repo,
      baseBranch: input.baseBranch,
      triggerPrNumber: input.triggerPrNumber,
      triggerPrTitle: input.triggerPrTitle,
      triggerPrUrl: input.triggerPrUrl,
      triggerMergeSha: input.triggerMergeSha,
      triggerMergedAt: input.triggerMergedAt,
      status: "detected",
      decisionReason: null,
      recommendedBump: null,
      proposedVersion: null,
      releaseTitle: null,
      releaseNotes: null,
      includedPrs: [],
      targetSha: input.triggerMergeSha,
      githubReleaseId: null,
      githubReleaseUrl: null,
      error: null,
      completedAt: null,
    });

    this.scheduleProcessing(created.id);
    return created;
  }

  async retryReleaseRun(id: string): Promise<ReleaseRun | undefined> {
    const existing = await this.storage.getReleaseRun(id);
    if (!existing) {
      return undefined;
    }

    const reset = await this.storage.updateReleaseRun(id, {
      status: "detected",
      error: null,
      completedAt: null,
    });

    if (!reset) {
      return undefined;
    }

    this.scheduleProcessing(id);
    return reset;
  }

  async processReleaseRun(id: string): Promise<ReleaseRun | undefined> {
    const initial = await this.storage.getReleaseRun(id);
    if (!initial) {
      return undefined;
    }

    return this.withRepoLock(initial.repo, async () => {
      if (this.inProgress.has(id)) {
        return this.storage.getReleaseRun(id);
      }

      this.inProgress.add(id);
      try {
        const run = await this.storage.getReleaseRun(id);
        if (!run) {
          return undefined;
        }

        if (run.status === "published" || run.status === "skipped") {
          return run;
        }

        const parsedRepo = parseRepoSlug(run.repo);
        if (!parsedRepo) {
          return this.failRun(id, `Invalid repository slug: ${run.repo}`);
        }

        const config = await this.storage.getConfig();
        if (!config.autoCreateReleases) {
          const skipped = await this.storage.updateReleaseRun(id, {
            status: "skipped",
            decisionReason: "Automatic release creation is disabled in settings",
            completedAt: new Date().toISOString(),
          });
          return skipped ?? undefined;
        }

        await this.storage.updateReleaseRun(id, {
          status: "evaluating",
          error: null,
          completedAt: null,
        });

        const octokit = await this.github.buildOctokit(config);
        const latestTag = await this.github.findLatestSemverReleaseTag(octokit, parsedRepo);
        const triggerPr = toTriggerSummary(run);
        const includedPulls = await this.loadIncludedPulls(octokit, parsedRepo, run, triggerPr);
        const includedPrs = includedPulls.map(toIncludedPR);
        const decision = await this.evaluateRelease({
          preferredAgent: config.codingAgent as CodingAgent,
          repo: run.repo,
          baseBranch: run.baseBranch,
          latestTag,
          triggerPr,
          includedPulls: includedPulls,
        });

        if (!decision.shouldRelease) {
          const skipped = await this.storage.updateReleaseRun(id, {
            status: "skipped",
            decisionReason: decision.reason,
            recommendedBump: null,
            proposedVersion: null,
            releaseTitle: null,
            releaseNotes: null,
            includedPrs,
            targetSha: run.triggerMergeSha,
            completedAt: new Date().toISOString(),
          });
          return skipped ?? undefined;
        }

        if (!decision.bump) {
          throw new Error("Release evaluation approved publishing but did not provide a semver bump");
        }

        const proposedVersion = this.github.bumpReleaseTag(latestTag, decision.bump);
        const releaseTitle = normalizeReleaseTitle(decision, proposedVersion);
        const releaseNotes = decision.notes ?? `Release ${proposedVersion}`;
        await this.storage.updateReleaseRun(id, {
          status: "proposed",
          decisionReason: decision.reason,
          recommendedBump: decision.bump,
          proposedVersion,
          releaseTitle,
          releaseNotes,
          includedPrs,
          targetSha: run.triggerMergeSha,
        });

        const existingRelease = this.github.findReleaseByTag
          ? await this.github.findReleaseByTag(octokit, parsedRepo, proposedVersion)
          : null;

        if (existingRelease) {
          const published = await this.storage.updateReleaseRun(id, {
            status: "published",
            githubReleaseId: existingRelease.id,
            githubReleaseUrl: existingRelease.url,
            completedAt: new Date().toISOString(),
          });
          return published ?? undefined;
        }

        await this.storage.updateReleaseRun(id, {
          status: "publishing",
        });

        const created = await this.github.createGitHubRelease(octokit, parsedRepo, {
          tagName: proposedVersion,
          targetCommitish: run.triggerMergeSha,
          name: releaseTitle,
          body: releaseNotes,
        });

        const published = await this.storage.updateReleaseRun(id, {
          status: "published",
          githubReleaseId: created.id,
          githubReleaseUrl: created.url,
          completedAt: new Date().toISOString(),
        });

        return published ?? undefined;
      } catch (error) {
        return this.failRun(id, summarizeError(error));
      } finally {
        this.inProgress.delete(id);
      }
    });
  }

  private async loadIncludedPulls(
    octokit: Octokit,
    repo: ReleaseRepo,
    run: ReleaseRun,
    triggerPr: ReleaseAgentPullSummary,
  ): Promise<ReleaseAgentPullSummary[]> {
    if (!this.github.listMergedPullsForReleaseCandidate) {
      return [triggerPr];
    }

    const included = await this.github.listMergedPullsForReleaseCandidate(octokit, repo, {
      baseBranch: run.baseBranch,
      untilMergedAt: run.triggerMergedAt,
      triggerPr,
    });

    const deduped = new Map<string, ReleaseAgentPullSummary>();
    for (const pr of included) {
      deduped.set(pr.mergeSha || `${pr.repo}#${pr.number}`, pr);
    }
    if (!deduped.has(triggerPr.mergeSha)) {
      deduped.set(triggerPr.mergeSha, triggerPr);
    }

    return Array.from(deduped.values()).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  }

  private async failRun(id: string, error: string): Promise<ReleaseRun | undefined> {
    return this.storage.updateReleaseRun(id, {
      status: "error",
      error,
      completedAt: new Date().toISOString(),
    });
  }

  private async withRepoLock<T>(
    repo: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousLock = this.repoLocks.get(repo) ?? Promise.resolve();
    let releaseCurrentLock: (() => void) | undefined;
    const currentLock = new Promise<void>((resolve) => {
      releaseCurrentLock = () => resolve();
    });
    const lockQueue = previousLock.then(() => currentLock);
    this.repoLocks.set(repo, lockQueue);

    await previousLock;
    try {
      return await operation();
    } finally {
      releaseCurrentLock?.();
      if (this.repoLocks.get(repo) === lockQueue) {
        this.repoLocks.delete(repo);
      }
    }
  }

  private scheduleProcessing(id: string): void {
    const job = this.processReleaseRun(id)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.backgroundJobs.delete(job);
      });
    this.backgroundJobs.add(job);
  }
}

function toTriggerSummary(run: ReleaseRun): ReleaseAgentPullSummary {
  return {
    number: run.triggerPrNumber,
    title: run.triggerPrTitle,
    url: run.triggerPrUrl,
    author: "unknown",
    repo: run.repo,
    mergedAt: run.triggerMergedAt,
    mergeSha: run.triggerMergeSha,
  };
}

function toIncludedPR(pr: ReleaseAgentPullSummary): ReleaseRunIncludedPR {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    mergedAt: pr.mergedAt,
    mergeSha: pr.mergeSha,
  };
}

function normalizeReleaseTitle(
  decision: ReleaseEvaluationDecision,
  version: string,
): string {
  const title = decision.title?.trim();
  if (!title) {
    return version;
  }

  return title.startsWith(version) ? title : `${version} - ${title}`;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000);
}

function isTerminalReleaseStatus(status: ReleaseRun["status"]): boolean {
  return status === "skipped" || status === "published";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
