/*
Purpose: execute the AI-first asynchronous refresh pipeline outside the HTTP request lifecycle.
Responsibilities: resolve a Connector, capture input, ask the planner for a schema/field/selector plan, deterministically execute and validate it, then publish/cache a version.
Connections: consumes RefreshSourceJob and coordinates ConnectorRegistry, AI planner/repair, parser/executor, normalizer, repositories, and cache.
Future: distributed locks, retry classification, tracing, change detection, policy-based approval, and canary evaluation.
Best practice: AI proposes plans; deterministic execution, validation, audit, and rollback protect the production API contract.
*/

import type { RefreshSourceJob } from "../jobs/refresh-source-job.js";
import { defaultDiscoveryLimits } from "../models/discovery.js";
import type { DiscoveryPreview } from "../models/discovery.js";
import type { DiscoveryService } from "../services/discovery-service.js";

/** Phase 2 worker: create deterministic discovery evidence only. Approval and later pipeline phases remain user-driven. */
export class RefreshSourceWorker {
  constructor(private readonly discovery: DiscoveryService) {}
  async process(job: RefreshSourceJob): Promise<DiscoveryPreview> { return this.discovery.discover(job.sourceId, defaultDiscoveryLimits); }
}
