import { Octokit } from "@octokit/rest";
import type { Config, FeedbackItem } from "@shared/schema";
import { runCommand } from "./agentRunner";
import { renderGitHubMarkdown } from "./markdown";

export type ParsedPRUrl = {
  owner: string;
  repo: string;
  number: number;
};

export type ParsedRepoSlug = {
  owner: string;
  repo: string;
};

export type GitHubPullSummary = {
  number: number;
  title: string;
  branch: string;
  author: string;
  url: string;
  repoFullName: string;
  repoCloneUrl: string;
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  headRepoCloneUrl: string;
};

export type GitHubStatusFailure = {
  context: string;
  description: string;
  targetUrl: string | null;
};

const GITHUB_API_VERSION = "2022-11-28";
const GH_AUTH_CACHE_TTL_MS = 15000;
const REVIEW_THREADS_QUERY = `
  query CodeFactoryReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;
const REVIEW_THREAD_COMMENTS_QUERY = `
  query CodeFactoryReviewThreadComments($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        id
        isResolved
        comments(first: 100, after: $cursor) {
          nodes {
            databaseId
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;
const REVIEW_THREAD_REPLY_MUTATION = `
  mutation CodeFactoryReplyToReviewThread($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment {
        id
      }
    }
  }
`;
const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation CodeFactoryResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

let cachedGhAuthToken: { token: string; expiresAt: number } | null = null;
let ghAuthFailureCooldownUntil = 0;

type GitHubErrorLike = Error & {
  status?: number;
  response?: {
    headers?: Record<string, string>;
  };
};

export class GitHubIntegrationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "GitHubIntegrationError";
    this.statusCode = statusCode;
  }
}

export function parsePRUrl(url: string): ParsedPRUrl | null {
  const match = url
    .trim()
    .match(/https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);

  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10),
  };
}

export function parseRepoSlug(input: string): ParsedRepoSlug | null {
  const trimmed = input.trim();
  const githubMatch = trimmed.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:[/?#].*)?$/i);
  if (githubMatch) {
    return {
      owner: githubMatch[1],
      repo: githubMatch[2],
    };
  }

  const slugMatch = trimmed.match(/^([^/]+)\/([^/]+)$/);
  if (!slugMatch) return null;

  return {
    owner: slugMatch[1],
    repo: slugMatch[2],
  };
}

export function formatRepoSlug(parsed: ParsedRepoSlug): string {
  return `${parsed.owner}/${parsed.repo}`;
}

type ReviewThreadLookup = Map<number, {
  threadId: string;
  threadResolved: boolean;
}>;
type ReviewThreadCommentsConnection = {
  nodes?: Array<{
    databaseId?: number | null;
  }> | null;
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
};

type ReviewThreadNode = {
  id?: string | null;
  isResolved?: boolean | null;
  comments?: ReviewThreadCommentsConnection | null;
};

export function buildFeedbackAuditToken(feedbackId: string): string {
  return `codefactory-feedback:${feedbackId}`;
}

export async function resolveGitHubAuthToken(config: Config): Promise<string | undefined> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const configuredToken = config.githubToken?.trim();
  if (configuredToken) {
    return configuredToken;
  }

  const now = Date.now();
  if (cachedGhAuthToken && cachedGhAuthToken.expiresAt > now) {
    return cachedGhAuthToken.token;
  }

  if (ghAuthFailureCooldownUntil > now) {
    return undefined;
  }

  const result = await runCommand("gh", ["auth", "token"], {
    timeoutMs: 4000,
  });

  const token = result.stdout.trim();
  if (result.code === 0 && token) {
    cachedGhAuthToken = {
      token,
      expiresAt: now + GH_AUTH_CACHE_TTL_MS,
    };
    ghAuthFailureCooldownUntil = 0;
    return token;
  }

  cachedGhAuthToken = null;
  ghAuthFailureCooldownUntil = now + GH_AUTH_CACHE_TTL_MS;
  return undefined;
}

function formatGitHubTarget(resource: ParsedPRUrl | ParsedRepoSlug): string {
  if ("number" in resource) {
    return `${resource.owner}/${resource.repo}#${resource.number}`;
  }

  return `${resource.owner}/${resource.repo}`;
}

function toGitHubIntegrationError(
  error: unknown,
  context: string,
  resource: ParsedPRUrl | ParsedRepoSlug,
): GitHubIntegrationError {
  if (error instanceof GitHubIntegrationError) {
    return error;
  }

  const target = formatGitHubTarget(resource);
  const status = typeof (error as GitHubErrorLike | undefined)?.status === "number"
    ? (error as GitHubErrorLike).status!
    : 502;
  const authHelp = "Run `gh auth login` on this machine or set `GITHUB_TOKEN` if the repository is private.";

  if (status === 401) {
    return new GitHubIntegrationError(
      `GitHub authentication failed while loading ${context} for ${target}. ${authHelp}`,
      status,
    );
  }

  if (status === 403) {
    const headers = (error as GitHubErrorLike | undefined)?.response?.headers;
    const rateLimitRemaining = headers?.["x-ratelimit-remaining"];
    const lowerMessage = error instanceof Error ? error.message.toLowerCase() : "";
    const isRateLimited = rateLimitRemaining === "0" || lowerMessage.includes("rate limit");

    if (isRateLimited) {
      return new GitHubIntegrationError(
        `GitHub rate limit reached while loading ${context} for ${target}. Authenticate with \`gh auth login\` or set \`GITHUB_TOKEN\` to raise the limit.`,
        status,
      );
    }

    return new GitHubIntegrationError(
      `GitHub denied access while loading ${context} for ${target}. ${authHelp}`,
      status,
    );
  }

  if (status === 404) {
    return new GitHubIntegrationError(
      `GitHub could not access ${target} while loading ${context}. Confirm the repository and PR exist. ${authHelp}`,
      status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new GitHubIntegrationError(
    `GitHub request failed while loading ${context} for ${target}: ${message}`,
    status,
  );
}

async function withGitHubErrorHandling<T>(
  context: string,
  resource: ParsedPRUrl | ParsedRepoSlug,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw toGitHubIntegrationError(error, context, resource);
  }
}

export async function buildOctokit(config: Config): Promise<Octokit> {
  const auth = await resolveGitHubAuthToken(config);

  return new Octokit({
    auth,
    request: {
      headers: {
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    },
  });
}

export async function fetchPullSummary(
  octokit: Octokit,
  parsed: ParsedPRUrl,
): Promise<GitHubPullSummary> {
  const response = await withGitHubErrorHandling("PR metadata", parsed, () =>
    octokit.pulls.get({
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
    }),
  );

  const pull = response.data;

  return {
    number: pull.number,
    title: pull.title || `PR #${pull.number}`,
    branch: pull.head?.ref || "unknown",
    author: pull.user?.login || "",
    url: pull.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/pull/${pull.number}`,
    repoFullName: pull.base?.repo?.full_name || `${parsed.owner}/${parsed.repo}`,
    repoCloneUrl: pull.base?.repo?.clone_url || `https://github.com/${parsed.owner}/${parsed.repo}.git`,
    headSha: pull.head?.sha || "",
    headRef: pull.head?.ref || "",
    headRepoFullName: pull.head?.repo?.full_name || `${parsed.owner}/${parsed.repo}`,
    headRepoCloneUrl: pull.head?.repo?.clone_url || `https://github.com/${parsed.owner}/${parsed.repo}.git`,
  };
}

function shouldIgnoreAuthor(
  authorLogin: string | null | undefined,
  ignoredBots: Set<string>,
): boolean {
  if (!authorLogin) {
    return true;
  }

  const lowered = authorLogin.toLowerCase();
  if (ignoredBots.has(lowered)) {
    return true;
  }

  return false;
}

function addReviewThreadCommentsToLookup(
  lookup: ReviewThreadLookup,
  threadId: string,
  threadResolved: boolean,
  comments?: ReviewThreadCommentsConnection | null,
): void {
  for (const comment of comments?.nodes || []) {
    if (typeof comment?.databaseId !== "number") {
      continue;
    }

    lookup.set(comment.databaseId, {
      threadId,
      threadResolved,
    });
  }
}

async function appendPaginatedReviewThreadComments(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  lookup: ReviewThreadLookup,
  thread: ReviewThreadNode,
): Promise<void> {
  if (!thread.id) {
    return;
  }

  let cursor = thread.comments?.pageInfo?.hasNextPage && thread.comments.pageInfo.endCursor
    ? thread.comments.pageInfo.endCursor
    : null;
  let threadResolved = Boolean(thread.isResolved);

  while (cursor) {
    const response = await withGitHubErrorHandling("review thread comments", parsed, () =>
      octokit.request("POST /graphql", {
        query: REVIEW_THREAD_COMMENTS_QUERY,
        threadId: thread.id,
        cursor,
      }),
    );

    const paginatedThread = (response.data as {
      node?: ReviewThreadNode | null;
    }).node;

    if (!paginatedThread?.id) {
      break;
    }

    if (typeof paginatedThread.isResolved === "boolean") {
      threadResolved = paginatedThread.isResolved;
    }

    addReviewThreadCommentsToLookup(
      lookup,
      paginatedThread.id,
      threadResolved,
      paginatedThread.comments,
    );

    const pageInfo = paginatedThread.comments?.pageInfo;
    cursor = pageInfo?.hasNextPage && pageInfo.endCursor
      ? pageInfo.endCursor
      : null;
  }
}

async function fetchReviewThreadLookup(
  octokit: Octokit,
  parsed: ParsedPRUrl,
): Promise<ReviewThreadLookup> {
  const lookup: ReviewThreadLookup = new Map();
  let cursor: string | null = null;

  while (true) {
    const response = await withGitHubErrorHandling("review threads", parsed, () =>
      octokit.request("POST /graphql", {
        query: REVIEW_THREADS_QUERY,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        cursor,
      }),
    );

    const reviewThreads = (response.data as {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: ReviewThreadNode[];
            pageInfo?: {
              hasNextPage?: boolean | null;
              endCursor?: string | null;
            };
          };
        };
      };
    }).repository?.pullRequest?.reviewThreads;

    for (const thread of reviewThreads?.nodes || []) {
      if (!thread?.id) {
        continue;
      }

      addReviewThreadCommentsToLookup(lookup, thread.id, Boolean(thread.isResolved), thread.comments);
      await appendPaginatedReviewThreadComments(octokit, parsed, lookup, thread);
    }

    const pageInfo = reviewThreads?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
      break;
    }

    cursor = pageInfo.endCursor;
  }

  return lookup;
}

export async function replyToReviewThread(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  threadId: string,
  body: string,
): Promise<void> {
  await withGitHubErrorHandling("review thread reply", parsed, () =>
    octokit.request("POST /graphql", {
      query: REVIEW_THREAD_REPLY_MUTATION,
      threadId,
      body,
    }),
  );
}

export async function resolveReviewThread(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  threadId: string,
): Promise<void> {
  await withGitHubErrorHandling("review thread resolution", parsed, () =>
    octokit.request("POST /graphql", {
      query: RESOLVE_REVIEW_THREAD_MUTATION,
      threadId,
    }),
  );
}

export async function replyToReview(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  body: string,
): Promise<void> {
  await withGitHubErrorHandling("review follow-up", parsed, () =>
    octokit.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body,
    }),
  );
}

export async function replyToIssueComment(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  body: string,
): Promise<void> {
  await withGitHubErrorHandling("issue comment follow-up", parsed, () =>
    octokit.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body,
    }),
  );
}

export async function postFollowUpForFeedbackItem(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  item: FeedbackItem,
  body: string,
): Promise<void> {
  if (item.replyKind === "review_thread") {
    if (!item.threadId) {
      throw new GitHubIntegrationError(
        `GitHub could not determine the review thread for feedback item ${item.id} on ${formatGitHubTarget(parsed)}.`,
        502,
      );
    }

    await replyToReviewThread(octokit, parsed, item.threadId, body);
    return;
  }

  if (item.replyKind === "review") {
    await replyToReview(octokit, parsed, body);
    return;
  }

  await replyToIssueComment(octokit, parsed, body);
}

export async function fetchFeedbackItemsForPR(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  config: Config,
): Promise<FeedbackItem[]> {
  const ignoredBots = new Set(config.ignoredBots.map((login) => login.toLowerCase()));

  const [reviewComments, reviews, issueComments, reviewThreads] = await Promise.all([
    withGitHubErrorHandling("review comments", parsed, () => octokit.paginate(octokit.pulls.listReviewComments, {
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
      per_page: 100,
    })),
    withGitHubErrorHandling("reviews", parsed, () => octokit.paginate(octokit.pulls.listReviews, {
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
      per_page: 100,
    })),
    withGitHubErrorHandling("issue comments", parsed, () => octokit.paginate(octokit.issues.listComments, {
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      per_page: 100,
    })),
    fetchReviewThreadLookup(octokit, parsed),
  ]);

  const reviewCommentItems: FeedbackItem[] = reviewComments
    .filter((comment) => !shouldIgnoreAuthor(comment.user?.login, ignoredBots))
    .map((comment) => {
      const id = `gh-review-comment-${comment.id}`;
      const thread = reviewThreads.get(comment.id);

      return {
        id,
        author: comment.user?.login || "unknown",
        body: comment.body || "",
        bodyHtml: renderGitHubMarkdown(comment.body || ""),
        replyKind: "review_thread" as const,
        sourceId: String(comment.id),
        sourceNodeId: comment.node_id || null,
        sourceUrl: comment.html_url || null,
        threadId: thread?.threadId || null,
        threadResolved: typeof thread?.threadResolved === "boolean" ? thread.threadResolved : null,
        auditToken: buildFeedbackAuditToken(id),
        file: comment.path || null,
        line: comment.line ?? comment.original_line ?? null,
        type: "review_comment" as const,
        createdAt: comment.created_at || new Date().toISOString(),
        decision: null,
        decisionReason: null,
        action: null,
      };
    })
    .filter((item) => item.body.trim().length > 0);

  const reviewItems: FeedbackItem[] = reviews
    .filter((review) => !shouldIgnoreAuthor(review.user?.login, ignoredBots))
    .map((review) => {
      const id = `gh-review-${review.id}`;

      return {
        id,
        author: review.user?.login || "unknown",
        body: review.body || "",
        bodyHtml: renderGitHubMarkdown(review.body || ""),
        replyKind: "review" as const,
        sourceId: String(review.id),
        sourceNodeId: review.node_id || null,
        sourceUrl: review.html_url || null,
        threadId: null,
        threadResolved: null,
        auditToken: buildFeedbackAuditToken(id),
        file: null,
        line: null,
        type: "review" as const,
        createdAt: review.submitted_at || new Date().toISOString(),
        decision: null,
        decisionReason: null,
        action: null,
      };
    })
    .filter((item) => item.body.trim().length > 0);

  const issueCommentItems: FeedbackItem[] = issueComments
    .filter((comment) => !shouldIgnoreAuthor(comment.user?.login, ignoredBots))
    .map((comment) => {
      const id = `gh-issue-comment-${comment.id}`;

      return {
        id,
        author: comment.user?.login || "unknown",
        body: comment.body || "",
        bodyHtml: renderGitHubMarkdown(comment.body || ""),
        replyKind: "general_comment" as const,
        sourceId: String(comment.id),
        sourceNodeId: comment.node_id || null,
        sourceUrl: comment.html_url || null,
        threadId: null,
        threadResolved: null,
        auditToken: buildFeedbackAuditToken(id),
        file: null,
        line: null,
        type: "general_comment" as const,
        createdAt: comment.created_at || new Date().toISOString(),
        decision: null,
        decisionReason: null,
        action: null,
      };
    })
    .filter((item) => item.body.trim().length > 0);

  const combined = [...reviewCommentItems, ...reviewItems, ...issueCommentItems];

  combined.sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return combined;
}

export async function listOpenPullsForRepo(
  octokit: Octokit,
  repo: ParsedRepoSlug,
): Promise<GitHubPullSummary[]> {
  const pulls = await withGitHubErrorHandling("open pull requests", repo, () => octokit.paginate(octokit.pulls.list, {
    owner: repo.owner,
    repo: repo.repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  }));

  return pulls.map((pull) => ({
    number: pull.number,
    title: pull.title || `PR #${pull.number}`,
    branch: pull.head?.ref || "unknown",
    author: pull.user?.login || "",
    url: pull.html_url || `https://github.com/${repo.owner}/${repo.repo}/pull/${pull.number}`,
    repoFullName: pull.base?.repo?.full_name || `${repo.owner}/${repo.repo}`,
    repoCloneUrl: pull.base?.repo?.clone_url || `https://github.com/${repo.owner}/${repo.repo}.git`,
    headSha: pull.head?.sha || "",
    headRef: pull.head?.ref || "",
    headRepoFullName: pull.head?.repo?.full_name || `${repo.owner}/${repo.repo}`,
    headRepoCloneUrl: pull.head?.repo?.clone_url || `https://github.com/${repo.owner}/${repo.repo}.git`,
  }));
}

export async function listFailingStatuses(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  headSha: string,
): Promise<GitHubStatusFailure[]> {
  if (!headSha) return [];

  const response = await withGitHubErrorHandling("commit statuses", repo, () => octokit.repos.getCombinedStatusForRef({
    owner: repo.owner,
    repo: repo.repo,
    ref: headSha,
  }));

  return response.data.statuses
    .filter((status) => status.state === "failure" || status.state === "error")
    .map((status) => ({
      context: status.context || "status-check",
      description: status.description || "Failed status check",
      targetUrl: status.target_url || null,
    }));
}
