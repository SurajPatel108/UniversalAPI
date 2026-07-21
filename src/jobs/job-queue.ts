/*
Purpose: hide queue-vendor semantics behind an application port.
Responsibilities: enqueue refresh commands with deduplication and expose future scheduling hooks.
Connections: services use it; BullMQ, Temporal, or another adapter implements it.
Future: delayed schedules, cancellation, dead-letter inspection, and queue health reporting.
Best practice: queue payloads must be versioned, small, serializable, and safe to retry.
*/

import type { RefreshSourceJob } from "./refresh-source-job.js";

export interface JobQueue {
  enqueueRefresh(job: RefreshSourceJob): Promise<void>;
}

export class InMemoryJobQueue implements JobQueue {
  readonly enqueued: RefreshSourceJob[] = [];
  readonly failed: Array<{ job: RefreshSourceJob; error: unknown }> = [];
  private refreshHandler: ((job: RefreshSourceJob) => Promise<void>) | null = null;

  subscribeRefresh(handler: (job: RefreshSourceJob) => Promise<void>): void { this.refreshHandler = handler; }

  async enqueueRefresh(job: RefreshSourceJob): Promise<void> {
    this.enqueued.push(job);
    if (this.refreshHandler) {
      queueMicrotask(() => {
        void this.refreshHandler?.(job).catch((error: unknown) => this.failed.push({ job, error }));
      });
    }
  }
}
