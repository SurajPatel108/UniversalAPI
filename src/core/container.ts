/*
Purpose: be the composition root for dependency injection.
Responsibilities: choose concrete database, cache, queue, crawler, and service adapters for one process.
Connections: entry points call this module; feature code receives interfaces, never resolves global dependencies.
Future: construct production and test containers with lifecycle hooks.
Best practice: keep wiring centralized; do not use service locators inside domain code.
*/

import { InMemoryJobQueue } from "../jobs/job-queue.js";
import { InMemorySourceRepository } from "../database/source-repository.js";
import { SourceService } from "../services/source-service.js";

export interface ApplicationContainer {
  readonly sourceService: SourceService;
}

export function createContainer(): ApplicationContainer {
  const repository = new InMemorySourceRepository();
  const queue = new InMemoryJobQueue();
  const sourceService = new SourceService(repository, queue);

  return { sourceService };
}

