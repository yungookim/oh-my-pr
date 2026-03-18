import type { IStorage } from "./storage";
import type { CodingAgent } from "./agentRunner";
import { resolveAgent, runCommand } from "./agentRunner";

/**
 * Answers a user question about a PR by gathering context (PR state, feedback,
 * recent activity logs) and sending it to the configured coding agent.
 */
export async function answerPRQuestion(params: {
  storage: IStorage;
  prId: string;
  questionId: string;
  question: string;
  preferredAgent: CodingAgent;
}): Promise<void> {
  const { storage, prId, questionId, question, preferredAgent } = params;

  await storage.updateQuestion(questionId, { status: "answering" });

  try {
    const agent = await resolveAgent(preferredAgent);
    const context = await buildPRContext(storage, prId);
    const prompt = buildPrompt(context, question);

    const result = await runCommand(
      agent,
      agent === "claude"
        ? ["-p", "--output-format", "text", prompt]
        : ["exec", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
      { timeoutMs: 180_000 },
    );

    if (result.code !== 0) {
      const errorMsg = result.stderr || result.stdout || `Agent exited with code ${result.code}`;
      await storage.updateQuestion(questionId, {
        status: "error",
        error: errorMsg.slice(0, 2000),
      });
      return;
    }

    const answer = result.stdout.trim() || "(Agent returned an empty response)";

    await storage.updateQuestion(questionId, {
      status: "answered",
      answer,
      answeredAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await storage.updateQuestion(questionId, {
      status: "error",
      error: message.slice(0, 2000),
    });
  }
}

type PRContext = {
  title: string;
  number: number;
  repo: string;
  branch: string;
  author: string;
  url: string;
  status: string;
  testsPassed: boolean | null;
  lintPassed: boolean | null;
  lastChecked: string | null;
  feedbackSummary: string;
  recentLogs: string;
};

async function buildPRContext(storage: IStorage, prId: string): Promise<PRContext> {
  const pr = await storage.getPR(prId);
  if (!pr) throw new Error("PR not found");

  const logs = await storage.getLogs(prId);
  const recentLogs = logs
    .slice(-50)
    .map((l) => `[${l.timestamp}] ${l.level.toUpperCase()} ${l.phase ? `[${l.phase}]` : ""} ${l.message}`)
    .join("\n");

  const feedbackLines = pr.feedbackItems.map((item) => {
    const parts = [
      `- [${item.status}]`,
      item.decision ? `decision=${item.decision}` : "",
      `by ${item.author}`,
      item.file ? `on ${item.file}${item.line ? `:${item.line}` : ""}` : "",
      `:: ${item.body.slice(0, 200)}`,
    ];
    return parts.filter(Boolean).join(" ");
  });

  return {
    title: pr.title,
    number: pr.number,
    repo: pr.repo,
    branch: pr.branch,
    author: pr.author,
    url: pr.url,
    status: pr.status,
    testsPassed: pr.testsPassed,
    lintPassed: pr.lintPassed,
    lastChecked: pr.lastChecked,
    feedbackSummary: feedbackLines.length > 0 ? feedbackLines.join("\n") : "(no feedback items)",
    recentLogs: recentLogs || "(no recent activity)",
  };
}

function buildPrompt(ctx: PRContext, question: string): string {
  return [
    "You are Code Factory, a PR review automation assistant. A user is asking a question about the following pull request.",
    "Answer concisely based on the context provided. If the information is not available in the context, say so.",
    "",
    "## Pull Request",
    `- Title: ${ctx.title}`,
    `- Number: #${ctx.number}`,
    `- Repository: ${ctx.repo}`,
    `- Branch: ${ctx.branch}`,
    `- Author: ${ctx.author}`,
    `- URL: ${ctx.url}`,
    `- Status: ${ctx.status}`,
    `- Tests: ${ctx.testsPassed === null ? "not checked" : ctx.testsPassed ? "passing" : "failing"}`,
    `- Lint: ${ctx.lintPassed === null ? "not checked" : ctx.lintPassed ? "passing" : "failing"}`,
    `- Last checked: ${ctx.lastChecked ?? "never"}`,
    "",
    "## Feedback Items",
    ctx.feedbackSummary,
    "",
    "## Recent Activity Logs (most recent 50 entries)",
    ctx.recentLogs,
    "",
    "## User Question",
    question,
  ].join("\n");
}
