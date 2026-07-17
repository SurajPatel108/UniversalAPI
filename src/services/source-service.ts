/*
Purpose: coordinate source registration and user-requested refreshes as application use cases.
Responsibilities: validate command-level invariants, persist a Source, and enqueue asynchronous work.
Connections: routes call it; it depends on SourceRepository and JobQueue ports.
Future: tenant authorization, URL canonicalization, quotas, and idempotent create semantics.
Best practice: never crawl synchronously from a controller; return a source/job state quickly.
*/

import type { JobQueue } from "../jobs/job-queue.js";
import type { SourceRepository } from "../database/source-repository.js";
export class SourceService { constructor(private readonly sources: SourceRepository, private readonly jobs: JobQueue) {} }

