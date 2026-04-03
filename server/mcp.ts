#!/usr/bin/env node
/**
 * mcp.ts — Code Factory MCP Server
 *
 * Exposes every Code Factory capability as an MCP (Model Context Protocol)
 * tool so that any MCP-compatible agent (Claude Desktop, OpenClaw, etc.) can
 * drive Code Factory without needing to speak raw HTTP.
 *
 * Transport: stdio  (the agent host spawns this process)
 * Security:  All HTTP calls go to 127.0.0.1 only — never the network.
 *
 * Quick start
 * -----------
 *   npx tsx server/mcp.ts
 *   # or after build:
 *   node dist/mcp.cjs
 *
 * Claude Desktop / OpenClaw mcpServers config example
 * ----------------------------------------------------
 *   {
 *     "mcpServers": {
 *       "codefactory": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/codefactory/server/mcp.ts"],
 *         "env": { "CODEFACTORY_PORT": "5001" }
 *       }
 *     }
 *   }
 *
 * See LOCAL_API.md for full documentation.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ────────────────────────────────────────────────────────────────────

const CF_BASE_URL = `http://127.0.0.1:${process.env.CODEFACTORY_PORT ?? "5001"}`;

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function cfFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${CF_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? (data as { error: string }).error
        : text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  return data;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // ── Repositories ──────────────────────────────────────────────────────────
  {
    name: "list_repos",
    description:
      "List all repositories currently being watched by Code Factory. " +
      "Returns an array of 'owner/repo' strings.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_repo",
    description:
      "Add a GitHub repository to the Code Factory watch list. " +
      "Accepts 'owner/repo' slugs or full GitHub URLs.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description:
            "Repository identifier, e.g. 'owner/repo' or 'https://github.com/owner/repo'.",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "sync_repos",
    description:
      "Force an immediate sync cycle across all watched repositories. " +
      "Fetches the latest PR feedback from GitHub and runs the babysitter logic.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── Pull Requests ──────────────────────────────────────────────────────────
  {
    name: "list_prs",
    description:
      "List all actively tracked pull requests with their current status and feedback summaries.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_archived_prs",
    description: "List pull requests that have been archived (closed / merged).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pr",
    description:
      "Get full details for a single PR, including all feedback items, triage decisions, and run history.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "add_pr",
    description:
      "Register a GitHub pull request with Code Factory by URL. " +
      "Code Factory will start watching the PR and run the babysitter.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full GitHub PR URL, e.g. 'https://github.com/owner/repo/pull/42'.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "remove_pr",
    description: "Remove a PR from Code Factory's tracking list.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "fetch_pr_feedback",
    description:
      "Force a fresh fetch of comments and reviews from GitHub for a specific PR.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "triage_pr",
    description:
      "Run automatic triage on all un-triaged feedback items for a PR. " +
      "Items are classified as accept, reject, or flag.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "apply_pr_fixes",
    description:
      "Dispatch the configured AI agent to apply all accepted feedback for a PR. " +
      "Runs in an isolated git worktree and pushes the result.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "babysit_pr",
    description:
      "Run a full babysit cycle on a PR: sync feedback → triage → apply fixes → report. " +
      "This is the highest-level operation for a single PR.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["id"],
    },
  },

  // ── Feedback items ─────────────────────────────────────────────────────────
  {
    name: "set_feedback_decision",
    description:
      "Manually override the triage decision for a single feedback item on a PR. " +
      "Valid decisions: 'accept' | 'reject' | 'flag'.",
    inputSchema: {
      type: "object",
      properties: {
        pr_id: { type: "string", description: "Internal Code Factory PR ID." },
        feedback_id: { type: "string", description: "Feedback item ID." },
        decision: {
          type: "string",
          enum: ["accept", "reject", "flag"],
          description: "New triage decision.",
        },
      },
      required: ["pr_id", "feedback_id", "decision"],
    },
  },
  {
    name: "retry_feedback_item",
    description:
      "Retry a previously failed or warned feedback item for a PR.",
    inputSchema: {
      type: "object",
      properties: {
        pr_id: { type: "string", description: "Internal Code Factory PR ID." },
        feedback_id: { type: "string", description: "Feedback item ID." },
      },
      required: ["pr_id", "feedback_id"],
    },
  },

  // ── PR Q&A ─────────────────────────────────────────────────────────────────
  {
    name: "list_pr_questions",
    description: "List all questions and answers previously asked about a PR.",
    inputSchema: {
      type: "object",
      properties: {
        pr_id: { type: "string", description: "Internal Code Factory PR ID." },
      },
      required: ["pr_id"],
    },
  },
  {
    name: "ask_pr_question",
    description:
      "Ask the configured AI agent a natural-language question about a PR's state, " +
      "feedback, or code. Returns the question entry; the answer is filled in asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        pr_id: { type: "string", description: "Internal Code Factory PR ID." },
        question: {
          type: "string",
          description: "Natural-language question (max 2000 chars).",
          maxLength: 2000,
        },
      },
      required: ["pr_id", "question"],
    },
  },

  // ── Logs ───────────────────────────────────────────────────────────────────
  {
    name: "get_logs",
    description:
      "Retrieve activity logs. Optionally filter by PR ID to see only that PR's history.",
    inputSchema: {
      type: "object",
      properties: {
        pr_id: {
          type: "string",
          description: "Optional PR ID to filter logs.",
        },
      },
      required: [],
    },
  },

  // ── Config ─────────────────────────────────────────────────────────────────
  {
    name: "get_config",
    description:
      "Read the current Code Factory configuration. GitHub token is redacted.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_config",
    description:
      "Partially update Code Factory configuration. All fields are optional; only provided " +
      "fields are changed. Available fields: githubToken, codingAgent, maxTurns, " +
      "batchWindowMs, pollIntervalMs, maxChangesPerRun, autoResolveMergeConflicts, autoUpdateDocs, " +
      "watchedRepos, trustedReviewers, ignoredBots.",
    inputSchema: {
      type: "object",
      properties: {
        githubToken: { type: "string" },
        codingAgent: { type: "string", enum: ["claude", "codex"] },
        maxTurns: { type: "number" },
        batchWindowMs: { type: "number" },
        pollIntervalMs: { type: "number" },
        maxChangesPerRun: { type: "number" },
        autoResolveMergeConflicts: { type: "boolean" },
        autoUpdateDocs: { type: "boolean" },
        watchedRepos: { type: "array", items: { type: "string" } },
        trustedReviewers: { type: "array", items: { type: "string" } },
        ignoredBots: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },

  // ── Runtime ────────────────────────────────────────────────────────────────
  {
    name: "get_runtime",
    description:
      "Get Code Factory runtime state: drain mode status, active run count, and timestamps.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_drain_mode",
    description:
      "Enable or disable drain mode. When drain mode is on, no new agent runs are started. " +
      "Use this for graceful shutdown or maintenance.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "True to enable, false to disable." },
        reason: { type: "string", description: "Optional human-readable reason." },
        wait_for_idle: {
          type: "boolean",
          description: "If true, block until all active runs finish (or timeout).",
        },
        timeout_ms: {
          type: "number",
          description: "Max milliseconds to wait when wait_for_idle is true (default 120000).",
        },
      },
      required: ["enabled"],
    },
  },

  // ── Social changelogs ──────────────────────────────────────────────────────
  {
    name: "list_changelogs",
    description: "List all generated social-media changelogs.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_changelog",
    description: "Get the full content of a single social-media changelog.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Changelog ID." },
      },
      required: ["id"],
    },
  },

  // ── Onboarding ─────────────────────────────────────────────────────────────
  {
    name: "get_onboarding_status",
    description:
      "Check onboarding status for all watched repositories (GitHub workflow installation, etc.).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "install_review_workflow",
    description:
      "Install the Code Factory code-review GitHub Actions workflow on a repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository slug 'owner/repo'.",
        },
        tool: {
          type: "string",
          enum: ["claude", "codex"],
          description: "Agent tool to use for reviews.",
        },
      },
      required: ["repo", "tool"],
    },
  },

  // ── Deployment healing ────────────────────────────────────────────────────
  {
    name: "list_deployment_healing_sessions",
    description: "List deployment healing sessions, optionally filtered by repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Optional repository slug 'owner/repo' to filter by." },
      },
      required: [],
    },
  },
  {
    name: "get_deployment_healing_session",
    description: "Get details of a single deployment healing session by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Deployment healing session ID." },
      },
      required: ["id"],
    },
  },
];

// ── Tool dispatch ─────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

async function callTool(name: string, args: ToolArgs): Promise<unknown> {
  switch (name) {
    // Repos
    case "list_repos":
      return cfFetch("GET", "/api/repos");
    case "add_repo":
      return cfFetch("POST", "/api/repos", { repo: args.repo });
    case "sync_repos":
      return cfFetch("POST", "/api/repos/sync");

    // PRs
    case "list_prs":
      return cfFetch("GET", "/api/prs");
    case "list_archived_prs":
      return cfFetch("GET", "/api/prs/archived");
    case "get_pr":
      return cfFetch("GET", `/api/prs/${args.id}`);
    case "add_pr":
      return cfFetch("POST", "/api/prs", { url: args.url });
    case "remove_pr":
      return cfFetch("DELETE", `/api/prs/${args.id}`);
    case "fetch_pr_feedback":
      return cfFetch("POST", `/api/prs/${args.id}/fetch`);
    case "triage_pr":
      return cfFetch("POST", `/api/prs/${args.id}/triage`);
    case "apply_pr_fixes":
      return cfFetch("POST", `/api/prs/${args.id}/apply`);
    case "babysit_pr":
      return cfFetch("POST", `/api/prs/${args.id}/babysit`);

    // Feedback
    case "set_feedback_decision":
      return cfFetch("PATCH", `/api/prs/${args.pr_id}/feedback/${args.feedback_id}`, {
        decision: args.decision,
      });
    case "retry_feedback_item":
      return cfFetch("POST", `/api/prs/${args.pr_id}/feedback/${args.feedback_id}/retry`);

    // Q&A
    case "list_pr_questions":
      return cfFetch("GET", `/api/prs/${args.pr_id}/questions`);
    case "ask_pr_question":
      return cfFetch("POST", `/api/prs/${args.pr_id}/questions`, {
        question: args.question,
      });

    // Logs
    case "get_logs": {
      const qs = args.pr_id ? `?prId=${encodeURIComponent(String(args.pr_id))}` : "";
      return cfFetch("GET", `/api/logs${qs}`);
    }

    // Config
    case "get_config":
      return cfFetch("GET", "/api/config");
    case "update_config":
      return cfFetch("PATCH", "/api/config", args);

    // Runtime
    case "get_runtime":
      return cfFetch("GET", "/api/runtime");
    case "set_drain_mode":
      return cfFetch("POST", "/api/runtime/drain", {
        enabled: args.enabled,
        reason: args.reason,
        waitForIdle: args.wait_for_idle,
        timeoutMs: args.timeout_ms,
      });

    // Changelogs
    case "list_changelogs":
      return cfFetch("GET", "/api/changelogs");
    case "get_changelog":
      return cfFetch("GET", `/api/changelogs/${args.id}`);

    // Onboarding
    case "get_onboarding_status":
      return cfFetch("GET", "/api/onboarding/status");
    case "install_review_workflow":
      return cfFetch("POST", "/api/onboarding/install-review", {
        repo: args.repo,
        tool: args.tool,
      });

    // Deployment healing
    case "list_deployment_healing_sessions": {
      const query = args.repo ? `?repo=${encodeURIComponent(String(args.repo))}` : "";
      return cfFetch("GET", `/api/deployment-healing-sessions${query}`);
    }
    case "get_deployment_healing_session":
      return cfFetch("GET", `/api/deployment-healing-sessions/${args.id}`);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: "codefactory", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    const result = await callTool(name, args as ToolArgs);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // All communication is over stdio; stderr is safe for diagnostics.
  process.stderr.write(
    `[codefactory-mcp] MCP server started — targeting ${CF_BASE_URL}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[codefactory-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
