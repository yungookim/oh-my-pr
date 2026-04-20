import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdateStatus } from "@shared/schema";
import {
  formatAppVersionLabel,
  getAppUpdateDismissKey,
  shouldShowAppUpdateBanner,
} from "./updateAlert";

const availableUpdate: AppUpdateStatus = {
  currentVersion: "1.0.0",
  latestVersion: "v1.1.0",
  latestReleaseUrl: "https://github.com/yungookim/oh-my-pr/releases/tag/v1.1.0",
  updateAvailable: true,
};

test("formatAppVersionLabel prefixes bare versions once", () => {
  assert.equal(formatAppVersionLabel("1.0.0"), "v1.0.0");
  assert.equal(formatAppVersionLabel("v1.0.0"), "v1.0.0");
});

test("shouldShowAppUpdateBanner stays visible until the current release is dismissed", () => {
  assert.equal(shouldShowAppUpdateBanner(availableUpdate, null), true);
  assert.equal(
    shouldShowAppUpdateBanner(availableUpdate, getAppUpdateDismissKey(availableUpdate)),
    false,
  );
});

test("shouldShowAppUpdateBanner stays hidden when no update is available", () => {
  assert.equal(
    shouldShowAppUpdateBanner({
      ...availableUpdate,
      updateAvailable: false,
    }, null),
    false,
  );
});
