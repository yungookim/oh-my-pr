import { randomUUID } from "crypto";
import type { BackgroundJob, BackgroundJobKind } from "@shared/schema";
import type { IStorage } from "./storage";

type QueueDateInput = Date | string;

export type BackgroundJobEnqueueOptions = {
  priority?: number;
  availableAt?: QueueDateInput;
};

export type BackgroundJobClaimParams = {
  workerId: string;
  leaseMs: number;
  now?: QueueDateInput;
  kinds?: BackgroundJobKind[];
};

export type BackgroundJobLeaseParams = {
  jobId: string;
  leaseToken: string;
  leaseMs: number;
  now?: QueueDateInput;
};

export type BackgroundJobFinalizeParams = {
  jobId: string;
  leaseToken: string;
  now?: QueueDateInput;
};

export type BackgroundJobFailParams = BackgroundJobFinalizeParams & {
  error: string;
};

export type BackgroundJobCancelParams = BackgroundJobFinalizeParams & {
  error?: string | null;
};

export type ScheduleBackgroundJob = (
  kind: BackgroundJobKind,
  targetId: string,
  dedupeKey: string,
  payload?: Record<string, unknown>,
  options?: BackgroundJobEnqueueOptions,
) => Promise<BackgroundJob>;

export class BackgroundJobQueue {
  private readonly storage: IStorage;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(
    storage: IStorage,
    options?: {
      now?: () => Date;
      randomUUID?: () => string;
    },
  ) {
    this.storage = storage;
    this.now = options?.now ?? (() => new Date());
    this.randomUUID = options?.randomUUID ?? randomUUID;
  }

  async enqueue(
    kind: BackgroundJobKind,
    targetId: string,
    dedupeKey: string,
    payload: Record<string, unknown> = {},
    options?: BackgroundJobEnqueueOptions,
  ): Promise<BackgroundJob> {
    return this.storage.enqueueBackgroundJob({
      kind,
      targetId,
      dedupeKey,
      payload,
      priority: options?.priority,
      availableAt: this.resolveNow(options?.availableAt),
    });
  }

  async claimNext(params: BackgroundJobClaimParams): Promise<BackgroundJob | undefined> {
    const now = this.resolveNow(params.now);
    return this.storage.claimNextBackgroundJob({
      workerId: params.workerId,
      leaseToken: this.randomUUID(),
      leaseExpiresAt: addMs(now, params.leaseMs),
      now,
      kinds: params.kinds,
    });
  }

  async heartbeat(params: BackgroundJobLeaseParams): Promise<BackgroundJob | undefined> {
    const now = this.resolveNow(params.now);
    return this.storage.heartbeatBackgroundJob(
      params.jobId,
      params.leaseToken,
      now,
      addMs(now, params.leaseMs),
    );
  }

  async complete(params: BackgroundJobFinalizeParams): Promise<BackgroundJob | undefined> {
    return this.storage.completeBackgroundJob(
      params.jobId,
      params.leaseToken,
      this.resolveNow(params.now),
    );
  }

  async fail(params: BackgroundJobFailParams): Promise<BackgroundJob | undefined> {
    return this.storage.failBackgroundJob(
      params.jobId,
      params.leaseToken,
      params.error,
      this.resolveNow(params.now),
    );
  }

  async cancel(params: BackgroundJobCancelParams): Promise<BackgroundJob | undefined> {
    return this.storage.cancelBackgroundJob(
      params.jobId,
      params.leaseToken,
      params.error ?? null,
      this.resolveNow(params.now),
    );
  }

  async requeueExpired(now?: QueueDateInput): Promise<number> {
    return this.storage.requeueExpiredBackgroundJobs(this.resolveNow(now));
  }

  private resolveNow(value?: QueueDateInput): string {
    return toIsoString(value ?? this.now());
  }
}

export function buildBackgroundJobDedupeKey(kind: BackgroundJobKind, targetId: string): string {
  return kind === "sync_watched_repos" ? kind : `${kind}:${targetId}`;
}

function addMs(value: QueueDateInput, ms: number): string {
  return new Date(new Date(value).getTime() + ms).toISOString();
}

function toIsoString(value: QueueDateInput): string {
  return value instanceof Date ? value.toISOString() : value;
}
