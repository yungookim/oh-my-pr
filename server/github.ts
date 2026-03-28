import { Octokit } from "@octokit/rest";
import type { Config, FeedbackItem } from "@shared/schema";
import { z } from "zod";
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
  baseRef: string;
  mergeable: boolean | null;
};

export type GitHubStatusFailure = {
  context: string;
  description: string;
  targetUrl: string | null;
};

export type GitHubPullCloseState = {
  number: number;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  mergeCommitSha: string | null;
};

export type ReleaseBump = "patch" | "minor" | "major";

export type SemverVersion = {
  major: number;
  minor: number;
  patch: number;
};

export type GitHubReleaseSummary = {
  id: number;
  tagName: string;
  name: string;
  body: string | null;
  htmlUrl: string;
  apiUrl: string;
  draft: boolean;
  prerelease: boolean;
  targetCommitish: string | null;
  publishedAt: string | null;
};

export type GitHubRepoTag = {
  name: string;
  commitSha: string | null;
};

const SEMVER_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

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
        databaseId
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

const statusReplyMutationSchema = z.object({
  addPullRequestReviewThreadReply: z.object({
    comment: z.object({
      databaseId: z.number().nullable().optional(),
    }).nullable().optional(),
  }).nullable().optional(),
});

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

export type CodeReviewPresence = {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
};

export type RepoOnboardingStatus = {
  repo: string;
  accessible: boolean;
  error?: string;
  codeReviews: CodeReviewPresence;
};

export type OnboardingStatus = {
  githubConnected: boolean;
  githubError?: string;
  githubUser?: string;
  repos: RepoOnboardingStatus[];
};

type OnboardingStatusDeps = {
  buildOctokitFn?: typeof buildOctokit;
  resolveGitHubAuthTokenFn?: typeof resolveGitHubAuthToken;
};

export async function checkOnboardingStatus(
  config: Config,
  watchedRepos: string[],
  deps: OnboardingStatusDeps = {},
): Promise<OnboardingStatus> {
  const buildOctokitFn = deps.buildOctokitFn ?? buildOctokit;
  const resolveGitHubAuthTokenFn = deps.resolveGitHubAuthTokenFn ?? resolveGitHubAuthToken;
  let octokit: Octokit;
  let githubConnected = false;
  let githubError: string | undefined;
  let githubUser: string | undefined;

  try {
    octokit = await buildOctokitFn(config);
    const auth = await resolveGitHubAuthTokenFn(config);
    if (!auth) {
      githubError = "No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN, or enter a Personal Access Token in settings.";
    } else {
      const { data } = await octokit.rest.users.getAuthenticated();
      githubConnected = true;
      githubUser = data.login;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    githubError = msg;
    return { githubConnected: false, githubError, repos: [] };
  }

  const repos: RepoOnboardingStatus[] = await Promise.all(
    watchedRepos.map(async (repoSlug): Promise<RepoOnboardingStatus> => {
      const parsed = parseRepoSlug(repoSlug);
      if (!parsed) {
        return { repo: repoSlug, accessible: false, error: "Invalid repo slug", codeReviews: { claude: false, codex: false, gemini: false } };
      }

      try {
        const { data: files } = await octokit.rest.repos.getContent({
          owner: parsed.owner,
          repo: parsed.repo,
          path: ".github/workflows",
        });

        const fileList = Array.isArray(files) ? files : [];
        const names = fileList.map((f) => ("name" in f ? f.name.toLowerCase() : ""));
        const contentResults = await Promise.all(
          fileList
            .filter((f) => "name" in f && "path" in f && f.path && (f.name.endsWith(".yml") || f.name.endsWith(".yaml")))
            .map(async (f) => {
              try {
                const { data: fileContent } = await octokit.rest.repos.getContent({
                  owner: parsed.owner,
                  repo: parsed.repo,
                  path: f.path as string,
                });
                if (!Array.isArray(fileContent) && "content" in fileContent && fileContent.content) {
                  return Buffer.from(fileContent.content, "base64").toString("utf-8");
                }
              } catch {
                // Keep matching behavior: silently ignore per-file read failures.
                return "";
              }
              return "";
            }),
        );
        const allContent = contentResults.join("\n").toLowerCase();

        const claude = names.some((n) => n.includes("claude")) || allContent.includes("claude-code-action") || allContent.includes("anthropics/claude");
        const codex = names.some((n) => n.includes("codex")) || allContent.includes("openai/codex-action") || allContent.includes("codex-action");
        const gemini = names.some((n) => n.includes("gemini")) || allContent.includes("gemini-code-assist") || allContent.includes("run-gemini-cli") || allContent.includes("google-github-actions/run-gemini");

        return { repo: repoSlug, accessible: true, codeReviews: { claude, codex, gemini } };
      } catch (err) {
        const status = typeof (err as { status?: number })?.status === "number" ? (err as { status: number }).status : 0;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 404) {
          // Workflows dir doesn't exist — repo is accessible but no workflows
          return { repo: repoSlug, accessible: true, codeReviews: { claude: false, codex: false, gemini: false } };
        }
        return { repo: repoSlug, accessible: false, error: msg, codeReviews: { claude: false, codex: false, gemini: false } };
      }
    }),
  );

  return { githubConnected, githubUser, repos };
}

export type ReviewTool = "claude" | "codex";

const WORKFLOW_TEMPLATES: Record<ReviewTool, { filename: string; content: string }> = {
  claude: {
    filename: "claude-code-review.yml",
    content: `name: Claude Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  code-review:
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          prompt: "Review this pull request for code quality, correctness, and security. Post your findings as review comments."
`,
  },
  codex: {
    filename: "codex-code-review.yml",
    content: `name: Codex Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  code-review:
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: openai/codex-action@v1
        with:
          openai-api-key: \${{ secrets.OPENAI_API_KEY }}
          prompt: |
            Review this pull request. Focus on:
            - Code correctness and potential bugs
            - Security issues
            - Performance concerns
            - Code style and readability
            Post your review as GitHub PR review comments.
`,
  },
};

export async function installCodeReviewWorkflow(
  config: Config,
  repoSlug: string,
  tool: ReviewTool,
): Promise<{ path: string; url: string }> {
  const parsed = parseRepoSlug(repoSlug);
  if (!parsed) {
    throw new GitHubIntegrationError(`Invalid repository: ${repoSlug}`, 400);
  }

  const octokit = await buildOctokit(config);
  const template = WORKFLOW_TEMPLATES[tool];
  const path = `.github/workflows/${template.filename}`;
  const contentBase64 = Buffer.from(template.content).toString("base64");

  // Check if file already exists to get its SHA (required for updates)
  let existingSha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: parsed.owner,
      repo: parsed.repo,
      path,
    });
    if (!Array.isArray(data) && "sha" in data) {
      existingSha = data.sha;
    }
  } catch (err) {
    const status = typeof (err as { status?: number })?.status === "number" ? (err as { status: number }).status : 0;
    if (status !== 404) {
      throw toGitHubIntegrationError(err, "workflow file check", parsed);
    }
    // 404 means file doesn't exist yet — that's fine
  }

  const commitMessage = existingSha
    ? `ci: update ${tool} code review workflow`
    : `ci: add ${tool} code review workflow`;

  const response = await withGitHubErrorHandling("workflow file creation", parsed, () =>
    octokit.rest.repos.createOrUpdateFileContents({
      owner: parsed.owner,
      repo: parsed.repo,
      path,
      message: commitMessage,
      content: contentBase64,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  );

  return {
    path,
    url: response.data.content?.html_url ?? `https://github.com/${repoSlug}/blob/HEAD/${path}`,
  };
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
  const baseRef = pull.base?.ref || pull.base?.repo?.default_branch || "";

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
    baseRef,
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
  };
}

export async function fetchPullCloseState(
  octokit: Octokit,
  parsed: ParsedPRUrl,
): Promise<GitHubPullCloseState> {
  const response = await withGitHubErrorHandling("PR close state", parsed, () =>
    octokit.pulls.get({
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
    }),
  );

  const pull = response.data;
  const baseRef = pull.base?.ref || pull.base?.repo?.default_branch || "";

  return {
    number: pull.number,
    title: pull.title || `PR #${pull.number}`,
    url: pull.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/pull/${pull.number}`,
    author: pull.user?.login || "unknown",
    baseRef,
    headRef: pull.head?.ref || "",
    headSha: pull.head?.sha || "",
    merged: Boolean(pull.merged_at),
    mergedAt: pull.merged_at || null,
    closedAt: pull.closed_at || null,
    mergeCommitSha: pull.merge_commit_sha || null,
  };
}

export function parseSemverTag(tagName: string): SemverVersion | null {
  const match = tagName.trim().match(SEMVER_TAG_PATTERN);
  if (!match) return null;

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareSemver(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatSemverTag(version: SemverVersion): string {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

export function selectLatestSemverTag(tagNames: string[]): string | null {
  let winner: { tag: string; version: SemverVersion } | null = null;

  for (const tag of tagNames) {
    const parsed = parseSemverTag(tag);
    if (!parsed) continue;

    if (!winner || compareSemver(parsed, winner.version) > 0) {
      winner = { tag, version: parsed };
    }
  }

  return winner?.tag ?? null;
}

export function resolveNextSemverTag(
  latestTag: string | null | undefined,
  bump: ReleaseBump,
): string {
  const current = latestTag
    ? parseSemverTag(latestTag)
    : { major: 0, minor: 0, patch: 0 };

  if (!current) {
    throw new GitHubIntegrationError(`Cannot calculate next semver tag from invalid tag: ${latestTag}`, 400);
  }

  const next: SemverVersion = {
    major: current.major,
    minor: current.minor,
    patch: current.patch,
  };

  if (bump === "major") {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (bump === "minor") {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }

  return formatSemverTag(next);
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function getDefaultBranchForRepo(
  octokit: Octokit,
  repo: ParsedRepoSlug,
): Promise<string> {
  const response = await withGitHubErrorHandling("repository metadata", repo, () =>
    octokit.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    }),
  );

  const defaultBranch = response.data.default_branch?.trim();
  if (!defaultBranch) {
    throw new GitHubIntegrationError(`GitHub did not return a default branch for ${formatRepoSlug(repo)}`, 502);
  }

  return defaultBranch;
}

export async function listReleasesForRepo(
  octokit: Octokit,
  repo: ParsedRepoSlug,
): Promise<GitHubReleaseSummary[]> {
  const releases = await withGitHubErrorHandling("repository releases", repo, () =>
    octokit.paginate(octokit.repos.listReleases, {
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    }),
  );

  return releases.map((release) => ({
    id: release.id,
    tagName: release.tag_name || "",
    name: release.name || release.tag_name || `Release ${release.id}`,
    body: release.body || null,
    htmlUrl: release.html_url || "",
    apiUrl: release.url || "",
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    targetCommitish: release.target_commitish || null,
    publishedAt: release.published_at || null,
  }));
}

export async function listTagsForRepo(
  octokit: Octokit,
  repo: ParsedRepoSlug,
): Promise<GitHubRepoTag[]> {
  const tags = await withGitHubErrorHandling("repository tags", repo, () =>
    octokit.paginate(octokit.repos.listTags, {
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    }),
  );

  return tags.map((tag) => ({
    name: tag.name,
    commitSha: tag.commit?.sha || null,
  }));
}

export async function getLatestSemverTagForRepo(
  octokit: Octokit,
  repo: ParsedRepoSlug,
): Promise<string | null> {
  const [releases, tags] = await Promise.all([
    listReleasesForRepo(octokit, repo),
    listTagsForRepo(octokit, repo),
  ]);

  const candidates = [
    ...releases
      .filter((release) => !release.draft)
      .map((release) => release.tagName),
    ...tags.map((tag) => tag.name),
  ];

  return selectLatestSemverTag(candidates);
}

export async function createGitHubRelease(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  input: {
    tagName: string;
    name: string;
    body: string;
    targetCommitish?: string | null;
    draft?: boolean;
    prerelease?: boolean;
    generateReleaseNotes?: boolean;
  },
): Promise<GitHubReleaseSummary> {
  const response = await withGitHubErrorHandling("release creation", repo, () =>
    octokit.repos.createRelease({
      owner: repo.owner,
      repo: repo.repo,
      tag_name: input.tagName,
      name: input.name,
      body: input.body,
      target_commitish: input.targetCommitish ?? undefined,
      draft: input.draft ?? false,
      prerelease: input.prerelease ?? false,
      generate_release_notes: input.generateReleaseNotes ?? false,
    }),
  );

  const release = response.data;
  return {
    id: release.id,
    tagName: release.tag_name || input.tagName,
    name: release.name || input.name,
    body: release.body || null,
    htmlUrl: release.html_url || "",
    apiUrl: release.url || "",
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    targetCommitish: release.target_commitish || null,
    publishedAt: release.published_at || null,
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
        variables: {
          threadId: thread.id,
          cursor,
        },
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
        variables: {
          owner: parsed.owner,
          repo: parsed.repo,
          number: parsed.number,
          cursor,
        },
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
      variables: {
        threadId,
        body,
      },
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
      variables: {
        threadId,
      },
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

export async function postPRComment(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  body: string,
): Promise<void> {
  await withGitHubErrorHandling("PR comment", parsed, () =>
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
  options?: { resolve?: boolean },
): Promise<void> {
  if (item.replyKind === "review_thread") {
    if (!item.threadId) {
      // Thread lookup failed (e.g. GraphQL pagination gap or timing issue).
      // Fall back to a top-level PR comment so the audit trail is still visible.
      const fallbackBody = item.sourceUrl
        ? `> _Could not reply in the review thread directly ([original comment](${item.sourceUrl}))._\n\n${body}`
        : body;
      await replyToIssueComment(octokit, parsed, fallbackBody);
      return;
    }

    await replyToReviewThread(octokit, parsed, item.threadId, body);

    if (options?.resolve) {
      await resolveReviewThread(octokit, parsed, item.threadId);
    }
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
        status: "pending" as const,
        statusReason: null,
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
        status: "pending" as const,
        statusReason: null,
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
        status: "pending" as const,
        statusReason: null,
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
    baseRef: pull.base?.ref || pull.base?.repo?.default_branch || "",
    mergeable: null,
  }));
}

export async function addReactionToComment(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  item: FeedbackItem,
  content: "eyes" | "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket",
): Promise<void> {
  const commentId = Number(item.sourceId);
  if (!Number.isFinite(commentId)) return;

  if (item.type === "review_comment") {
    await withGitHubErrorHandling("reaction on review comment", parsed, () =>
      octokit.reactions.createForPullRequestReviewComment({
        owner: parsed.owner,
        repo: parsed.repo,
        comment_id: commentId,
        content,
      }),
    );
  } else if (item.type === "general_comment") {
    await withGitHubErrorHandling("reaction on issue comment", parsed, () =>
      octokit.reactions.createForIssueComment({
        owner: parsed.owner,
        repo: parsed.repo,
        comment_id: commentId,
        content,
      }),
    );
  }
  // Reviews don't support direct reactions — silently skip.
}

export type StatusReplyRef = {
  commentDatabaseId: number;
  replyKind: FeedbackItem["replyKind"];
  body: string;
};

export async function postStatusReplyForFeedbackItem(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  item: FeedbackItem,
  body: string,
): Promise<StatusReplyRef | null> {
  if (item.replyKind === "review_thread") {
    if (!item.threadId) {
      const fallbackBody = item.sourceUrl
        ? `> _Could not post this status update in the review thread directly ([original comment](${item.sourceUrl}))._\n\n${body}`
        : body;

      const fallbackResult = await withGitHubErrorHandling("status reply fallback", parsed, () =>
        octokit.issues.createComment({
          owner: parsed.owner,
          repo: parsed.repo,
          issue_number: parsed.number,
          body: fallbackBody,
        }),
      );

      return {
        commentDatabaseId: fallbackResult.data.id,
        replyKind: "general_comment",
        body: fallbackBody,
      };
    }

    const result = await withGitHubErrorHandling("status reply in review thread", parsed, () =>
      octokit.request("POST /graphql", {
        query: REVIEW_THREAD_REPLY_MUTATION,
        variables: {
          threadId: item.threadId,
          body,
        },
      }),
    );

    const parsedResult = statusReplyMutationSchema.safeParse(result.data);
    if (!parsedResult.success) {
      throw new GitHubIntegrationError(
        `GitHub returned an unexpected payload while creating a status reply for feedback item ${item.id} on ${formatGitHubTarget(parsed)}.`,
        502,
      );
    }

    const databaseId = parsedResult.data.addPullRequestReviewThreadReply?.comment?.databaseId;
    if (typeof databaseId !== "number") return null;

    return { commentDatabaseId: databaseId, replyKind: item.replyKind, body };
  }

  // For review and general_comment, post an issue comment.
  const result = await withGitHubErrorHandling("status reply", parsed, () =>
    octokit.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body,
    }),
  );

  return { commentDatabaseId: result.data.id, replyKind: item.replyKind, body };
}

/**
 * Updates a status reply comment on GitHub and mutates the local reference object.
 *
 * @param octokit The Octokit instance for API calls.
 * @param parsed The parsed information about the pull request.
 * @param ref The reference to the status reply comment. This object's `body`
 *   property is mutated to reflect the latest GitHub state after a successful update.
 * @param newBody The new content for the comment body.
 */
export async function updateStatusReply(
  octokit: Octokit,
  parsed: ParsedPRUrl,
  ref: StatusReplyRef,
  newBody: string,
): Promise<void> {
  if (ref.replyKind === "review_thread") {
    await withGitHubErrorHandling("update review comment", parsed, () =>
      octokit.pulls.updateReviewComment({
        owner: parsed.owner,
        repo: parsed.repo,
        comment_id: ref.commentDatabaseId,
        body: newBody,
      }),
    );
  } else {
    await withGitHubErrorHandling("update issue comment", parsed, () =>
      octokit.issues.updateComment({
        owner: parsed.owner,
        repo: parsed.repo,
        comment_id: ref.commentDatabaseId,
        body: newBody,
      }),
    );
  }

  ref.body = newBody;
}

export async function listFailingStatuses(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  headSha: string,
): Promise<GitHubStatusFailure[]> {
  if (!headSha) return [];

  // Fetch both commit statuses AND check runs in parallel.
  // GitHub Actions CI/CD reports results as check runs (Checks API),
  // while some integrations use the older commit status API.
  const [statusResponse, checkRunsResponse] = await Promise.all([
    withGitHubErrorHandling("commit statuses", repo, () => octokit.repos.getCombinedStatusForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: headSha,
    })),
    withGitHubErrorHandling("check runs", repo, () => octokit.checks.listForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: headSha,
    })),
  ]);

  const fromStatuses: GitHubStatusFailure[] = statusResponse.data.statuses
    .filter((status) => status.state === "failure" || status.state === "error")
    .map((status) => ({
      context: status.context || "status-check",
      description: status.description || "Failed status check",
      targetUrl: status.target_url || null,
    }));

  const fromCheckRuns: GitHubStatusFailure[] = checkRunsResponse.data.check_runs
    .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled")
    .map((run) => ({
      context: run.name,
      description: run.output?.summary || run.output?.title || `Check run ${run.conclusion}`,
      targetUrl: run.html_url || null,
    }));

  return [...fromStatuses, ...fromCheckRuns];
}

/**
 * Returns whether all CI checks and commit statuses for a ref have settled
 * (i.e., none are still pending/in-progress). Returns false if no checks
 * exist yet or if the API call fails.
 */
export async function checkCISettled(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  headSha: string,
): Promise<boolean> {
  if (!headSha) return false;

  try {
    const [statusResp, checkResp] = await Promise.all([
      withGitHubErrorHandling("commit statuses (settled check)", repo, () => octokit.repos.getCombinedStatusForRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: headSha,
      })),
      withGitHubErrorHandling("check runs (settled check)", repo, () => octokit.checks.listForRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: headSha,
      })),
    ]);

    const hasPendingStatus = statusResp.data.statuses.some((s) => s.state === "pending");
    const hasPendingCheck = checkResp.data.check_runs.some((r) => r.status !== "completed");
    const hasAnyChecks = statusResp.data.statuses.length > 0 || checkResp.data.check_runs.length > 0;

    return hasAnyChecks && !hasPendingStatus && !hasPendingCheck;
  } catch {
    return false;
  }
}

export type MergedPRSummary = {
  number: number;
  title: string;
  url: string;
  author: string;
  repo: string;
  mergedAt: string;
  mergeCommitSha: string | null;
};

function normalizeMergedPullSummary(
  pull: {
    number: number;
    title: string | null;
    html_url: string | null;
    user?: { login?: string | null } | null;
    merged_at: string | null;
    merge_commit_sha?: string | null;
  },
  repo: ParsedRepoSlug,
): MergedPRSummary | null {
  if (!pull.merged_at) return null;

  return {
    number: pull.number,
    title: pull.title || `PR #${pull.number}`,
    url: pull.html_url || `https://github.com/${repo.owner}/${repo.repo}/pull/${pull.number}`,
    author: pull.user?.login ?? "unknown",
    repo: formatRepoSlug(repo),
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha || null,
  };
}

export async function listMergedPullsSince(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  options?: {
    baseRef?: string;
    sinceMergedAt?: string | null;
    sinceMergeCommitSha?: string | null;
  },
): Promise<MergedPRSummary[]> {
  const baseRef = options?.baseRef?.trim() || await getDefaultBranchForRepo(octokit, repo);
  const sinceMergedAtMs = parseDateMs(options?.sinceMergedAt);
  const sinceMergeCommitSha = options?.sinceMergeCommitSha?.trim() || null;

  const pulls = await withGitHubErrorHandling("merged pull requests", repo, () =>
    octokit.paginate(octokit.pulls.list, {
      owner: repo.owner,
      repo: repo.repo,
      state: "closed",
      base: baseRef,
      sort: "updated",
      direction: "desc",
      per_page: 100,
    }),
  );

  const merged = pulls
    .map((pull) => normalizeMergedPullSummary(pull, repo))
    .filter((pull): pull is MergedPRSummary => Boolean(pull))
    .filter((pull) => {
      if (sinceMergedAtMs === null) return true;
      return Date.parse(pull.mergedAt) > sinceMergedAtMs;
    });

  let boundedBySha = merged;
  if (sinceMergeCommitSha) {
    const boundaryIndex = merged.findIndex((pull) => pull.mergeCommitSha === sinceMergeCommitSha);
    if (boundaryIndex >= 0) {
      boundedBySha = merged.slice(0, boundaryIndex);
    }
  }

  return boundedBySha.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
}

export async function listUnreleasedMergedPulls(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  options?: {
    baseRef?: string;
    sinceMergedAt?: string | null;
    sinceMergeCommitSha?: string | null;
  },
): Promise<MergedPRSummary[]> {
  let boundaryMergedAt = options?.sinceMergedAt ?? null;
  const boundaryMergeCommitSha = options?.sinceMergeCommitSha ?? null;

  if (!boundaryMergedAt && !boundaryMergeCommitSha) {
    const releases = await listReleasesForRepo(octokit, repo);
    const latestPublished = releases
      .filter((release) => !release.draft && release.publishedAt)
      .sort((a, b) => Date.parse(b.publishedAt || "") - Date.parse(a.publishedAt || ""))[0];

    boundaryMergedAt = latestPublished?.publishedAt ?? null;
  }

  return listMergedPullsSince(octokit, repo, {
    baseRef: options?.baseRef,
    sinceMergedAt: boundaryMergedAt,
    sinceMergeCommitSha: boundaryMergeCommitSha,
  });
}

/**
 * Returns pull requests that were merged to the given base branch today (UTC).
 * Used to determine whether the social changelog trigger threshold has been reached.
 */
export async function listMergedPullsToday(
  octokit: Octokit,
  repo: ParsedRepoSlug,
  baseRef?: string,
): Promise<MergedPRSummary[]> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const pulls = await listMergedPullsSince(
    octokit,
    repo,
    baseRef
      ? { baseRef }
      : undefined,
  );
  return pulls.filter((pull) => pull.mergedAt.startsWith(today));
}
