import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Config } from "@shared/schema";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";

export default function Settings() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const [newGithubToken, setNewGithubToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const githubTokens = config?.githubTokens ?? (config?.githubToken ? [config.githubToken] : []);

  const updateGithubTokens = (tokens: string[]) => {
    updateConfigMutation.mutate({ githubTokens: tokens });
  };
  const moveGithubToken = (fromIndex: number, toIndex: number) => {
    const next = [...githubTokens];
    const [token] = next.splice(fromIndex, 1);
    if (!token) {
      return;
    }
    next.splice(toIndex, 0, token);
    updateGithubTokens(next);
  };
  const removeGithubToken = (index: number) => {
    updateGithubTokens(githubTokens.filter((_, i) => i !== index));
  };

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({ description: "Settings saved." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Failed to save: ${error.message}` });
    },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <UpdateBanner />
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-[11px] text-muted-foreground hover:text-foreground">
            &larr; back
          </Link>
          <span className="text-sm font-medium tracking-tight">settings</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">

          {/* Agent */}
          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Agent
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">Coding Agent</div>
                  <div className="text-[11px] text-muted-foreground">
                    CLI agent used to apply fixes
                  </div>
                </div>
                <select
                  value={config?.codingAgent ?? "codex"}
                  onChange={(e) => {
                    const newAgent = e.target.value as Config["codingAgent"];
                    updateConfigMutation.mutate({ codingAgent: newAgent });
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none disabled:opacity-50"
                >
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                </select>
              </div>
            </div>
          </section>

          {/* Tuning */}
          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tuning
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <SettingRow
                label="Max turns"
                description="Maximum agent turns per feedback item"
                value={config?.maxTurns ?? 15}
                onChange={(v) => updateConfigMutation.mutate({ maxTurns: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Poll interval (ms)"
                description="How often to check for new feedback"
                value={config?.pollIntervalMs ?? 120000}
                onChange={(v) => updateConfigMutation.mutate({ pollIntervalMs: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Batch window (ms)"
                description="Time to batch feedback before processing"
                value={config?.batchWindowMs ?? 300000}
                onChange={(v) => updateConfigMutation.mutate({ batchWindowMs: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Max changes per run"
                description="Limit on concurrent changes"
                value={config?.maxChangesPerRun ?? 20}
                onChange={(v) => updateConfigMutation.mutate({ maxChangesPerRun: v })}
                disabled={updateConfigMutation.isPending}
              />
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">Auto-update docs</div>
                  <div className="text-[11px] text-muted-foreground">
                    Automatically assess whether tracked PRs need documentation updates.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoUpdateDocs ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoUpdateDocs: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground"
                />
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              CI Healing
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Automatic CI healing</div>
                  <div className="text-[11px] text-muted-foreground">
                    Classify healable CI failures and run bounded repair attempts in isolated worktrees.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoHealCI ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoHealCI: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground"
                />
              </div>
              <SettingRow
                label="Max healing attempts per session"
                description="Upper bound on repair attempts for a single healing session"
                value={config?.maxHealingAttemptsPerSession ?? 3}
                onChange={(v) => updateConfigMutation.mutate({ maxHealingAttemptsPerSession: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Max healing attempts per fingerprint"
                description="Cap retries for the same failure fingerprint"
                value={config?.maxHealingAttemptsPerFingerprint ?? 2}
                onChange={(v) => updateConfigMutation.mutate({ maxHealingAttemptsPerFingerprint: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Max concurrent healing runs"
                description="How many healing runs can execute at once"
                value={config?.maxConcurrentHealingRuns ?? 1}
                onChange={(v) => updateConfigMutation.mutate({ maxConcurrentHealingRuns: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Healing cooldown (ms)"
                description="Backoff before a cooldowned session can retry"
                value={config?.healingCooldownMs ?? 300000}
                onChange={(v) => updateConfigMutation.mutate({ healingCooldownMs: v })}
                disabled={updateConfigMutation.isPending}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Releases
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm">Automatic release creation</div>
                  <div className="text-[11px] text-muted-foreground">
                    Evaluate merged PRs and publish GitHub releases automatically when the agent decides they are release-worthy.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoCreateReleases ?? true}
                  onChange={(e) => updateConfigMutation.mutate({ autoCreateReleases: e.target.checked })}
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 accent-foreground"
                  data-testid="checkbox-auto-create-releases"
                />
              </label>
            </div>
          </section>

          {/* GitHub Tokens */}
          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              GitHub
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Tokens</div>
                    <div className="text-[11px] text-muted-foreground">
                      Tried in order before GITHUB_TOKEN and gh auth.
                    </div>
                  </div>
                  {!showTokenInput && (
                    <button
                      onClick={() => setShowTokenInput(true)}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted"
                    >
                      add
                    </button>
                  )}
                </div>
                {githubTokens.length ? (
                  <div className="flex flex-col gap-2">
                    {githubTokens.map((token, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-3 border border-border px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{token}</div>
                          <div className="text-[10px] text-muted-foreground">
                            priority {index + 1}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => moveGithubToken(index, index - 1)}
                            disabled={index === 0 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          >
                            up
                          </button>
                          <button
                            onClick={() => moveGithubToken(index, index + 1)}
                            disabled={index === githubTokens.length - 1 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          >
                            down
                          </button>
                          <button
                            onClick={() => removeGithubToken(index)}
                            disabled={updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          >
                            remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground">none configured</div>
                )}
                {showTokenInput ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={newGithubToken}
                      onChange={(e) => setNewGithubToken(e.target.value)}
                      placeholder="ghp_..."
                      className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none"
                    />
                    <button
                      onClick={() => {
                        const token = newGithubToken.trim();
                        if (token) {
                          updateGithubTokens([...githubTokens, token]);
                          setNewGithubToken("");
                          setShowTokenInput(false);
                        }
                      }}
                      disabled={!newGithubToken.trim() || updateConfigMutation.isPending}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      add
                    </button>
                    <button
                      onClick={() => {
                        setShowTokenInput(false);
                        setNewGithubToken("");
                      }}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      cancel
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Repository links in PR comments</div>
                  <div className="text-[11px] text-muted-foreground">
                    Link oh-my-pr back to its repository in agent-authored GitHub PR comments and footers.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.includeRepositoryLinksInGitHubComments ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      includeRepositoryLinksInGitHubComments: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground"
                />
              </div>

              <div>
                <div className="text-sm">Trusted reviewers</div>
                <div className="text-[11px] text-muted-foreground">
                  {config?.trustedReviewers?.length
                    ? config.trustedReviewers.join(", ")
                    : "none configured"}
                </div>
              </div>

              <div>
                <div className="text-sm">Ignored bots</div>
                <div className="text-[11px] text-muted-foreground">
                  {config?.ignoredBots?.length
                    ? config.ignoredBots.join(", ")
                    : "none configured"}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={disabled}
        className="w-28 border border-border bg-transparent px-2 py-1 text-right text-sm focus:border-foreground focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
