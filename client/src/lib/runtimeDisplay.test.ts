import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeState } from "@shared/schema";
import {
  getDrainActionLabel,
  getDrainStatusView,
} from "./runtimeDisplay";

const activeRuntimeState: RuntimeState = {
  drainMode: false,
  drainRequestedAt: null,
  drainReason: null,
  watcherStartedAt: null,
  watcherHeartbeatAt: null,
  watcherCompletedAt: null,
  watcherLastError: null,
  watcherIntervalMs: null,
};

test("getDrainStatusView shows loading before runtime state is available", () => {
  assert.deepEqual(getDrainStatusView(undefined, false), {
    label: "loading...",
    className: "text-muted-foreground",
  });
});

test("getDrainStatusView shows an error when runtime state fails to load", () => {
  assert.deepEqual(getDrainStatusView(undefined, true), {
    label: "unavailable",
    className: "text-destructive",
  });
});

test("getDrainStatusView shows active and paused runtime states", () => {
  assert.deepEqual(getDrainStatusView(activeRuntimeState, false), {
    label: "active",
    className: "text-muted-foreground",
  });
  assert.deepEqual(getDrainStatusView({ ...activeRuntimeState, drainMode: true }, false), {
    label: "paused",
    className: "text-destructive",
  });
});

test("getDrainActionLabel returns capitalized action labels", () => {
  assert.equal(getDrainActionLabel(undefined), "Pause");
  assert.equal(getDrainActionLabel(activeRuntimeState), "Pause");
  assert.equal(getDrainActionLabel({ ...activeRuntimeState, drainMode: true }), "Resume");
});
