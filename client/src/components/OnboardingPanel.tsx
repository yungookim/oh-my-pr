import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Config } from "@shared/schema";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";

const ONBOARDING_DISMISS_KEY = "onboarding-panel-dismissed-v2";
const REVIEW_TOOL_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
} as const;
const REVIEW_PROVIDER_GUIDES = [
  {
    label: "Gemini Code Assist",
    href: "https://github.com/apps/gemini-code-assist",
  },
  {
    label: "OpenAI Codex",
    href: "https://developers.openai.com/codex/integrations/github",
  },
  {
    label: "Claude Code",
    href: "https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code",
  },
  {
    label: "Cursor",
    href: "https://cursor.com/docs/integrations/github",
  },
] as const;

type OnboardingStatus = {
  githubConnected: boolean;
  githubError?: string;
  githubUser?: string;
  repos: RepoOnboardingStatus[];
};

type CodeReviewPresence = {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
};

type RepoOnboardingStatus = {
  repo: string;
  accessible: boolean;
  error?: string;
  codeReviews: CodeReviewPresence;
};

type InstallReviewTool = "claude" | "codex";
type ReviewTool = keyof CodeReviewPresence;
type OnboardingStepId = "github" | "repo" | "workflow";

type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  description: string;
  complete: boolean;
};

function hasDetectedCodeReviewWorkflow(codeReviews: CodeReviewPresence) {
  return codeReviews.claude || codeReviews.codex || codeReviews.gemini;
}

function getDetectedReviewTools(codeReviews: CodeReviewPresence): ReviewTool[] {
  return (Object.entries(codeReviews) as Array<[ReviewTool, boolean]>)
    .filter(([, present]) => present)
    .map(([tool]) => tool);
}

export function getOnboardingPanelState(status: OnboardingStatus) {
  const accessibleRepos = status.repos.filter((repo) => repo.accessible);
  const inaccessibleRepos = status.repos.filter((repo) => !repo.accessible);
  const reposWithReview = accessibleRepos.filter((repo) => hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const reposMissingReview = accessibleRepos.filter((repo) => !hasDetectedCodeReviewWorkflow(repo.codeReviews));

  const steps: OnboardingStep[] = [
    {
      id: "github",
      title: "Connect GitHub",
      description: status.githubConnected
        ? `Connected${status.githubUser ? ` as @${status.githubUser}` : ""}.`
        : "Connect GitHub so the app can read repositories, sync feedback, and install review workflows.",
      complete: status.githubConnected,
    },
    {
      id: "repo",
      title: "Track your first repository or PR",
      description: accessibleRepos.length > 0
        ? `Watching ${accessibleRepos.length} accessible repo${accessibleRepos.length === 1 ? "" : "s"}. Choose per repo whether to track only your PRs or your whole team.`
        : "Use the Add PR or Watch form below. Adding a PR also adds its repository to the watch list, and watched repos let you choose whether to track only your PRs or the whole team.",
      complete: accessibleRepos.length > 0,
    },
    {
      id: "workflow",
      title: "Enable first-pass AI review",
      description: reposWithReview.length > 0
        ? `Detected an AI review workflow in ${reposWithReview.length} repo${reposWithReview.length === 1 ? "" : "s"}.`
        : accessibleRepos.length > 0
          ? "Install a Claude or Codex review workflow on any tracked repository to seed actionable review comments automatically."
          : "Track an accessible repository first, then install a review workflow.",
      complete: reposWithReview.length > 0,
    },
  ];

  const completedCount = steps.filter((step) => step.complete).length;
  const pendingSteps = steps.filter((step) => !step.complete);
  const dismissalKey = [
    ...pendingSteps.map((step) => step.id.toLowerCase()),
    ...inaccessibleRepos.map((repo) => "access:" + repo.repo.toLowerCase() + ":" + (repo.error?.slice(0, 100) ?? "").toLowerCase()),
  ].sort().join("|") || "complete";
  const hasIssues = pendingSteps.length > 0 || inaccessibleRepos.length > 0;
  const summary = pendingSteps.length > 0
    ? `${completedCount} of ${steps.length} complete`
    : `${inaccessibleRepos.length} access issue${inaccessibleRepos.length === 1 ? "" : "s"}`;

  return {
    accessibleRepos,
    hasIssues,
    inaccessibleRepos,
    reposMissingReview,
    reposWithReview,
    steps,
    pendingSteps,
    completedCount,
    dismissalKey,
    summary,
  };
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded border border-border bg-muted/30 px-1 py-0.5 text-[11px] font-mono">
      {children}
    </code>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border border-border text-[10px] text-muted-foreground">
        {number}
      </span>
      <div className="flex-1 text-[12px] leading-relaxed">{children}</div>
    </div>
  );
}

function StepCard({
  step,
  index,
  children,
}: {
  step: OnboardingStep;
  index: number;
  children?: ReactNode;
}) {
  return (
    <div className={`border px-3 py-3 ${step.complete ? "border-border bg-background/60" : "border-amber-500/30 bg-amber-500/5"}`}>
      <div className="flex gap-3">
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-[10px] ${step.complete ? "border-border text-foreground" : "border-amber-500/40 text-amber-500"}`}>
          {step.complete ? "✓" : index}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider">{step.title}</span>
            <span className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${step.complete ? "border-border text-muted-foreground" : "border-amber-500/40 text-amber-500"}`}>
              {step.complete ? "done" : "next"}
            </span>
          </div>
          <p className="text-[12px] text-muted-foreground">{step.description}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function OnboardingPanel() {
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage.getItem(ONBOARDING_DISMISS_KEY);
  });
  const [expanded, setExpanded] = useState(true);

  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["/api/onboarding/status"],
    refetchInterval: 30000,
  });
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const installWorkflowMutation = useMutation({
    mutationFn: async ({ repo, tool }: { repo: string; tool: InstallReviewTool }) => {
      const res = await apiRequest("POST", "/api/onboarding/install-review", { repo, tool });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({
        description: `${REVIEW_TOOL_LABELS[variables.tool]} review workflow installed for ${variables.repo}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        description: `Could not install review workflow: ${error.message}`,
      });
    },
  });

  if (isLoading || !status) return null;

  const {
    accessibleRepos,
    completedCount,
    dismissalKey,
    hasIssues,
    inaccessibleRepos,
    reposMissingReview,
    reposWithReview,
    steps,
    summary,
  } = getOnboardingPanelState(status);
  const preferredTool = config?.codingAgent ?? "claude";
  const installOrder: InstallReviewTool[] = preferredTool === "codex"
    ? ["codex", "claude"]
    : ["claude", "codex"];

  if (!hasIssues || dismissedKey === dismissalKey) return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/35">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
          <span className="text-[11px] font-medium uppercase tracking-wider">
            Getting started
          </span>
          <span className="text-[11px] text-muted-foreground">{summary}</span>
          <span className="text-[10px] text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        </button>
        <button
          onClick={() => {
            if (typeof window !== "undefined") {
              window.localStorage.setItem(ONBOARDING_DISMISS_KEY, dismissalKey);
            }
            setDismissedKey(dismissalKey);
          }}
          className="text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          dismiss
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Setup checklist
            </div>
            <div className="text-[11px] text-muted-foreground">
              {completedCount} of {steps.length} complete
            </div>
          </div>

          <div className="space-y-3">
            {steps.map((step, index) => (
              <StepCard key={step.id} step={step} index={index + 1}>
                {step.id === "github" && !step.complete && (
                  <div className="space-y-2 pt-1">
                    {status.githubError && (
                      <p className="text-[12px] text-destructive">{status.githubError}</p>
                    )}
                    <div className="space-y-1.5 text-[12px] text-muted-foreground">
                      <Step number={1}>
                        Run <InlineCode>gh auth login</InlineCode> on this machine, or set <InlineCode>GITHUB_TOKEN</InlineCode> before starting the app.
                      </Step>
                      <Step number={2}>
                        Prefer the built-in token field if you want the app to remember it. Open <Link href="/settings" className="underline underline-offset-2">settings</Link> to paste a Personal Access Token.
                      </Step>
                    </div>
                  </div>
                )}

                {step.id === "repo" && !step.complete && (
                  <div className="pt-1 text-[12px] text-muted-foreground">
                    The left sidebar is the real entry point. Use <span className="text-foreground">Add</span> for a PR URL or <span className="text-foreground">Watch</span> for an <InlineCode>owner/repo</InlineCode> slug, then choose whether that watched repo should track only your PRs or your whole team.
                  </div>
                )}

                {step.id === "workflow" && !step.complete && accessibleRepos.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-2 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-[12px] text-muted-foreground">
                        Oh-my-PR is best used along with a chain of AI code review tools. Different models have different strengths and weaknesses. Below are instructions on how to install code reviews with different providers.
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        {REVIEW_PROVIDER_GUIDES.map((provider) => (
                          <a
                            key={provider.href}
                            href={provider.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
                          >
                            {provider.label}
                          </a>
                        ))}
                      </div>
                    </div>
                    {reposMissingReview.map((repoStatus) => (
                      <div key={repoStatus.repo} className="flex flex-col gap-2 border border-border bg-background/50 px-3 py-2 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <a
                            href={`https://github.com/${repoStatus.repo}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[11px] font-medium underline underline-offset-2"
                          >
                            {repoStatus.repo}
                          </a>
                          <p className="text-[11px] text-muted-foreground">
                            No AI review workflow detected yet.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {installOrder.map((tool) => {
                            const isPending = installWorkflowMutation.isPending
                              && installWorkflowMutation.variables?.repo === repoStatus.repo
                              && installWorkflowMutation.variables?.tool === tool;
                            return (
                              <button
                                key={`${repoStatus.repo}-${tool}`}
                                type="button"
                                onClick={() => installWorkflowMutation.mutate({ repo: repoStatus.repo, tool })}
                                disabled={installWorkflowMutation.isPending}
                                className="border border-border px-2 py-1 text-[10px] uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-40"
                              >
                                {isPending ? "Installing…" : `Install ${REVIEW_TOOL_LABELS[tool]}`}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {step.id === "workflow" && step.complete && reposWithReview.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-2 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-[12px] text-muted-foreground">
                        Oh-my-PR is best used along with a chain of AI code review tools. Different models have different strengths and weaknesses. Below are instructions on how to install code reviews with different providers.
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        {REVIEW_PROVIDER_GUIDES.map((provider) => (
                          <a
                            key={provider.href}
                            href={provider.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
                          >
                            {provider.label}
                          </a>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {reposWithReview.map((repoStatus) => {
                        const detectedTools = getDetectedReviewTools(repoStatus.codeReviews)
                          .map((tool) => REVIEW_TOOL_LABELS[tool])
                          .join(" + ");
                        return (
                          <span
                            key={repoStatus.repo}
                            className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                          >
                            {repoStatus.repo} · {detectedTools}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </StepCard>
            ))}
          </div>

          {inaccessibleRepos.length > 0 && (
            <div className="space-y-3 border border-destructive/30 bg-destructive/5 px-3 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-destructive">
                Repository access issues
              </div>
              <div className="space-y-2">
                {inaccessibleRepos.map((repoStatus) => (
                  <div key={repoStatus.repo} className="space-y-1">
                    <div className="text-[11px] font-medium">
                      <a
                        href={`https://github.com/${repoStatus.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {repoStatus.repo}
                      </a>
                    </div>
                    <p className="text-[12px] text-destructive">
                      Cannot access this repository: {repoStatus.error ?? "unknown error"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
