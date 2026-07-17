/*
Purpose: coordinate source registration and user-requested refreshes as application use cases.
Responsibilities: validate command-level invariants, persist a Source, and enqueue asynchronous work.
Connections: routes call it; it depends on SourceRepository and JobQueue ports.
Future: tenant authorization, URL canonicalization, quotas, and idempotent create semantics.
Best practice: never crawl synchronously from a controller; return a source/job state quickly.
*/

import { ApplicationError } from "../core/errors.js";
import { generateUuid } from "../core/uuid.js";
import type { SourceRepository } from "../database/source-repository.js";
import type { JobQueue } from "../jobs/job-queue.js";
import type { RefreshSourceJob } from "../jobs/refresh-source-job.js";
import type { Source, SourceType } from "../models/source.js";

export interface CreateSourceInput {
  readonly sourceType: SourceType;
  readonly url: string;
}

export class SourceService {
  constructor(private readonly sources: SourceRepository, private readonly jobs: JobQueue) {}

  async createSource(input: CreateSourceInput): Promise<Source> {
    this.assertValidUrl(input.url);

    const source: Source = {
      id: generateUuid(),
      publicSlug: this.buildSlug(input.url),
      sourceType: input.sourceType,
      url: input.url,
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.sources.create(source);

    const job: RefreshSourceJob = {
      sourceId: source.id,
      requestedAt: new Date().toISOString(),
      idempotencyKey: `${source.id}:${source.updatedAt.toISOString()}`
    };

    await this.jobs.enqueueRefresh(job);

    return source;
  }

  async getSource(id: string): Promise<Source | null> {
    return this.sources.findById(id);
  }

  private assertValidUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith("http")) {
        throw new Error("Unsupported protocol");
      }
    } catch {
      throw new ApplicationError("invalid_url", "Invalid URL", false);
    }
  }

  private buildSlug(url: string): string {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/\./g, "-")}-${parsed.pathname.replace(/\W+/g, "-").replace(/^-|-$/g, "") || "root"}`;
  }
}

