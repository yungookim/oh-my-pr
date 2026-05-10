import type { AppUpdateStatus } from "@shared/schema";

export const APP_UPDATE_SESSION_STORAGE_KEY = "app-update-dismissed";
export const APP_UPDATE_INSTALL_COMMAND = "npm install -g oh-my-pr@latest";

export type AppUpdateInstructionStep = {
  text: string;
  command?: string;
};

export function getAppUpdateInstructionSteps(): AppUpdateInstructionStep[] {
  return [
    { text: "Stop the running oh-my-pr process." },
    { text: "Run", command: APP_UPDATE_INSTALL_COMMAND },
    { text: "Start oh-my-pr again." },
  ];
}

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
