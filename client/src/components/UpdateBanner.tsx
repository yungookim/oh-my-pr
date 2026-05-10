import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppUpdateStatus } from "@shared/schema";
import {
  APP_UPDATE_SESSION_STORAGE_KEY,
  formatAppVersionLabel,
  getAppUpdateDismissKey,
  getAppUpdateInstructionSteps,
  shouldShowAppUpdateBanner,
} from "@/lib/updateAlert";

export function UpdateBanner() {
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.sessionStorage.getItem(APP_UPDATE_SESSION_STORAGE_KEY);
  });

  const { data: status } = useQuery<AppUpdateStatus>({
    queryKey: ["/api/app-update"],
  });

  if (!status || !shouldShowAppUpdateBanner(status, dismissedKey)) {
    return null;
  }

  const dismissalKey = getAppUpdateDismissKey(status);
  if (!dismissalKey || !status.latestVersion) {
    return null;
  }

  const updateInstructionSteps = getAppUpdateInstructionSteps();

  return (
    <div className="shrink-0 border-b border-warning-border bg-warning-muted">
      <div className="grid gap-2 px-4 py-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-[12px]">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            <span className="font-medium uppercase tracking-wider text-warning-foreground">
              Update available
            </span>
            <span className="text-foreground/75">
              {`oh-my-pr ${formatAppVersionLabel(status.latestVersion)} is available. You're on ${formatAppVersionLabel(status.currentVersion)}.`}
            </span>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-[11px] text-foreground/70">
            {updateInstructionSteps.map((step) => (
              <li key={`${step.text}:${step.command ?? ""}`} className="pl-0.5">
                {step.command ? (
                  <>
                    {step.text} <code className="font-mono text-foreground">{step.command}</code>.
                  </>
                ) : (
                  step.text
                )}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <a
            href={status.latestReleaseUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium uppercase tracking-wider text-warning-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            Update oh-my-pr
          </a>
          <button
            onClick={() => {
              if (typeof window !== "undefined") {
                window.sessionStorage.setItem(APP_UPDATE_SESSION_STORAGE_KEY, dismissalKey);
              }
              setDismissedKey(dismissalKey);
            }}
            className="uppercase tracking-wider text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            dismiss for now
          </button>
        </div>
      </div>
    </div>
  );
}
