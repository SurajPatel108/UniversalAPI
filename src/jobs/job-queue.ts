/*
Purpose: hide queue-vendor semantics behind an application port.
Responsibilities: enqueue refresh commands with deduplication and expose future scheduling hooks.
Connections: services use it; BullMQ, Temporal, or another adapter implements it.
Future: delayed schedules, cancellation, dead-letter inspection, and queue health reporting.
Best practice: queue payloads must be versioned, small, serializable, and safe to retry.
*/

import type { RefreshSourceJob } from "./refresh-source-job.js";
export interface JobQueue { enqueueRefresh(job: RefreshSourceJob): Promise<void>; }

