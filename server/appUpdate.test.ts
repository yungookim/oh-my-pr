import assert from "node:assert/strict";
import test from "node:test";
import { createAppUpdateChecker, fetchAppUpdateStatus } from "./appUpdate";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("fetchAppUpdateStatus reports a newer stable release", async () => {
  const status = await fetchAppUpdateStatus("1.0.0", async () =>
    jsonResponse(200, {
      tag_name: "v1.2.0",
      html_url: "https://github.com/yungookim/oh-my-pr/releases/tag/v1.2.0",
    }),
  );

  assert.deepEqual(status, {
    currentVersion: "1.0.0",
    latestVersion: "v1.2.0",
    latestReleaseUrl: "https://github.com/yungookim/oh-my-pr/releases/tag/v1.2.0",
    updateAvailable: true,
  });
});

test("fetchAppUpdateStatus skips network checks for non-semver builds", async () => {
  let called = false;

  const status = await fetchAppUpdateStatus("dev", async () => {
    called = true;
    return jsonResponse(200, {
      tag_name: "v9.9.9",
      html_url: "https://github.com/yungookim/oh-my-pr/releases/tag/v9.9.9",
    });
  });

  assert.equal(called, false);
  assert.deepEqual(status, {
    currentVersion: "dev",
    latestVersion: null,
    latestReleaseUrl: "https://github.com/yungookim/oh-my-pr/releases",
    updateAvailable: false,
  });
});

test("fetchAppUpdateStatus falls back quietly when the release check fails", async () => {
  const status = await fetchAppUpdateStatus("1.0.0", async () => {
    throw new Error("network down");
  });

  assert.deepEqual(status, {
    currentVersion: "1.0.0",
    latestVersion: null,
    latestReleaseUrl: "https://github.com/yungookim/oh-my-pr/releases",
    updateAvailable: false,
  });
});

test("createAppUpdateChecker caches update status until the ttl expires", async () => {
  let fetchCalls = 0;
  let nowMs = 1_000;
  const checker = createAppUpdateChecker(
    async () => {
      fetchCalls += 1;
      const version = `v1.${fetchCalls}.0`;

      return jsonResponse(200, {
        tag_name: version,
        html_url: `https://github.com/yungookim/oh-my-pr/releases/tag/${version}`,
      });
    },
    {
      cacheTtlMs: 5_000,
      now: () => nowMs,
    },
  );

  const first = await checker("1.0.0");
  const second = await checker("1.0.0");

  assert.equal(fetchCalls, 1);
  assert.deepEqual(second, first);

  nowMs += 4_999;
  const stillCached = await checker("1.0.0");
  assert.equal(fetchCalls, 1);
  assert.deepEqual(stillCached, first);

  nowMs += 2;
  const refreshed = await checker("1.0.0");
  assert.equal(fetchCalls, 2);
  assert.deepEqual(refreshed, {
    currentVersion: "1.0.0",
    latestVersion: "v1.2.0",
    latestReleaseUrl: "https://github.com/yungookim/oh-my-pr/releases/tag/v1.2.0",
    updateAvailable: true,
  });
});

test("createAppUpdateChecker deduplicates concurrent release checks", async () => {
  let fetchCalls = 0;
  let resolveFetch: ((response: Response) => void) | undefined;
  const checker = createAppUpdateChecker(async () => {
    fetchCalls += 1;

    return await new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  });

  const firstRequest = checker("1.0.0");
  const secondRequest = checker("1.0.0");

  assert.equal(fetchCalls, 1);

  resolveFetch?.(jsonResponse(200, {
    tag_name: "v1.1.0",
    html_url: "https://github.com/yungookim/oh-my-pr/releases/tag/v1.1.0",
  }));

  const [first, second] = await Promise.all([firstRequest, secondRequest]);

  assert.deepEqual(first, second);
  assert.equal(fetchCalls, 1);
});
