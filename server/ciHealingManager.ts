import type {
  HealingSession,
  HealingSessionState,
} from "@shared/schema";
import type { IStorage } from "./storage";

export type CIHealingSessionInput = {
  prId: string;
  repo: string;
  prNumber: number;
  headSha: string;
};

export type RetryBudget = {
  session: HealingSession;
  sessionAttempts: number;
  fingerprintAttempts: number;
  maxSessionAttempts: number;
  maxFingerprintAttempts: number;
  cooldownRemainingMs: number;
  canRetry: boolean;
  reason: string | null;
};

const TERMINAL_STATES: ReadonlyArray<HealingSessionState> = [
  "healed",
  "blocked",
  "escalated",
  "superseded",
];

const NEXT_STATES: Record<HealingSessionState, ReadonlyArray<HealingSessionState>> = {
  idle: ["triaging"],
  triaging: ["awaiting_repair_slot", "cooldown", "blocked", "escalated", "superseded"],
  awaiting_repair_slot: ["repairing", "cooldown", "blocked", "escalated", "superseded"],
  repairing: ["awaiting_ci", "cooldown", "blocked", "escalated", "superseded"],
  awaiting_ci: ["verifying", "cooldown", "blocked", "escalated", "superseded", "healed"],
  verifying: ["healed", "awaiting_repair_slot", "cooldown", "blocked", "escalated", "superseded"],
  cooldown: ["awaiting_repair_slot", "blocked", "escalated", "superseded"],
  healed: [],
  blocked: [],
  escalated: [],
  superseded: [],
};

function nowIso(now: Date): string {
  return now.toISOString();
}

function isTerminalState(state: HealingSessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

function normalizeStateTransition(
  currentState: HealingSessionState,
  nextState: HealingSessionState,
): boolean {
  if (currentState === nextState) {
    return true;
  }

  return NEXT_STATES[currentState].includes(nextState);
}

export class CIHealingManager {
  constructor(
    private readonly storage: IStorage,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): Date {
    return this.clock();
  }

  private async getConfig() {
    return this.storage.getConfig();
  }

  async getSessionByPrAndHead(prId: string, headSha: string): Promise<HealingSession | undefined> {
    return this.storage.getHealingSessionByPrAndHead(prId, headSha);
  }

  async getActiveSessionsForPr(prId: string): Promise<HealingSession[]> {
    const sessions = await this.storage.listHealingSessions({ prId });
    return sessions.filter((session) => !isTerminalState(session.state));
  }

  async ensureSessionForHead(input: CIHealingSessionInput): Promise<HealingSession> {
    const { prId, repo, prNumber, headSha } = input;
    const existing = await this.getSessionByPrAndHead(prId, headSha);
    if (existing) {
      return existing;
    }

    const activeSessions = await this.getActiveSessionsForPr(prId);
    const supersededReason = `PR head moved to ${headSha}`;

    for (const session of activeSessions) {
      if (session.initialHeadSha === headSha) {
        continue;
      }

      await this.storage.updateHealingSession(session.id, {
        state: "superseded",
        endedAt: nowIso(this.now()),
        escalationReason: supersededReason,
      });
    }

    return this.storage.createHealingSession({
      prId,
      repo,
      prNumber,
      initialHeadSha: headSha,
      currentHeadSha: headSha,
      state: "triaging",
      endedAt: null,
      blockedReason: null,
      escalationReason: null,
      latestFingerprint: null,
      attemptCount: 0,
      lastImprovementScore: null,
    });
  }

  async transitionSession(
    sessionId: string,
    nextState: HealingSessionState,
    updates: Partial<HealingSession> = {},
  ): Promise<HealingSession> {
    const session = await this.storage.getHealingSession(sessionId);
    if (!session) {
      throw new Error(`Healing session not found: ${sessionId}`);
    }

    if (!normalizeStateTransition(session.state, nextState)) {
      throw new Error(`Illegal healing session transition: ${session.state} -> ${nextState}`);
    }

    if (session.state === nextState) {
      const updated = await this.storage.updateHealingSession(sessionId, updates);
      if (!updated) {
        throw new Error(`Healing session not found: ${sessionId}`);
      }
      return updated;
    }

    const mergedUpdates: Partial<HealingSession> = {
      ...updates,
      state: nextState,
    };

    if (nextState === "repairing") {
      mergedUpdates.attemptCount = session.attemptCount + 1;
    }

    if (isTerminalState(nextState)) {
      mergedUpdates.endedAt = updates.endedAt ?? nowIso(this.now());
    }

    const updated = await this.storage.updateHealingSession(sessionId, mergedUpdates);
    if (!updated) {
      throw new Error(`Healing session not found: ${sessionId}`);
    }
    return updated;
  }

  async markTriaging(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "triaging", updates);
  }

  async markAwaitingRepairSlot(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "awaiting_repair_slot", updates);
  }

  async markRepairing(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "repairing", updates);
  }

  async markAwaitingCi(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "awaiting_ci", updates);
  }

  async markVerifying(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "verifying", updates);
  }

  async markCooldown(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "cooldown", updates);
  }

  async markHealed(sessionId: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "healed", updates);
  }

  async markBlocked(sessionId: string, reason: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "blocked", {
      ...updates,
      blockedReason: reason,
      escalationReason: null,
    });
  }

  async markEscalated(sessionId: string, reason: string, updates: Partial<HealingSession> = {}): Promise<HealingSession> {
    return this.transitionSession(sessionId, "escalated", {
      ...updates,
      escalationReason: reason,
      blockedReason: null,
    });
  }

  async supersedeSessionsForPr(prId: string, headSha: string, reason?: string): Promise<HealingSession[]> {
    const sessions = await this.getActiveSessionsForPr(prId);
    const supersededAt = nowIso(this.now());
    const supersededSessions: HealingSession[] = [];

    for (const session of sessions) {
      if (session.initialHeadSha === headSha) {
        continue;
      }

      const updated = await this.storage.updateHealingSession(session.id, {
        state: "superseded",
        endedAt: supersededAt,
        escalationReason: reason ?? `PR head moved to ${headSha}`,
      });
      if (updated) {
        supersededSessions.push(updated);
      }
    }

    return supersededSessions;
  }

  async canRetry(sessionId: string, fingerprint?: string): Promise<RetryBudget> {
    const config = await this.getConfig();
    const session = await this.storage.getHealingSession(sessionId);
    if (!session) {
      throw new Error(`Healing session not found: ${sessionId}`);
    }

    const attempts = await this.storage.listHealingAttempts({ sessionId });
    const fingerprintAttempts = fingerprint
      ? attempts.filter((attempt) => attempt.targetFingerprints.includes(fingerprint)).length
      : 0;

    const cooldownRemainingMs = this.getCooldownRemainingMs(session, config.healingCooldownMs);
    let reason: string | null = null;
    let canRetry = true;

    if (isTerminalState(session.state)) {
      canRetry = false;
      reason = `session is ${session.state}`;
    } else if (session.state === "cooldown" && cooldownRemainingMs > 0) {
      canRetry = false;
      reason = `cooldown active for ${cooldownRemainingMs}ms`;
    } else if (session.attemptCount >= config.maxHealingAttemptsPerSession) {
      canRetry = false;
      reason = "session retry budget exhausted";
    } else if (fingerprint && fingerprintAttempts >= config.maxHealingAttemptsPerFingerprint) {
      canRetry = false;
      reason = `retry budget exhausted for fingerprint ${fingerprint}`;
    } else if (session.state === "idle" || session.state === "triaging") {
      canRetry = false;
      reason = `session is ${session.state}`;
    }

    return {
      session,
      sessionAttempts: session.attemptCount,
      fingerprintAttempts,
      maxSessionAttempts: config.maxHealingAttemptsPerSession,
      maxFingerprintAttempts: config.maxHealingAttemptsPerFingerprint,
      cooldownRemainingMs,
      canRetry,
      reason,
    };
  }

  async resumeRetry(sessionId: string, fingerprint?: string): Promise<HealingSession> {
    const budget = await this.canRetry(sessionId, fingerprint);
    if (!budget.canRetry) {
      throw new Error(budget.reason ?? "retry not allowed");
    }

    if (budget.session.state !== "cooldown") {
      return budget.session;
    }

    return this.markAwaitingRepairSlot(sessionId);
  }

  private getCooldownRemainingMs(session: HealingSession, cooldownMs: number): number {
    if (session.state !== "cooldown") {
      return 0;
    }

    const elapsed = this.now().getTime() - new Date(session.updatedAt).getTime();
    return Math.max(0, cooldownMs - elapsed);
  }
}
