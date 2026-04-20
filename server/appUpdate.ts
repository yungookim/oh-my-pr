import type { AppUpdateStatus } from "@shared/schema";
import { parseSemverTag } from "./github";

const GITHUB_RELEASES_URL = "https://github.com/yungookim/oh-my-pr/releases";
const GITHUB_LATEST_RELEASE_API_URL = "https://api.github.com/repos/yungookim/oh-my-pr/releases/latest";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubLatestReleaseResponse = {
  tag_name?: string | null;
  html_url?: string | null;
  draft?: boolean;
  prerelease?: boolean;
};

export type AppUpdateChecker = (currentVersion: string) => Promise<AppUpdateStatus>;
type AppUpdateCheckerOptions = {
  cacheTtlMs?: number;
  now?: () => number;
};

type CachedAppUpdateStatus = {
  status: AppUpdateStatus;
  expiresAt: number;
};

export const APP_UPDATE_CACHE_TTL_MS = 60 * 60 * 1000;

function compareSemverTags(left: string, right: string): number {
  const leftVersion = parseSemverTag(left);
  const rightVersion = parseSemverTag(right);

  if (!leftVersion || !rightVersion) {
    return 0;
  }

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }

  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }

  return leftVersion.patch - rightVersion.patch;
}

function createFallbackStatus(currentVersion: string): AppUpdateStatus {
  return {
    currentVersion,
    latestVersion: null,
    latestReleaseUrl: GITHUB_RELEASES_URL,
    updateAvailable: false,
  };
}

export async function fetchAppUpdateStatus(
  currentVersion: string,
  fetchImpl: FetchLike = fetch,
): Promise<AppUpdateStatus> {
  const trimmedCurrentVersion = currentVersion.trim();
  const fallback = createFallbackStatus(trimmedCurrentVersion);

  if (!parseSemverTag(trimmedCurrentVersion)) {
    return fallback;
  }

  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_API_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `oh-my-pr/${trimmedCurrentVersion}`,
      },
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = await response.json() as GitHubLatestReleaseResponse;
    const latestVersion = payload.tag_name?.trim() ?? null;

    if (payload.draft || payload.prerelease || !latestVersion || !parseSemverTag(latestVersion)) {
      return fallback;
    }

    return {
      currentVersion: trimmedCurrentVersion,
      latestVersion,
      latestReleaseUrl: payload.html_url?.trim() || GITHUB_RELEASES_URL,
      updateAvailable: compareSemverTags(latestVersion, trimmedCurrentVersion) > 0,
    };
  } catch {
    return fallback;
  }
}

export function createAppUpdateChecker(
  fetchImpl: FetchLike = fetch,
  options: AppUpdateCheckerOptions = {},
): AppUpdateChecker {
  const cacheTtlMs = options.cacheTtlMs ?? APP_UPDATE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedAppUpdateStatus>();
  const inFlight = new Map<string, Promise<AppUpdateStatus>>();

  return async (currentVersion: string) => {
    const cacheKey = currentVersion.trim();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return cached.status;
    }

    const pendingRequest = inFlight.get(cacheKey);
    if (pendingRequest) {
      return pendingRequest;
    }

    // Deduplicate concurrent checks so bursts still consume a single GitHub API call.
    const request = fetchAppUpdateStatus(cacheKey, fetchImpl).then((status) => {
      cache.set(cacheKey, {
        status,
        expiresAt: now() + cacheTtlMs,
      });
      inFlight.delete(cacheKey);
      return status;
    }, (error: unknown) => {
      inFlight.delete(cacheKey);
      throw error;
    });

    inFlight.set(cacheKey, request);
    return request;
  };
}
