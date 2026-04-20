import type { AppUpdateStatus } from "@shared/schema";

export const APP_UPDATE_SESSION_STORAGE_KEY = "app-update-dismissed";

export function formatAppVersionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function getAppUpdateDismissKey(status: Pick<AppUpdateStatus, "latestVersion">): string | null {
  return status.latestVersion ? `app-update:${status.latestVersion}` : null;
}

export function shouldShowAppUpdateBanner(
  status: AppUpdateStatus | null | undefined,
  dismissedKey: string | null,
): boolean {
  if (!status?.updateAvailable) {
    return false;
  }

  const dismissalKey = getAppUpdateDismissKey(status);
  return dismissalKey !== null && dismissalKey !== dismissedKey;
}
