import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppUpdateStatus } from "@shared/schema";
import {
  APP_UPDATE_SESSION_STORAGE_KEY,
  formatAppVersionLabel,
  getAppUpdateDismissKey,
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

  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-[12px]">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
          <span className="font-medium uppercase tracking-wider text-amber-200">
            Update available
          </span>
          <span className="text-muted-foreground">
            {`oh-my-pr ${formatAppVersionLabel(status.latestVersion)} is available. You're on ${formatAppVersionLabel(status.currentVersion)}.`}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <a
            href={status.latestReleaseUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium uppercase tracking-wider text-amber-200 transition-colors hover:text-foreground"
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
            className="uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            dismiss for now
          </button>
        </div>
      </div>
    </div>
  );
}
