import { describe, expect, it } from "vitest";
import { InMemorySchemaRepository } from "../../src/database/schema-repository.js";
import { SchemaApprovalService } from "../../src/services/schema-approval-service.js";

describe("SchemaApprovalService", () => {
  it("rejects schema fields whose evidence is not one of the sampled snapshots", async () => {
    const repository = new InMemorySchemaRepository();
    await repository.save({
      id: "schema-unknown-evidence", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "revision-1",
      schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      fields: [{ name: "title", type: "string", required: true, confidence: 1, evidence: "snapshot:not-sampled" }],
      rationale: "fixture", sampleSnapshotIds: ["snapshot-1"], provenance: { model: "fake", promptVersion: "fixture", confidence: 1 }, createdAt: new Date()
    });

    const outcome = await new SchemaApprovalService(repository).autoApproveLatestForDevelopment("dataset-1", "collection-1");

    expect(outcome.decision).toBeNull();
    expect(outcome.diagnostics).toEqual(expect.arrayContaining(["Schema field title cites unknown evidence snapshot:not-sampled."]));
  });
});
