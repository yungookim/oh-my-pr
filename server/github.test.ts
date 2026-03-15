import test from "node:test";
import assert from "node:assert/strict";
import type { Config, FeedbackItem } from "@shared/schema";
import {
  GitHubIntegrationError,
  fetchFeedbackItemsForPR,
  postFollowUpForFeedbackItem,
  postStatusReplyForFeedbackItem,
  resolveReviewThread,
  updateStatusReply,
} from "./github";

const config: Config = {
  githubToken: "",
  codingAgent: "codex",
  model: "sonnet",
  maxTurns: 15,
  batchWindowMs: 300000,
  pollIntervalMs: 120000,
  maxChangesPerRun: 20,
  watchedRepos: [],
  trustedReviewers: [],
  ignoredBots: ["dependabot[bot]", "codecov[bot]", "github-actions[bot]"],
};

function makeFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: "gh-review-comment-1",
    author: "reviewer",
    body: "Please fix this",
    bodyHtml: "<p>Please fix this</p>",
    replyKind: "review_thread",
    sourceId: "1",
    sourceNodeId: "PRRC_kwDO_comment",
    sourceUrl: "https://github.com/octo/example/pull/42#discussion_r1",
    threadId: "THREAD_node_123",
    threadResolved: false,
    auditToken: "codefactory-feedback:gh-review-comment-1",
    file: "src/example.ts",
    line: 12,
    type: "review_comment",
    createdAt: "2026-03-15T10:45:00Z",
    decision: null,
    decisionReason: null,
    action: null,
    ...overrides,
  };
}

test("fetchFeedbackItemsForPR keeps review bots that are not explicitly ignored", async () => {
  let callIndex = 0;

  const octokit = {
    paginate: async () => {
      callIndex += 1;

      if (callIndex === 1) {
        return [
          {
            id: 1,
            node_id: "PRRC_kwDO_comment",
            body: "Inline bot suggestion",
            path: "frontend/src/views/Inbox.vue",
            line: 42,
            created_at: "2026-03-15T10:45:00Z",
            html_url: "https://github.com/alex-morgan-o/lolodex/pull/106#discussion_r1",
            user: {
              login: "chatgpt-codex-connector",
              type: "Bot",
            },
          },
        ];
      }

      if (callIndex === 2) {
        return [
          {
            id: 2,
            node_id: "PRR_kwDO_review",
            body: "Top-level review body",
            submitted_at: "2026-03-15T10:44:33Z",
            html_url: "https://github.com/alex-morgan-o/lolodex/pull/106#pullrequestreview-2",
            user: {
              login: "gemini-code-assist",
              type: "Bot",
            },
          },
        ];
      }

      return [
        {
          id: 3,
          node_id: "IC_kwDO_comment",
          body: "Conversation summary comment",
          created_at: "2026-03-15T10:42:58Z",
          html_url: "https://github.com/alex-morgan-o/lolodex/pull/106#issuecomment-3",
          user: {
            login: "gemini-code-assist",
            type: "Bot",
          },
        },
        {
          id: 4,
          node_id: "IC_kwDO_ignored",
          body: "Ignore me",
          created_at: "2026-03-15T10:43:00Z",
          html_url: "https://github.com/alex-morgan-o/lolodex/pull/106#issuecomment-4",
          user: {
            login: "dependabot[bot]",
            type: "Bot",
          },
        },
      ];
    },
    request: async () => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "THREAD_node_123",
                  isResolved: false,
                  comments: {
                    nodes: [
                      { databaseId: 1 },
                    ],
                  },
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      },
    }),
    pulls: {
      listReviewComments: Symbol("listReviewComments"),
      listReviews: Symbol("listReviews"),
    },
    issues: {
      listComments: Symbol("listComments"),
    },
  };

  const items = await fetchFeedbackItemsForPR(
    octokit as never,
    { owner: "alex-morgan-o", repo: "lolodex", number: 106 },
    config,
  );

  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.author),
    ["gemini-code-assist", "gemini-code-assist", "chatgpt-codex-connector"],
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ["general_comment", "review", "review_comment"],
  );
  assert.deepEqual(
    items.map((item) => item.replyKind),
    ["general_comment", "review", "review_thread"],
  );
  assert.equal(items[0]?.sourceId, "3");
  assert.equal(items[1]?.sourceId, "2");
  assert.equal(items[2]?.sourceId, "1");
  assert.equal(items[2]?.threadId, "THREAD_node_123");
  assert.equal(items[2]?.threadResolved, false);
  assert.equal(items[2]?.auditToken, "codefactory-feedback:gh-review-comment-1");
  assert.match(items[0].bodyHtml, /<p>Conversation summary comment<\/p>/);
  assert.match(items[1].bodyHtml, /<p>Top-level review body<\/p>/);
  assert.match(items[2].bodyHtml, /<p>Inline bot suggestion<\/p>/);

  // Every normalized item must carry lifecycle defaults.
  for (const item of items) {
    assert.equal(item.status, "pending", `expected status=pending for item ${item.id}`);
    assert.equal(item.statusReason, null, `expected statusReason=null for item ${item.id}`);
  }

  // The review-comment item with review-thread metadata must still carry the defaults.
  const reviewCommentItem = items.find((item) => item.type === "review_comment");
  assert.ok(reviewCommentItem, "expected a review_comment item");
  assert.ok(reviewCommentItem.threadId, "expected threadId to be present");
  assert.equal(reviewCommentItem.status, "pending");
  assert.equal(reviewCommentItem.statusReason, null);
});

test("fetchFeedbackItemsForPR paginates review thread comments beyond the first page", async () => {
  const listReviewComments = Symbol("listReviewComments");
  const listReviews = Symbol("listReviews");
  const listIssueComments = Symbol("listIssueComments");
  const graphqlCalls: Array<{
    query: string;
    threadId?: string;
    cursor?: string | null;
  }> = [];

  const octokit = {
    paginate: async (method: symbol) => {
      if (method === listReviewComments) {
        return [
          {
            id: 101,
            node_id: "PRRC_kwDO_comment_101",
            body: "Inline comment on a long thread",
            path: "server/github.ts",
            line: 331,
            created_at: "2026-03-15T11:00:00Z",
            html_url: "https://github.com/yungookim/codefactory/pull/1#discussion_r101",
            user: {
              login: "gemini-code-assist[bot]",
              type: "Bot",
            },
          },
        ];
      }

      if (method === listReviews) {
        return [];
      }

      if (method === listIssueComments) {
        return [];
      }

      throw new Error("Unexpected paginate call");
    },
    request: async (_route: string, params: { query: string; threadId?: string; cursor?: string | null }) => {
      graphqlCalls.push({
        query: params.query,
        threadId: params.threadId,
        cursor: params.cursor ?? null,
      });

      if (params.query.includes("CodeFactoryReviewThreads")) {
        return {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "THREAD_node_999",
                      isResolved: true,
                      comments: {
                        nodes: Array.from({ length: 100 }, (_unused, index) => ({
                          databaseId: index + 1,
                        })),
                        pageInfo: {
                          hasNextPage: true,
                          endCursor: "cursor-100",
                        },
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          },
        };
      }

      assert.equal(params.threadId, "THREAD_node_999");
      assert.equal(params.cursor, "cursor-100");

      return {
        data: {
          node: {
            id: "THREAD_node_999",
            isResolved: true,
            comments: {
              nodes: [
                { databaseId: 101 },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      };
    },
    pulls: {
      listReviewComments,
      listReviews,
    },
    issues: {
      listComments: listIssueComments,
    },
  };

  const items = await fetchFeedbackItemsForPR(
    octokit as never,
    { owner: "yungookim", repo: "codefactory", number: 1 },
    config,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.sourceId, "101");
  assert.equal(items[0]?.threadId, "THREAD_node_999");
  assert.equal(items[0]?.threadResolved, true);
  assert.deepEqual(graphqlCalls.map(({ threadId, cursor }) => ({
    threadId,
    cursor,
  })), [
    {
      threadId: undefined,
      cursor: null,
    },
    {
      threadId: "THREAD_node_999",
      cursor: "cursor-100",
    },
  ]);
  assert.match(graphqlCalls[0]?.query || "", /CodeFactoryReviewThreads/);
  assert.match(graphqlCalls[1]?.query || "", /CodeFactoryReviewThreadComments/);
});

test("postFollowUpForFeedbackItem replies to review threads and resolveReviewThread resolves them", async () => {
  const requests: Array<{ route: string; params: Record<string, unknown> }> = [];

  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      requests.push({ route, params });
      return {
        data: {
          ok: true,
        },
      };
    },
    issues: {
      createComment: async () => {
        throw new Error("unexpected issue comment");
      },
    },
  };

  await postFollowUpForFeedbackItem(
    octokit as never,
    { owner: "octo", repo: "example", number: 42 },
    makeFeedbackItem(),
    "Addressed in the latest babysitter update.\n\ncodefactory-feedback:gh-review-comment-1",
  );
  await resolveReviewThread(
    octokit as never,
    { owner: "octo", repo: "example", number: 42 },
    "THREAD_node_123",
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.route, "POST /graphql");
  assert.match(String(requests[0]?.params.query || ""), /addPullRequestReviewThreadReply/);
  assert.equal(requests[0]?.params.threadId, "THREAD_node_123");
  assert.equal(
    requests[0]?.params.body,
    "Addressed in the latest babysitter update.\n\ncodefactory-feedback:gh-review-comment-1",
  );
  assert.equal(requests[1]?.route, "POST /graphql");
  assert.match(String(requests[1]?.params.query || ""), /resolveReviewThread/);
  assert.equal(requests[1]?.params.threadId, "THREAD_node_123");
});

test("postFollowUpForFeedbackItem routes review and general comments to PR comments", async () => {
  const comments: Array<Record<string, unknown>> = [];

  const octokit = {
    request: async () => {
      throw new Error("unexpected graphql request");
    },
    issues: {
      createComment: async (params: Record<string, unknown>) => {
        comments.push(params);
        return {
          data: {
            id: 123,
          },
        };
      },
    },
  };

  await postFollowUpForFeedbackItem(
    octokit as never,
    { owner: "octo", repo: "example", number: 42 },
    makeFeedbackItem({
      id: "gh-review-2",
      replyKind: "review",
      type: "review",
      threadId: null,
      threadResolved: null,
    }),
    "Review follow-up",
  );
  await postFollowUpForFeedbackItem(
    octokit as never,
    { owner: "octo", repo: "example", number: 42 },
    makeFeedbackItem({
      id: "gh-issue-comment-3",
      replyKind: "general_comment",
      type: "general_comment",
      threadId: null,
      threadResolved: null,
    }),
    "General follow-up",
  );

  assert.deepEqual(comments, [
    {
      owner: "octo",
      repo: "example",
      issue_number: 42,
      body: "Review follow-up",
    },
    {
      owner: "octo",
      repo: "example",
      issue_number: 42,
      body: "General follow-up",
    },
  ]);
});

test("postStatusReplyForFeedbackItem validates review-thread replies and updateStatusReply mutates the local ref", async () => {
  const requests: Array<{ route: string; params: Record<string, unknown> }> = [];
  const updatedReviewComments: Array<Record<string, unknown>> = [];

  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      requests.push({ route, params });
      return {
        data: {
          addPullRequestReviewThreadReply: {
            comment: {
              databaseId: 456,
            },
          },
        },
      };
    },
    pulls: {
      updateReviewComment: async (params: Record<string, unknown>) => {
        updatedReviewComments.push(params);
        return {
          data: {
            ok: true,
          },
        };
      },
    },
    issues: {
      createComment: async () => {
        throw new Error("unexpected issue comment");
      },
      updateComment: async () => {
        throw new Error("unexpected issue comment update");
      },
    },
  };

  const ref = await postStatusReplyForFeedbackItem(
    octokit as never,
    { owner: "octo", repo: "example", number: 42 },
    makeFeedbackItem(),
    "Queued for processing",
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.route, "POST /graphql");
  assert.match(String(requests[0]?.params.query || ""), /addPullRequestReviewThreadReply/);
  assert.equal(requests[0]?.params.threadId, "THREAD_node_123");
  assert.equal(requests[0]?.params.body, "Queued for processing");
  assert.deepEqual(ref, {
    commentDatabaseId: 456,
    replyKind: "review_thread",
    body: "Queued for processing",
  });

  if (!ref) {
    throw new Error("expected a status reply reference");
  }

  await updateStatusReply(
    octokit as never,
    { owner: "octo", repo: "example", number: 42 },
    ref,
    "Queued for processing\nVerifying changes",
  );

  assert.deepEqual(updatedReviewComments, [
    {
      owner: "octo",
      repo: "example",
      comment_id: 456,
      body: "Queued for processing\nVerifying changes",
    },
  ]);
  assert.equal(ref.body, "Queued for processing\nVerifying changes");
});

test("postStatusReplyForFeedbackItem rejects malformed review-thread reply payloads", async () => {
  const octokit = {
    request: async () => ({
      data: {
        addPullRequestReviewThreadReply: {
          comment: {
            databaseId: "not-a-number",
          },
        },
      },
    }),
  };

  await assert.rejects(
    () => postStatusReplyForFeedbackItem(
      octokit as never,
      { owner: "octo", repo: "example", number: 42 },
      makeFeedbackItem(),
      "Queued for processing",
    ),
    (error: unknown) => {
      assert.ok(error instanceof GitHubIntegrationError);
      assert.match(
        error.message,
        /GitHub returned an unexpected payload while creating a status reply for feedback item gh-review-comment-1 on octo\/example#42/,
      );
      return true;
    },
  );
});
