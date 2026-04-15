import { useEffect, useState } from "react";
import type { Config, LogEntry, PR, PRQuestion } from "@shared/schema";
import type { TuiRuntime, TuiRuntimeSnapshot } from "./types";

export type TuiSnapshot = {
  prs: PR[];
  selectedPr: PR | null;
  logs: LogEntry[];
  questions: PRQuestion[];
  repos: string[];
  config: Config | null;
  runtime: TuiRuntimeSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useRuntimeSnapshot(
  runtime: TuiRuntime,
  selectedPrId: string | null,
  refreshMs = 1500,
): TuiSnapshot {
  const [prs, setPrs] = useState<PR[]>([]);
  const [selectedPr, setSelectedPr] = useState<PR | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [questions, setQuestions] = useState<PRQuestion[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<TuiRuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const [nextPrs, nextRepos, nextConfig, nextRuntime] = await Promise.all([
          runtime.listPRs("active"),
          runtime.listRepos(),
          runtime.getConfig(),
          runtime.getRuntimeSnapshot(),
        ]);

        const nextSelectedPr = selectedPrId
          ? await runtime.getPR(selectedPrId)
          : nextPrs[0] ?? null;
        const [nextLogs, nextQuestions] = nextSelectedPr
          ? await Promise.all([
              runtime.listLogs(nextSelectedPr.id),
              runtime.listPRQuestions(nextSelectedPr.id),
            ])
          : [[], []];

        if (cancelled) {
          return;
        }

        setPrs(nextPrs);
        setRepos(nextRepos);
        setConfig(nextConfig);
        setRuntimeSnapshot(nextRuntime);
        setSelectedPr(nextSelectedPr);
        setLogs(nextLogs);
        setQuestions(nextQuestions);
        setError(null);
      } catch (nextError) {
        if (cancelled) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void refresh();
    const unsubscribe = runtime.subscribe(() => {
      void refresh();
    });

    const interval = refreshMs > 0
      ? setInterval(() => {
          void refresh();
        }, refreshMs)
      : null;

    return () => {
      cancelled = true;
      unsubscribe();
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [runtime, selectedPrId, refreshMs]);

  return {
    prs,
    selectedPr,
    logs,
    questions,
    repos,
    config,
    runtime: runtimeSnapshot,
    loading,
    error,
    refresh: async () => {
      const nextPrs = await runtime.listPRs("active");
      const nextRepos = await runtime.listRepos();
      const nextConfig = await runtime.getConfig();
      const nextRuntime = await runtime.getRuntimeSnapshot();
      const nextSelectedPr = selectedPrId
        ? await runtime.getPR(selectedPrId)
        : nextPrs[0] ?? null;
      const [nextLogs, nextQuestions] = nextSelectedPr
        ? await Promise.all([
            runtime.listLogs(nextSelectedPr.id),
            runtime.listPRQuestions(nextSelectedPr.id),
          ])
        : [[], []];

      setPrs(nextPrs);
      setRepos(nextRepos);
      setConfig(nextConfig);
      setRuntimeSnapshot(nextRuntime);
      setSelectedPr(nextSelectedPr);
      setLogs(nextLogs);
      setQuestions(nextQuestions);
      setLoading(false);
      setError(null);
    },
  };
}
