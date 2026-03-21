import type { IStorage } from "./storage";
import type { SocialChangelogPRSummary } from "@shared/schema";
import type { CodingAgent } from "./agentRunner";
import { resolveAgent, runCommand } from "./agentRunner";

const DEFAULT_SOCIAL_CHANGELOG_TIMEOUT_MS = 120_000;
const SOCIAL_CHANGELOG_ERROR_SUMMARY_MAX_CHARS = 2_000;

/**
 * Generates a social media changelog from a list of merged PR summaries.
 *
 * Uses the Claude (or Codex) CLI with an AIDA-framework prompt to produce:
 *   - A Twitter/X thread (2-3 tweets, each ≤ 280 chars)
 *   - A LinkedIn / general long-form post
 *
 * The result is stored in the `social_changelogs` table and can be retrieved
 * via GET /api/changelogs.
 */
export async function generateSocialChangelog(params: {
  storage: IStorage;
  changelogId: string;
  prSummaries: SocialChangelogPRSummary[];
  date: string;
  preferredAgent: CodingAgent;
  timeoutMs?: number;
}): Promise<void> {
  const { storage, changelogId, prSummaries, date, preferredAgent, timeoutMs } = params;
  const commandTimeoutMs = resolveTimeoutMs(timeoutMs);

  try {
    const agent = await resolveAgent(preferredAgent);
    const prompt = buildPrompt(prSummaries, date);

    const result = await runCommand(
      agent,
      agent === "claude"
        ? ["-p", "--output-format", "text", prompt]
        : ["exec", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
      { timeoutMs: commandTimeoutMs },
    );

    if (result.code !== 0) {
      const errorMsg = result.stderr || result.stdout || `Agent exited with code ${result.code}`;
      console.error(`social-changelog: generation command failed for ${changelogId} (code=${result.code})`, {
        stdout: result.stdout,
        stderr: result.stderr,
      });
      await storage.updateSocialChangelog(changelogId, {
        status: "error",
        error: summarizeError(errorMsg),
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const content = result.stdout.trim() || "(Agent returned an empty response)";
    await storage.updateSocialChangelog(changelogId, {
      status: "done",
      content,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`social-changelog: generation failed for ${changelogId}: ${message}`, err);
    await storage.updateSocialChangelog(changelogId, {
      status: "error",
      error: summarizeError(message),
      completedAt: new Date().toISOString(),
    });
  }
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.floor(timeoutMs);
  }

  const envTimeout = Number(process.env.SOCIAL_CHANGELOG_AGENT_TIMEOUT_MS);
  if (Number.isFinite(envTimeout) && envTimeout > 0) {
    return Math.floor(envTimeout);
  }

  return DEFAULT_SOCIAL_CHANGELOG_TIMEOUT_MS;
}

function summarizeError(message: string): string {
  const trimmed = (message || "Unknown error").trim();
  if (trimmed.length <= SOCIAL_CHANGELOG_ERROR_SUMMARY_MAX_CHARS) {
    return trimmed;
  }

  const maxPrefix = SOCIAL_CHANGELOG_ERROR_SUMMARY_MAX_CHARS - "... (truncated)".length;
  return `${trimmed.slice(0, maxPrefix)}... (truncated)`;
}

function buildPrompt(prSummaries: SocialChangelogPRSummary[], date: string): string {
  const count = prSummaries.length;
  const prList = prSummaries
    .map((pr) => `  - PR #${pr.number} by @${pr.author} (${pr.repo}): "${pr.title}" — ${pr.url}`)
    .join("\n");

  return [
    "You are a developer advocate writing social media copy for Code Factory — an open-source,",
    "AI-powered GitHub PR manager. It watches repositories, triages review feedback, and",
    "automatically dispatches AI agents (Claude or Codex) to fix code. It runs entirely on the",
    "developer's own machine — no external hosting, no subscription required.",
    "",
    `Today (${date}), the following ${count} pull request${count === 1 ? " was" : "s were"} merged to main:`,
    "",
    prList,
    "",
    "──────────────────────────────────────────────────────────────────",
    "Using the AIDA copywriting framework, write social media posts that announce these updates",
    "in a way that attracts developers and prospects:",
    "",
    "  • Attention  — Open with a hook that makes developers stop scrolling. Lead with a bold",
    "                  benefit, a pain point every developer recognises, or a surprising capability.",
    "  • Interest   — Highlight 2-3 of the most compelling changes in plain, jargon-free language.",
    "  • Desire     — Paint the outcome: code review time cut, review cycles eliminated, bugs",
    "                  auto-fixed while the developer sleeps. Make the reader want that workflow.",
    "  • Action     — Close with a clear, low-friction CTA. Include the placeholder [REPO_URL].",
    "",
    "Write exactly TWO sections:",
    "",
    "## Twitter/X Thread",
    "2-3 connected tweets following the AIDA arc. Rules:",
    "  - Number them (1/3), (2/3), (3/3).",
    "  - Each tweet MUST be 280 characters or fewer — strictly enforced.",
    "  - Use emojis purposefully (not decoratively).",
    "  - End the last tweet with [REPO_URL] and hashtags: #AI #DevTools #GitHub #OpenSource",
    "",
    "## LinkedIn / General",
    "3-5 paragraphs with a narrative arc following AIDA. More detail than the tweets:",
    "  - Paragraph 1 (Attention): powerful opening line, then set the scene.",
    "  - Paragraphs 2-3 (Interest + Desire): walk through specific changes, connect each to a",
    "    developer pain point and its resolution.",
    "  - Final paragraph (Action): CTA, [REPO_URL], and a hashtag block.",
    "",
    "Tone: enthusiastic but grounded. Developer-first. No buzzword soup. Honest about what the",
    "tool does and doesn't do.",
  ].join("\n");
}
