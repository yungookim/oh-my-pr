import type { Config, HealingSession, HealingSessionState } from "@shared/schema";

export type HealingOperatorAction = "pause" | "resume" | "retry" | "cancel";
export type HealingViewTone = "neutral" | "info" | "warning" | "success" | "danger";

export type HealingSessionActionView = {
  label: string;
  available: boolean;
  hint: string;
};

export type HealingSessionView = {
  stateLabel: string;
  tone: HealingViewTone;
  attemptSummary: string;
  reasonSummary: string | null;
  statusHint: string;
  actions: HealingSessionActionView[];
};

const HEALING_STATE_LABELS: Record<HealingSessionState, string> = {
  idle: "IDLE",
  triaging: "TRIAGING",
  awaiting_repair_slot: "REPAIR QUEUED",
  repairing: "REPAIRING",
  awaiting_ci: "WAITING FOR CI",
  verifying: "VERIFYING",
  healed: "HEALED",
  cooldown: "COOLDOWN",
  blocked: "BLOCKED",
  escalated: "ESCALATED",
  superseded: "SUPERSEDED",
};

const HEALING_BADGE_CLASSES: Record<HealingSessionState, string> = {
  idle: "border-border text-muted-foreground",
  triaging: "border-foreground/30 text-foreground/80 bg-muted/40",
  awaiting_repair_slot: "border-amber-600/40 text-amber-500 bg-amber-500/10",
  repairing: "border-foreground/30 text-foreground bg-muted/70",
  awaiting_ci: "border-foreground/30 text-foreground bg-muted/70",
  verifying: "border-foreground/30 text-foreground bg-muted/70",
  healed: "border-green-600 text-green-500 bg-green-600/10",
  cooldown: "border-amber-600/40 text-amber-500 bg-amber-500/10",
  blocked: "border-destructive/40 text-destructive bg-destructive/10",
  escalated: "border-destructive/40 text-destructive bg-destructive/10",
  superseded: "border-border text-muted-foreground bg-muted/40",
};

const HEALING_OPERATOR_ACTIONS: Record<HealingSessionState, HealingOperatorAction[]> = {
  idle: [],
  triaging: ["cancel"],
  awaiting_repair_slot: ["pause", "cancel"],
  repairing: ["pause", "cancel"],
  awaiting_ci: ["pause", "cancel"],
  verifying: ["cancel"],
  healed: [],
  cooldown: ["resume", "cancel"],
  blocked: ["retry"],
  escalated: ["retry"],
  superseded: [],
};

const HEALING_VIEW_TONES: Record<HealingSessionState, HealingViewTone> = {
  idle: "neutral",
  triaging: "info",
  awaiting_repair_slot: "warning",
  repairing: "info",
  awaiting_ci: "info",
  verifying: "info",
  healed: "success",
  cooldown: "warning",
  blocked: "danger",
  escalated: "danger",
  superseded: "neutral",
};

const HEALING_STATUS_HINTS: Record<HealingSessionState, string> = {
  idle: "Waiting for a new failing check on the current PR head.",
  triaging: "Classifying the current failure set before deciding whether it is safe to repair.",
  awaiting_repair_slot: "Ready for the next bounded repair attempt as soon as a slot is free.",
  repairing: "A repair agent is actively working in an isolated worktree.",
  awaiting_ci: "A repair was pushed and the new head SHA is waiting for CI to settle.",
  verifying: "Comparing the latest check results against the previous failure fingerprint.",
  healed: "The latest repair cycle converged to green and the session is complete.",
  cooldown: "Cooling down before another retry is allowed.",
  blocked: "Stopped because the failure looks external or unsafe to repair in-branch.",
  escalated: "Stopped because retries were exhausted or the failure did not improve.",
  superseded: "Replaced after the PR head moved to a newer commit.",
};

export function formatHealingSessionStateLabel(state: HealingSessionState): string {
  return HEALING_STATE_LABELS[state];
}

export function getHealingSessionBadgeClass(state: HealingSessionState): string {
  return HEALING_BADGE_CLASSES[state];
}

export function getHealingSessionOperatorActions(
  state: HealingSessionState,
): HealingOperatorAction[] {
  return HEALING_OPERATOR_ACTIONS[state];
}

export function formatHealingOperatorActionLabel(action: HealingOperatorAction): string {
  if (action === "pause") {
    return "Pause";
  }

  if (action === "resume") {
    return "Resume";
  }

  if (action === "retry") {
    return "Retry";
  }

  return "Cancel";
}

export function getHealingSessionTone(state: HealingSessionState): HealingViewTone {
  return HEALING_VIEW_TONES[state];
}

export function getHealingSessionStatusHint(state: HealingSessionState): string {
  return HEALING_STATUS_HINTS[state];
}

export function summarizeHealingAttemptProgress(
  session: Pick<HealingSession, "state" | "attemptCount">,
): string {
  const attempts = session.attemptCount;
  const suffix = attempts === 1 ? "" : "s";

  if (attempts === 0) {
    if (session.state === "triaging") {
      return "Preparing attempt 1";
    }

    if (session.state === "awaiting_repair_slot") {
      return "Queued for attempt 1";
    }

    if (session.state === "healed") {
      return "Healed without a repair attempt";
    }

    return "No repair attempts yet";
  }

  if (session.state === "repairing") {
    return `Attempt ${attempts} running`;
  }

  if (session.state === "awaiting_ci") {
    return `Attempt ${attempts} pushed, waiting on CI`;
  }

  if (session.state === "verifying") {
    return `Attempt ${attempts} verifying`;
  }

  if (session.state === "healed") {
    return `Healed after ${attempts} attempt${suffix}`;
  }

  if (session.state === "blocked") {
    return `${attempts} attempt${suffix} before blocking`;
  }

  if (session.state === "escalated") {
    return `${attempts} attempt${suffix} before escalation`;
  }

  if (session.state === "cooldown") {
    return `${attempts} attempt${suffix}, cooling down`;
  }

  if (session.state === "superseded") {
    return `${attempts} attempt${suffix}, superseded`;
  }

  return `${attempts} attempt${suffix} recorded`;
}

export function getHealingSessionReason(
  session: Pick<HealingSession, "blockedReason" | "escalationReason" | "latestFingerprint"> | null | undefined,
): string | null {
  if (!session) {
    return null;
  }

  return session.blockedReason ?? session.escalationReason ?? session.latestFingerprint ?? null;
}

export function getLatestHealingSessionForPR(
  sessions: HealingSession[],
  prId: string,
): HealingSession | null {
  const matchingSessions = sessions.filter((session) => session.prId === prId);

  if (matchingSessions.length === 0) {
    return null;
  }

  return matchingSessions.reduce((latest, session) => {
    if (session.updatedAt > latest.updatedAt) {
      return session;
    }

    return latest;
  });
}

export function selectRelevantHealingSession(
  sessions: HealingSession[],
  prId: string,
): HealingSession | null {
  return getLatestHealingSessionForPR(sessions, prId);
}

export function getHealingSessionView(
  session: HealingSession,
  _config?: Pick<Config, "autoHealCI">,
): HealingSessionView {
  return {
    stateLabel: formatHealingSessionStateLabel(session.state),
    tone: getHealingSessionTone(session.state),
    attemptSummary: summarizeHealingAttemptProgress(session),
    reasonSummary: getHealingSessionReason(session),
    statusHint: getHealingSessionStatusHint(session.state),
    actions: getHealingSessionOperatorActions(session.state).map((action) => ({
      label: formatHealingOperatorActionLabel(action),
      available: true,
      hint: `${formatHealingOperatorActionLabel(action)} controls are planned but not wired to the backend yet.`,
    })),
  };
}
