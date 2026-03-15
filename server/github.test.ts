import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "@shared/schema";
import { fetchFeedbackItemsForPR } from "./github";

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
});

test("fetchFeedbackItemsForPR paginates review thread comments beyond the first page", async () => {
  const listReviewComments = Symbol("listReviewComments");
  const listReviews = Symbol("listReviews");
  const listIssueComments = Symbol("listIssueComments");
  const graphqlCalls: Array<{
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
    request: async (_route: string, params: {
      query: string;
      threadId?: string;
      cursor?: string | null;
    }) => {
      graphqlCalls.push({
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

      if (params.query.includes("CodeFactoryReviewThreadComments")) {
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
      }

      throw new Error("Unexpected GraphQL query");
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
  assert.deepEqual(graphqlCalls, [
    {
      threadId: undefined,
      cursor: null,
    },
    {
      threadId: "THREAD_node_999",
      cursor: "cursor-100",
    },
  ]);
});
