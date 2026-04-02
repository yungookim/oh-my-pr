import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

type OnboardingStatus = {
  githubConnected: boolean;
  githubError?: string;
  repos: RepoOnboardingStatus[];
};

type RepoOnboardingStatus = {
  repo: string;
  accessible: boolean;
  error?: string;
};

export function getOnboardingPanelState(status: OnboardingStatus) {
  const inaccessibleRepos = status.githubConnected
    ? status.repos.filter((repo) => !repo.accessible)
    : [];
  const hasIssues = !status.githubConnected || inaccessibleRepos.length > 0;
  const summary = !status.githubConnected
    ? "GitHub not connected"
    : `${inaccessibleRepos.length} inaccessible repo${inaccessibleRepos.length === 1 ? "" : "s"}`;

  return {
    hasIssues,
    inaccessibleRepos,
    summary,
  };
};

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded border border-border bg-muted/30 px-1 py-0.5 text-[11px] font-mono">
      {children}
    </code>
  );
}

function Step({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border border-border text-[10px] text-muted-foreground">
        {number}
      </span>
      <div className="flex-1 text-[12px] leading-relaxed">{children}</div>
    </div>
  );
}

function GitHubSetupSection() {
  const [showPAT, setShowPAT] = useState(false);

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted-foreground">
        Code Factory needs a GitHub token to read repositories and sync PR feedback. Choose one of these options:
      </p>

      <div className="space-y-2">
        <div className="border border-border p-3 space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wider">Option A — GitHub CLI (recommended)</div>
          <Step number={1}>
            Install the GitHub CLI from{" "}
            <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              cli.github.com
            </a>
          </Step>
          <Step number={2}>
            Run <InlineCode>gh auth login</InlineCode> and follow the prompts to authenticate.
          </Step>
          <Step number={3}>
            Restart Code Factory — it will automatically detect your token via <InlineCode>gh auth token</InlineCode>.
          </Step>
        </div>

        <div className="border border-border p-3 space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wider">Option B — Environment variable</div>
          <Step number={1}>
            Create a Personal Access Token at{" "}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              github.com/settings/tokens
            </a>
            {" "}with <InlineCode>repo</InlineCode> and <InlineCode>read:user</InlineCode> scopes.
          </Step>
          <Step number={2}>
            Set it before starting the app: <InlineCode>export GITHUB_TOKEN=ghp_your_token</InlineCode>
          </Step>
        </div>

        <div className="border border-border p-3 space-y-2">
          <button
            onClick={() => setShowPAT(!showPAT)}
            className="flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-wider"
          >
            <span>Option C — Enter token in settings</span>
            <span className="text-muted-foreground">{showPAT ? "▲" : "▼"}</span>
          </button>
          {showPAT && (
            <div className="space-y-2 pt-1">
              <Step number={1}>
                Create a{" "}
                <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  Personal Access Token
                </a>
                {" "}with <InlineCode>repo</InlineCode> and <InlineCode>read:user</InlineCode> scopes.
              </Step>
              <Step number={2}>
                Paste it via the API: <InlineCode>{`curl -X PATCH http://localhost:5001/api/config -H 'Content-Type: application/json' -d '{"githubToken":"ghp_your_token"}'`}</InlineCode>
              </Step>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OnboardingPanel() {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["/api/onboarding/status"],
    refetchInterval: 30000,
  });

  if (isLoading || !status) return null;

  const { hasIssues, inaccessibleRepos, summary } = getOnboardingPanelState(status);

  if (!hasIssues || dismissed) return null;

  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-amber-400">
            Setup needed
          </span>
          <span className="text-[11px] text-muted-foreground">{summary}</span>
          <span className="text-[10px] text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          dismiss
        </button>
      </div>

      {expanded && (
        <div className="border-t border-amber-500/20 px-4 py-4 space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-destructive">
                GitHub not connected
              </span>
              {status.githubError && (
                <span className="text-[11px] text-muted-foreground">— {status.githubError}</span>
              )}
            </div>
            <GitHubSetupSection />
          </div>

          {status.githubConnected && inaccessibleRepos.length > 0 && (
            <div className="space-y-4">
              <div className="text-[11px] font-medium uppercase tracking-wider">
                Repository access issues
              </div>
              <div className="space-y-3">
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
