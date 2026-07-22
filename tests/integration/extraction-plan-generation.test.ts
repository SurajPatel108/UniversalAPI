import { describe, expect, it } from "vitest";
import type { AIProvider, StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";
import { InMemoryDiscoveryRepository } from "../../src/database/discovery-repository.js";
import { InMemoryExtractionRepository } from "../../src/database/extraction-repository.js";
import { InMemorySchemaRepository } from "../../src/database/schema-repository.js";
import { ExtractionPlanGenerationService } from "../../src/services/extraction-plan-generation-service.js";

class IntegrationFakeProvider implements AIProvider {
  readonly name = "integration-fake";
  readonly model = "integration-fake-model";
  calls = 0;
  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    this.calls += 1;
    expect(request.operation).toBe("extraction_plan");
    return { pageTypes: [{ pageType: "path:root", classificationEvidence: ["snapshot:snapshot-1"], recordSelector: ".record", fields: [{ field: "name", selector: ".name", source: "text", transforms: ["trim"], required: true, evidenceReference: "snapshot:snapshot-1" }] }], pagination: { strategy: "none", evidenceReference: "snapshot:snapshot-1" }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["name"] }, missingFieldPolicy: "reject_record", examples: [{ snapshotId: "snapshot-1", recordIndex: 0, evidenceReference: "snapshot:snapshot-1" }], confidence: 1 };
  }
}

describe("extraction-plan generation integration", () => {
  it("creates a cached immutable plan only from an approved schema and captured collection", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    const schemas = new InMemorySchemaRepository();
    const extractions = new InMemoryExtractionRepository();
    const provider = new IntegrationFakeProvider();
    await discoveries.saveSnapshotCollection({ id: "collection-1", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "crawl-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/", outcome: "captured", content: "<article class=record><span class=name>One</span></article>", snapshot: { id: "snapshot-1", sourceId: "source-1", contentType: "text/html", fingerprint: "snapshot-fingerprint", capturedAt: new Date() } }] });
    await schemas.save({ id: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "schema-v1", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, fields: [{ name: "name", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-1" }], rationale: "fixture", sampleSnapshotIds: ["snapshot-1"], provenance: { model: "integration-fake-model", promptVersion: "dataset-schema-v1", confidence: 1 }, createdAt: new Date() });
    await schemas.saveApproval({ decisionId: "approval-1", schemaId: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", schemaVersion: "schema-v1", status: "APPROVED", decidedBy: "integration-test", deterministicGateEvidence: ["schema-valid"], createdAt: new Date() });

    const service = new ExtractionPlanGenerationService(discoveries, schemas, extractions, provider);
    const plan = await service.generate("schema-1");
    expect(plan.datasetId).toBe("dataset-1");
    expect(plan.executionPolicy.allowHtmlExtraction).toBe(false);
    expect(plan.contentFingerprint).toHaveLength(64);
    expect(provider.calls).toBe(1);
    expect(await service.generate("schema-1")).toBe(plan);
    expect(provider.calls).toBe(1);
  });
});
