import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { SocialChangelog } from "@shared/schema";

// ── helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Splits the raw Claude output into the two named sections.
 * Returns null for a section if it isn't present.
 */
function parseSections(content: string): { twitter: string | null; linkedin: string | null } {
  const twitterMatch = content.match(/##\s*Twitter\/X\s*(?:Thread)?\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  const linkedinMatch = content.match(/##\s*LinkedIn\s*(?:\/\s*General)?\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  return {
    twitter: twitterMatch ? twitterMatch[1].trim() : null,
    linkedin: linkedinMatch ? linkedinMatch[1].trim() : null,
  };
}

// ── sub-components ─────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select the text
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="border border-border px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:border-foreground hover:text-foreground focus:outline-none"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function SectionBlock({ title, content }: { title: string; content: string }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{title}</span>
        <CopyButton text={content} />
      </div>
      <pre className="whitespace-pre-wrap border border-border bg-background p-3 text-[12px] leading-relaxed font-mono">
        {content}
      </pre>
    </div>
  );
}

function StatusBadge({ status }: { status: SocialChangelog["status"] }) {
  const cls =
    status === "done"
      ? "border-foreground/40 text-foreground"
      : status === "generating"
        ? "border-border text-muted-foreground animate-pulse"
        : "border-destructive/40 text-destructive";
  return (
    <span className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

function ChangelogCard({ changelog }: { changelog: SocialChangelog }) {
  const [expanded, setExpanded] = useState(false);
  const sections = changelog.content ? parseSections(changelog.content) : null;

  return (
    <div className="border border-border">
      {/* Card header */}
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-muted/30"
        onClick={() => changelog.status === "done" && setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <StatusBadge status={changelog.status} />
          <span className="text-sm font-medium">{formatDate(changelog.createdAt)}</span>
          <span className="text-[11px] text-muted-foreground">
            {changelog.triggerCount} PR{changelog.triggerCount !== 1 ? "s" : ""} merged
          </span>
          <span className="text-[11px] text-muted-foreground">
            {changelog.prSummaries.map((p) => `#${p.number}`).join(" · ")}
          </span>
        </div>
        {changelog.status === "done" && (
          <span className="text-[11px] text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        )}
      </div>

      {/* Expanded content */}
      {expanded && changelog.status === "done" && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          {changelog.error && (
            <p className="mb-3 text-[12px] text-destructive">{changelog.error}</p>
          )}
          {sections?.twitter && (
            <SectionBlock title="Twitter / X Thread" content={sections.twitter} />
          )}
          {sections?.linkedin && (
            <SectionBlock title="LinkedIn / General" content={sections.linkedin} />
          )}
          {!sections?.twitter && !sections?.linkedin && changelog.content && (
            <SectionBlock title="Full output" content={changelog.content} />
          )}
        </div>
      )}

      {/* Error state */}
      {changelog.status === "error" && changelog.error && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-[12px] text-destructive">{changelog.error}</p>
        </div>
      )}

      {/* Generating state */}
      {changelog.status === "generating" && (
        <div className="border-t border-border px-4 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            Generating social media post with AI agent…
          </span>
        </div>
      )}
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

export default function Changelogs() {
  const { data: changelogs = [], isLoading } = useQuery<SocialChangelog[]>({
    queryKey: ["/api/changelogs"],
    // Poll every 5 s so "generating" cards update automatically
    refetchInterval: (query) => {
      const data = query.state.data as SocialChangelog[] | undefined;
      return data?.some((c) => c.status === "generating") ? 5000 : false;
    },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="PR Feedback Agent">
            <rect x="1" y="1" width="14" height="14" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 5h8M4 8h5M4 11h6" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span className="text-sm font-medium tracking-tight">code factory</span>
          <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            changelogs
          </span>
        </div>
        <Link
          href="/"
          className="text-[11px] text-muted-foreground hover:text-foreground focus:outline-none"
        >
          ← back to dashboard
        </Link>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          {/* Page title */}
          <div className="mb-5">
            <h1 className="text-base font-medium">Social Media Changelogs</h1>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Generated automatically every 5 PRs merged to main. Copy and paste into Twitter/X or LinkedIn.
            </p>
          </div>

          {/* Empty state */}
          {!isLoading && changelogs.length === 0 && (
            <div className="border border-border px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">No changelogs yet.</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                A post will be generated automatically after every 5 PRs are merged to main.
              </p>
            </div>
          )}

          {/* Loading state */}
          {isLoading && (
            <div className="border border-border px-4 py-6 text-center">
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            </div>
          )}

          {/* Changelog list */}
          <div className="flex flex-col gap-2">
            {changelogs.map((changelog) => (
              <ChangelogCard key={changelog.id} changelog={changelog} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
