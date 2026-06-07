import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { UpdateBanner } from "@/components/UpdateBanner";
import type { UsageCounterKey, UsageDailyBucket, UsageSummary } from "@shared/schema";

const USAGE_METRICS: Array<{
  key: UsageCounterKey;
  label: string;
  description: string;
  barClassName: string;
}> = [
  {
    key: "appOpenCount",
    label: "App opens",
    description: "Dashboard sessions started from the app shell.",
    barClassName: "bg-chart-1",
  },
  {
    key: "trackedPrCount",
    label: "PRs tracked",
    description: "Pull requests registered for oh-my-pr to watch.",
    barClassName: "bg-chart-2",
  },
  {
    key: "mergedPrCount",
    label: "Merged",
    description: "Tracked PRs observed as merged.",
    barClassName: "bg-chart-3",
  },
  {
    key: "fixesMadeCount",
    label: "Fixes made",
    description: "Verified branch updates or deployment fix PRs.",
    barClassName: "bg-chart-4",
  },
];

function formatNumber(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

function compactDate(date: string): string {
  return date.slice(5);
}

function metricMax(daily: UsageDailyBucket[], key: UsageCounterKey): number {
  return Math.max(1, ...daily.map((bucket) => bucket[key]));
}

export default function Usage() {
  const { data: usage, isLoading } = useQuery<UsageSummary>({
    queryKey: ["/api/usage"],
  });
  const daily = usage?.daily.slice(-30) ?? [];

  return (
    <div className="flex min-h-screen flex-col" data-testid="usage-page">
      <UpdateBanner />
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Usage">
            <rect x="1" y="1" width="14" height="14" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 11V7M8 11V4M12 11V6" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span className="text-sm font-medium tracking-tight">oh-my-pr</span>
          <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            usage
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            settings
          </Link>
          <Link
            href="/"
            className="text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            &larr; back to dashboard
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div>
            <h1 className="text-base font-medium">Usage</h1>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Anonymous. Stored locally.
            </p>
          </div>

          <section data-testid="usage-totals">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Totals
            </h2>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {USAGE_METRICS.map((metric) => (
                <div key={metric.key} className="border border-border px-3 py-3">
                  <div className="font-mono text-2xl leading-none">
                    {formatNumber(usage?.totals[metric.key])}
                  </div>
                  <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {metric.label}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section data-testid="usage-charts">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Last 30 Recorded Days
            </h2>
            {isLoading ? (
              <div className="border border-border px-4 py-8 text-center text-[12px] text-muted-foreground">
                Loading usage…
              </div>
            ) : daily.length === 0 ? (
              <div className="border border-border px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {USAGE_METRICS.map((metric) => (
                  <UsageChart
                    key={metric.key}
                    metric={metric}
                    daily={daily}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function UsageChart({
  metric,
  daily,
}: {
  metric: (typeof USAGE_METRICS)[number];
  daily: UsageDailyBucket[];
}) {
  const max = metricMax(daily, metric.key);

  return (
    <div className="border border-border p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm">{metric.label}</div>
          <div className="text-[11px] text-muted-foreground">{metric.description}</div>
        </div>
        <div className="font-mono text-sm">
          {formatNumber(daily.reduce((sum, bucket) => sum + bucket[metric.key], 0))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {daily.map((bucket) => {
          const value = bucket[metric.key];
          const width = `${Math.max(value > 0 ? 4 : 0, (value / max) * 100)}%`;

          return (
            <div key={`${metric.key}-${bucket.date}`} className="grid grid-cols-[3.2rem_1fr_2.4rem] items-center gap-2">
              <div className="font-mono text-[10px] text-muted-foreground">
                {compactDate(bucket.date)}
              </div>
              <div className="h-2 border border-border bg-muted/40">
                <div
                  className={`h-full ${metric.barClassName}`}
                  style={{ width }}
                />
              </div>
              <div className="text-right font-mono text-[10px] text-muted-foreground">
                {formatNumber(value)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
