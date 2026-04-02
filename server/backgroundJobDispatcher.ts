import { randomUUID } from "crypto";
import type { BackgroundJob, BackgroundJobKind } from "@shared/schema";
import type { IStorage } from "./storage";
import { BackgroundJobQueue } from "./backgroundJobQueue";

export type BackgroundJobHandler = (job: BackgroundJob) => Promise<void>;

export type BackgroundJobHandlers = Partial<Record<BackgroundJobKind, BackgroundJobHandler>>;

export class CancelBackgroundJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelBackgroundJobError";
  }
}

export class BackgroundJobDispatcher {
  private readonly storage: IStorage;
  private readonly queue: BackgroundJobQueue;
  private readonly handlers: BackgroundJobHandlers;
  private readonly handledKinds: BackgroundJobKind[];
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly activeJobs = new Map<string, Promise<void>>();

  private running = false;
  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    storage: IStorage;
    queue: BackgroundJobQueue;
    handlers: BackgroundJobHandlers;
    workerId?: string;
    pollIntervalMs?: number;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => Date;
    onError?: (error: unknown) => void;
  }) {
    this.storage = params.storage;
    this.queue = params.queue;
    this.handlers = params.handlers;
    this.handledKinds = Object.keys(params.handlers) as BackgroundJobKind[];
    this.workerId = params.workerId ?? randomUUID();
    this.pollIntervalMs = params.pollIntervalMs ?? 1_000;
    this.leaseMs = params.leaseMs ?? 30_000;
    this.heartbeatIntervalMs = params.heartbeatIntervalMs ?? 10_000;
    this.now = params.now ?? (() => new Date());
    this.onError = params.onError ?? ((error) => {
      console.error("Background job dispatcher error", error);
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.queue.requeueExpired(this.now());
    this.wake();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  wake(): void {
    if (!this.running) {
      return;
    }

    this.schedulePoll(0);
  }

  getActiveRunCount(): number {
    return this.activeJobs.size;
  }

  async waitForIdle(timeoutMs = 120_000): Promise<boolean> {
    const startedAt = Date.now();

    while (this.activeJobs.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await wait(25);
    }

    return true;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) {
      return;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) {
      return;
    }

    this.polling = true;
    try {
      if (this.handledKinds.length === 0) {
        return;
      }

      const runtimeState = await this.storage.getRuntimeState();
      if (runtimeState.drainMode) {
        return;
      }

      const job = await this.queue.claimNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        now: this.now(),
        kinds: this.handledKinds,
      });

      if (!job) {
        return;
      }

      this.runJob(job);
      this.schedulePoll(0);
    } catch (error) {
      this.onError(error);
    } finally {
      this.polling = false;
      if (this.running && !this.pollTimer) {
        this.schedulePoll(this.pollIntervalMs);
      }
    }
  }

  private runJob(job: BackgroundJob): void {
    const leaseToken = job.leaseToken;
    const handler = this.handlers[job.kind];

    const jobPromise = (async () => {
      if (!leaseToken) {
        throw new Error(`Claimed background job ${job.id} is missing a lease token`);
      }

      const heartbeatTimer = this.heartbeatIntervalMs > 0
        ? setInterval(() => {
          void this.queue.heartbeat({
            jobId: job.id,
            leaseToken,
            leaseMs: this.leaseMs,
            now: this.now(),
          }).catch((error) => {
            this.onError(error);
          });
        }, this.heartbeatIntervalMs)
        : null;

      try {
        if (!handler) {
          throw new Error(`No background job handler registered for ${job.kind}`);
        }

        await handler(job);
        await this.queue.complete({
          jobId: job.id,
          leaseToken,
          now: this.now(),
        });
      } catch (error) {
        try {
          if (error instanceof CancelBackgroundJobError) {
            await this.queue.cancel({
              jobId: job.id,
              leaseToken,
              error: error.message || null,
              now: this.now(),
            });
          } else {
            await this.queue.fail({
              jobId: job.id,
              leaseToken,
              error: summarizeError(error),
              now: this.now(),
            });
          }
        } catch (finalizeError) {
          this.onError(finalizeError);
        }
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        this.activeJobs.delete(job.id);
      }
    })().catch((error) => {
      this.onError(error);
    }).finally(() => {
      if (this.running) {
        this.schedulePoll(0);
      }
    });

    this.activeJobs.set(job.id, jobPromise);
  }
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
