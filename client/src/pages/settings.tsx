import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Config } from "@shared/schema";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";

export default function Settings() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const [githubToken, setGithubToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      toast({ description: "Settings saved." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Failed to save: ${error.message}` });
    },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
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

          {/* GitHub Token */}
          <section>
            <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              GitHub
            </h2>
            <div className="flex flex-col gap-4 rounded border border-border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">Token</div>
                  <div className="text-[11px] text-muted-foreground">
                    {config?.githubToken || "not set"}
                  </div>
                </div>
                {showTokenInput ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      placeholder="ghp_..."
                      className="border border-border bg-transparent px-2 py-1 text-sm focus:border-foreground focus:outline-none"
                    />
                    <button
                      onClick={() => {
                        if (githubToken) {
                          updateConfigMutation.mutate({ githubToken });
                          setGithubToken("");
                          setShowTokenInput(false);
                        }
                      }}
                      disabled={!githubToken || updateConfigMutation.isPending}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      save
                    </button>
                    <button
                      onClick={() => {
                        setShowTokenInput(false);
                        setGithubToken("");
                      }}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowTokenInput(true)}
                    className="border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    update
                  </button>
                )}
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
