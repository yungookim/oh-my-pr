import type { DeploymentHealingSession, DeploymentHealingState, DeploymentPlatform } from "@shared/schema";
import type { IStorage } from "./storage";

export type DeploymentHealingSessionInput = {
  repo: string;
  platform: DeploymentPlatform;
  triggerPrNumber: number;
  triggerPrTitle: string;
  triggerPrUrl: string;
  mergeSha: string;
};

const TERMINAL_STATES: ReadonlyArray<DeploymentHealingState> = ["fix_submitted", "escalated"];

const NEXT_STATES: Record<DeploymentHealingState, ReadonlyArray<DeploymentHealingState>> = {
  monitoring: ["failed", "escalated"],
  failed: ["fixing", "escalated"],
  fixing: ["fix_submitted", "escalated"],
  fix_submitted: [],
  escalated: [],
};

export class DeploymentHealingManager {
  constructor(
    private readonly storage: IStorage,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createSession(input: DeploymentHealingSessionInput): Promise<DeploymentHealingSession> {
    return this.storage.createDeploymentHealingSession({
      ...input, deploymentId: null, deploymentLog: null, fixBranch: null,
      fixPrNumber: null, fixPrUrl: null, state: "monitoring", error: null, completedAt: null,
    });
  }

  async ensureSession(input: DeploymentHealingSessionInput): Promise<DeploymentHealingSession> {
    const existing = await this.storage.getDeploymentHealingSessionByRepoAndMergeSha(input.repo, input.mergeSha);
    if (existing) return existing;
    return this.createSession(input);
  }

  async transitionTo(
    sessionId: string, nextState: DeploymentHealingState,
    updates: Partial<DeploymentHealingSession> = {},
  ): Promise<DeploymentHealingSession> {
    const session = await this.storage.getDeploymentHealingSession(sessionId);
    if (!session) throw new Error(`Deployment healing session not found: ${sessionId}`);
    if (session.state === nextState) {
      const updated = await this.storage.updateDeploymentHealingSession(sessionId, updates);
      if (!updated) throw new Error(`Deployment healing session not found: ${sessionId}`);
      return updated;
    }
    if (!NEXT_STATES[session.state].includes(nextState)) {
      throw new Error(`Illegal deployment healing transition: ${session.state} -> ${nextState}`);
    }
    const mergedUpdates: Partial<DeploymentHealingSession> = { ...updates, state: nextState };
    if (TERMINAL_STATES.includes(nextState)) {
      mergedUpdates.completedAt = updates.completedAt ?? this.clock().toISOString();
    }
    const updated = await this.storage.updateDeploymentHealingSession(sessionId, mergedUpdates);
    if (!updated) throw new Error(`Deployment healing session not found: ${sessionId}`);
    return updated;
  }
}
