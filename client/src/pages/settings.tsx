import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Config, RuntimeState } from "@shared/schema";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  getDrainActionLabel,
  getDrainStatusView,
} from "@/lib/runtimeDisplay";

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

  const { data: runtimeState, isError: runtimeStateIsError } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });
  const drainStatusView = getDrainStatusView(runtimeState, runtimeStateIsError);

  const drainMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; reason?: string }) => {
      const res = await apiRequest("POST", "/api/runtime/drain", input);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
      toast({
        description: variables.enabled
          ? "Automation paused. New runs are blocked; in-flight runs will finish."
          : "Automation resumed.",
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Failed to update drain mode: ${error.message}` });
    },
  });

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
    <div className="flex min-h-screen flex-col">
      <UpdateBanner />
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
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
                  <label htmlFor="settings-coding-agent" className="text-sm">Coding Agent</label>
                  <div className="text-[11px] text-muted-foreground">
                    CLI agent used to apply fixes
                  </div>
                </div>
                <select
                  id="settings-coding-agent"
                  value={config?.codingAgent ?? "codex"}
                  onChange={(e) => {
                    const newAgent = e.target.value as Config["codingAgent"];
                    updateConfigMutation.mutate({ codingAgent: newAgent });
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                >
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                </select>
              </div>
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm">Fallback to next coding agent</div>
                  <div className="text-[11px] text-muted-foreground">
                    If the configured agent cannot start or authenticate, retry the babysitter run with the other local agent.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.fallbackToNextCodingAgent ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      fallbackToNextCodingAgent: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 h-4 w-4 accent-foreground"
                  data-testid="checkbox-fallback-to-next-coding-agent"
                />
              </label>
            </div>
          </section>

          {/* Automation */}
          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Automation
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-sm">Auto-resolve conflicts</div>
                  <div className="text-[11px] text-muted-foreground">
                    Ask the agent to resolve merge conflicts when tracked PRs are not mergeable.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoResolveMergeConflicts ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoResolveMergeConflicts: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="checkbox-auto-resolve-conflicts"
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
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
                  data-testid="checkbox-auto-update-docs"
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
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
                  aria-label="Automatic CI healing"
                  checked={config?.autoHealCI ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoHealCI: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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
                  checked={config?.autoCreateReleases ?? false}
                  onChange={(e) => updateConfigMutation.mutate({ autoCreateReleases: e.target.checked })}
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  data-testid="checkbox-auto-create-releases"
                />
              </label>
            </div>
          </section>

          {/* Runtime */}
          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Runtime
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm">Automation</div>
                  <div className="text-[11px] text-muted-foreground">
                    Drain mode blocks new agent runs. In-flight runs continue until they finish.
                  </div>
                  <div
                    className="mt-2 text-[11px]"
                    aria-live="polite"
                    data-testid="text-drain-status"
                  >
                    <span className={drainStatusView.className}>{drainStatusView.label}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    drainMutation.mutate(
                      runtimeState?.drainMode
                        ? { enabled: false }
                        : { enabled: true, reason: "Manually paused via web settings" },
                    )
                  }
                  disabled={!runtimeState || drainMutation.isPending}
                  data-testid="button-toggle-drain"
                  className="shrink-0 border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                >
                  {getDrainActionLabel(runtimeState)}
                </button>
              </div>
              {runtimeState?.drainMode && (runtimeState.drainReason || runtimeState.drainRequestedAt) ? (
                <div className="border-l-2 border-destructive bg-muted/30 px-3 py-2 text-[11px]">
                  {runtimeState.drainReason ? (
                    <div className="text-foreground">{runtimeState.drainReason}</div>
                  ) : null}
                  {runtimeState.drainRequestedAt ? (
                    <div className="mt-1 text-muted-foreground">
                      since {new Date(runtimeState.drainRequestedAt).toLocaleString()}
                    </div>
                  ) : null}
                </div>
              ) : null}
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
                      type="button"
                      onClick={() => setShowTokenInput(true)}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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
                            type="button"
                            onClick={() => moveGithubToken(index, index - 1)}
                            disabled={index === 0 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            up
                          </button>
                          <button
                            type="button"
                            onClick={() => moveGithubToken(index, index + 1)}
                            disabled={index === githubTokens.length - 1 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            down
                          </button>
                          <button
                            type="button"
                            onClick={() => removeGithubToken(index)}
                            disabled={updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
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
                      aria-label="GitHub token"
                      className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const token = newGithubToken.trim();
                        if (token) {
                          updateGithubTokens([...githubTokens, token]);
                          setNewGithubToken("");
                          setShowTokenInput(false);
                        }
                      }}
                      disabled={!newGithubToken.trim() || updateConfigMutation.isPending}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                    >
                      add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowTokenInput(false);
                        setNewGithubToken("");
                      }}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      cancel
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="settings-github-comment-app-name" className="text-sm">
                  GitHub reply signature
                </label>
                <div className="text-[11px] text-muted-foreground">
                  Replace the app name shown in public GitHub replies. Leave blank to remove it.
                </div>
                <input
                  id="settings-github-comment-app-name"
                  key={config?.githubCommentAppName ?? "oh-my-pr"}
                  type="text"
                  defaultValue={config?.githubCommentAppName ?? "oh-my-pr"}
                  placeholder="leave blank to remove"
                  onBlur={(e) => {
                    const githubCommentAppName = e.target.value;
                    if (githubCommentAppName !== (config?.githubCommentAppName ?? "oh-my-pr")) {
                      updateConfigMutation.mutate({ githubCommentAppName });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="w-full border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Repository links in PR comments</div>
                  <div className="text-[11px] text-muted-foreground">
                    Link the reply signature back to the project repository in agent-authored GitHub PR comments and footers.
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="Repository links in PR comments"
                  checked={config?.includeRepositoryLinksInGitHubComments ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      includeRepositoryLinksInGitHubComments: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">GitHub progress replies</div>
                  <div className="text-[11px] text-muted-foreground">
                    Post public Accepted/running/completed status replies while the babysitter works on review comments.
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="GitHub progress replies"
                  checked={config?.postGitHubProgressReplies ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      postGitHubProgressReplies: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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

              <StringListRow
                label="Ignored bots"
                description="Bot logins whose comments and reviews are ignored."
                placeholder="dependabot[bot]"
                values={config?.ignoredBots ?? []}
                onChange={(next) => updateConfigMutation.mutate({ ignoredBots: next })}
                disabled={!config || updateConfigMutation.isPending}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StringListRow({
  label,
  description,
  placeholder,
  values,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputId = `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const descriptionId = `${inputId}-description`;

  const addValue = () => {
    const trimmed = draft.trim();
    const lowered = trimmed.toLowerCase();
    if (!trimmed || values.some((v) => v.toLowerCase() === lowered)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  };

  const removeValue = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm">{label}</span>
          <span id={descriptionId} className="block text-[11px] text-muted-foreground">{description}</span>
          <input
            id={inputId}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addValue();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            aria-describedby={descriptionId}
            className="mt-2 w-full min-w-0 border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={addValue}
          disabled={!draft.trim() || disabled}
          className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          add
        </button>
      </div>
      {values.length ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <span
              key={value}
              className="inline-flex items-center gap-1.5 border border-border px-2 py-0.5 font-mono text-xs"
            >
              {value}
              <button
                type="button"
                onClick={() => removeValue(index)}
                disabled={disabled}
                aria-label={`Remove ${value}`}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">none configured</div>
      )}
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
  const inputId = `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const descriptionId = `${inputId}-description`;

  return (
    <div className="flex items-center justify-between">
      <div>
        <label htmlFor={inputId} className="text-sm">{label}</label>
        <div id={descriptionId} className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      <input
        id={inputId}
        type="number"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={disabled}
        aria-describedby={descriptionId}
        className="w-28 border border-border bg-transparent px-2 py-1 text-right text-sm focus:border-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
      />
    </div>
  );
}
