import test from "node:test";
import assert from "node:assert/strict";
import type { HealingSession } from "@shared/schema";
import {
  formatHealingOperatorActionLabel,
  formatHealingSessionStateLabel,
  getHealingSessionBadgeClass,
  getHealingSessionOperatorActions,
  getHealingSessionReason,
  getHealingSessionStatusHint,
  getHealingSessionTone,
  getHealingSessionView,
  getLatestHealingSessionForPR,
  selectRelevantHealingSession,
  summarizeHealingAttemptProgress,
} from "./ciHealing";

function makeSession(overrides: Partial<HealingSession> = {}): HealingSession {
  return {
    id: "session-1",
    prId: "pr-1",
    repo: "owner/repo",
    prNumber: 42,
    initialHeadSha: "1111111",
    currentHeadSha: "1111111",
    state: "triaging",
    startedAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-01T10:00:00.000Z",
    endedAt: null,
    blockedReason: null,
    escalationReason: null,
    latestFingerprint: null,
    attemptCount: 0,
    lastImprovementScore: null,
    ...overrides,
  };
}

test("formatHealingSessionStateLabel returns a UI-ready label", () => {
  assert.equal(formatHealingSessionStateLabel("awaiting_repair_slot"), "REPAIR QUEUED");
  assert.equal(formatHealingSessionStateLabel("awaiting_ci"), "WAITING FOR CI");
});

test("getHealingSessionBadgeClass returns destructive styling for blocked sessions", () => {
  assert.equal(
    getHealingSessionBadgeClass("blocked"),
    "border-destructive/40 text-destructive bg-destructive/10",
  );
});

test("getHealingSessionBadgeClass returns success styling for healed sessions", () => {
  assert.equal(
    getHealingSessionBadgeClass("healed"),
    "border-green-600 text-green-500 bg-green-600/10",
  );
});

test("getHealingSessionOperatorActions exposes retry for blocked and escalated sessions", () => {
  assert.deepEqual(getHealingSessionOperatorActions("blocked"), ["retry"]);
  assert.deepEqual(getHealingSessionOperatorActions("escalated"), ["retry"]);
});

test("getHealingSessionOperatorActions exposes pause and cancel while a repair run is active", () => {
  assert.deepEqual(getHealingSessionOperatorActions("repairing"), ["pause", "cancel"]);
  assert.deepEqual(getHealingSessionOperatorActions("awaiting_ci"), ["pause", "cancel"]);
});

test("getHealingSessionTone maps terminal failure states to danger and healed to success", () => {
  assert.equal(getHealingSessionTone("escalated"), "danger");
  assert.equal(getHealingSessionTone("healed"), "success");
});

test("formatHealingOperatorActionLabel returns title-cased action labels", () => {
  assert.equal(formatHealingOperatorActionLabel("pause"), "Pause");
  assert.equal(formatHealingOperatorActionLabel("cancel"), "Cancel");
});

test("summarizeHealingAttemptProgress describes queued first attempts", () => {
  assert.equal(
    summarizeHealingAttemptProgress(makeSession({ state: "awaiting_repair_slot", attemptCount: 0 })),
    "Queued for attempt 1",
  );
});

test("summarizeHealingAttemptProgress describes active and verified attempt progress", () => {
  assert.equal(
    summarizeHealingAttemptProgress(makeSession({ state: "awaiting_ci", attemptCount: 2 })),
    "Attempt 2 pushed, waiting on CI",
  );
  assert.equal(
    summarizeHealingAttemptProgress(makeSession({ state: "healed", attemptCount: 2 })),
    "Healed after 2 attempts",
  );
});

test("getHealingSessionReason prefers blocked and escalation reasons before fingerprints", () => {
  assert.equal(
    getHealingSessionReason(makeSession({ blockedReason: "Missing cloud secret", latestFingerprint: "jest" })),
    "Missing cloud secret",
  );
  assert.equal(
    getHealingSessionReason(makeSession({ escalationReason: "No improvement after retry", latestFingerprint: "tsc" })),
    "No improvement after retry",
  );
  assert.equal(getHealingSessionReason(makeSession({ latestFingerprint: "eslint" })), "eslint");
});

test("getHealingSessionStatusHint describes waiting CI states", () => {
  assert.equal(
    getHealingSessionStatusHint("awaiting_ci"),
    "A repair was pushed and the new head SHA is waiting for CI to settle.",
  );
});

test("getLatestHealingSessionForPR returns the most recently updated session for the PR", () => {
  const older = makeSession({ id: "session-old", updatedAt: "2026-04-01T09:00:00.000Z" });
  const newer = makeSession({ id: "session-new", updatedAt: "2026-04-01T11:00:00.000Z" });
  const otherPr = makeSession({
    id: "session-other",
    prId: "pr-2",
    updatedAt: "2026-04-01T12:00:00.000Z",
  });

  assert.equal(
    getLatestHealingSessionForPR([older, otherPr, newer], "pr-1")?.id,
    "session-new",
  );
  assert.equal(getLatestHealingSessionForPR([otherPr], "missing"), null);
});

test("selectRelevantHealingSession returns the latest session for the PR", () => {
  const older = makeSession({ id: "older", updatedAt: "2026-04-01T10:00:00.000Z" });
  const newer = makeSession({ id: "newer", updatedAt: "2026-04-01T11:00:00.000Z" });

  assert.equal(selectRelevantHealingSession([older, newer], "pr-1")?.id, "newer");
});

test("getHealingSessionView returns a compact dashboard-oriented summary", () => {
  const view = getHealingSessionView(
    makeSession({
      state: "blocked",
      attemptCount: 1,
      blockedReason: "Missing secret",
      latestFingerprint: "deploy",
    }),
  );

  assert.equal(view.stateLabel, "BLOCKED");
  assert.equal(view.tone, "danger");
  assert.equal(view.attemptSummary, "1 attempt before blocking");
  assert.equal(view.reasonSummary, "Missing secret");
  assert.equal(view.actions[0]?.label, "Retry");
});
