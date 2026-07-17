/*
Purpose: verify the SourceService domain behavior with deterministic fakes.
Responsibilities: exercise creation, validation, persistence, and queueing without an HTTP framework.
Connections: these tests protect the core application service contract before the API layer is wired.
Future: add duplicate and authorization scenarios as the domain grows.
Best practice: keep the test doubles small and assert on public outcomes rather than internals.
*/

import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../../src/jobs/job-queue.js";
import { InMemorySourceRepository } from "../../src/database/source-repository.js";
import { SourceService } from "../../src/services/source-service.js";

describe("SourceService", () => {
  it("creates a source, persists it, and enqueues a refresh job", async () => {
    const repository = new InMemorySourceRepository();
    const queue = new InMemoryJobQueue();
    const service = new SourceService(repository, queue);

    const source = await service.createSource({ sourceType: "website", url: "https://example.com/products" });

    expect(source.id).toBeTruthy();
    expect(source.publicSlug).toContain("example");
    expect(source.status).toBe("draft");
    expect(await repository.findById(source.id)).toEqual(source);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.sourceId).toBe(source.id);
  });

  it("rejects invalid URLs", async () => {
    const repository = new InMemorySourceRepository();
    const queue = new InMemoryJobQueue();
    const service = new SourceService(repository, queue);

    await expect(service.createSource({ sourceType: "website", url: "not-a-url" })).rejects.toThrow("Invalid URL");
    expect(queue.enqueued).toHaveLength(0);
  });
});
