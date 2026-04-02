import type { PR, TriageDecision, FeedbackItem } from "@shared/schema";
import type { IStorage } from "./storage";
import {
  applyManualDecision,
  markReviewConversationResolved,
  shouldResolveReviewConversation,
} from "./feedbackLifecycle";
import {
  buildOctokit,
  GitHubIntegrationError,
  parsePRUrl,
  resolveReviewThread,
} from "./github";

export type ManualFeedbackGitHubService = {
  buildOctokit: typeof buildOctokit;
  resolveReviewThread: typeof resolveReviewThread;
};

const defaultGitHubService: ManualFeedbackGitHubService = {
  buildOctokit,
  resolveReviewThread,
};

function countDecisions(items: FeedbackItem[]): {
  accepted: number;
  rejected: number;
  flagged: number;
} {
  return {
    accepted: items.filter((item) => item.decision === "accept").length,
    rejected: items.filter((item) => item.decision === "reject").length,
    flagged: items.filter((item) => item.decision === "flag").length,
  };
}

export async function applyManualFeedbackDecision(params: {
  storage: IStorage;
  pr: PR;
  feedbackId: string;
  decision: TriageDecision;
  github?: ManualFeedbackGitHubService;
}): Promise<PR | undefined> {
  const {
    storage,
    pr,
    feedbackId,
    decision,
    github = defaultGitHubService,
  } = params;

  let feedbackItems = pr.feedbackItems.map((item) =>
    item.id === feedbackId ? applyManualDecision(item, decision) : item,
  );

  const updatedItem = feedbackItems.find((item) => item.id === feedbackId);
  if (updatedItem?.threadId && shouldResolveReviewConversation(updatedItem)) {
    const parsedPr = parsePRUrl(pr.url);
    if (!parsedPr) {
      throw new GitHubIntegrationError(`Invalid PR URL: ${pr.url}`, 500);
    }

    const config = await storage.getConfig();
    const octokit = await github.buildOctokit(config);
    await github.resolveReviewThread(octokit, parsedPr, updatedItem.threadId);

    feedbackItems = feedbackItems.map((item) =>
      item.id === feedbackId ? markReviewConversationResolved(item) : item,
    );
  }

  const counters = countDecisions(feedbackItems);
  return storage.updatePR(pr.id, {
    feedbackItems,
    accepted: counters.accepted,
    rejected: counters.rejected,
    flagged: counters.flagged,
  });
}
