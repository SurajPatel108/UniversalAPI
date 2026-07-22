import { describe, expect, it } from "vitest";
import { InMemoryDiscoveryRepository } from "../../src/database/discovery-repository.js";
import { InMemoryExtractionRepository } from "../../src/database/extraction-repository.js";
import { InMemorySchemaRepository } from "../../src/database/schema-repository.js";
import type { ExtractionPlan } from "../../src/models/extraction.js";
import { ExtractionExecutionService } from "../../src/services/extraction-execution-service.js";

async function fixture(html: readonly string[], mutate?: (plan: ExtractionPlan) => ExtractionPlan) {
  const discoveries = new InMemoryDiscoveryRepository(); const schemas = new InMemorySchemaRepository(); const extractions = new InMemoryExtractionRepository();
  await discoveries.saveSnapshotCollection({ id: "collection-1", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "crawl-1", completed: true, createdAt: new Date(), entries: html.map((content, index) => ({ url: `https://example.test/${index}`, outcome: "captured" as const, content, snapshot: { id: `snapshot-${index + 1}`, sourceId: "source-1", contentType: "text/html", fingerprint: `fp-${index + 1}`, capturedAt: new Date() } })) });
  await schemas.save({ id: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "schema-v1", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, fields: [{ name: "name", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-1" }], rationale: "fixture", sampleSnapshotIds: ["snapshot-1"], provenance: { model: "fake", promptVersion: "v1", confidence: 1 }, createdAt: new Date("2026-01-01T00:00:00.000Z") });
  const base: ExtractionPlan = { planId: "plan-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", schemaId: "schema-1", schemaVersion: "schema-v1", revision: 1, contentFingerprint: "plan-content", generationCacheKey: "cache-key", pageTypes: [{ pageType: "listing", classificationEvidence: ["snapshot:snapshot-1"], recordSelector: ".record", fields: [{ ruleId: "rule-name", field: "name", selector: ".name", source: "text", transforms: ["trim"], required: true, evidenceReference: "snapshot:snapshot-1" }], nested: [] }], pagination: { strategy: "none", evidenceReference: "snapshot:snapshot-1" }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["name"] }, missingFieldPolicy: "reject_record", executionPolicy: { allowHtmlExtraction: false, allowMissingFields: false, allowDuplicateRecords: false, allowPartialCollections: false, allowedNormalizers: ["unicode", "whitespace", "type", "enum", "url", "date", "number", "currency", "null_default"], allowedTransforms: ["trim"], maximumExtractionErrors: 0, maximumNestedDepth: 2, maximumCollectionSize: 100 }, examples: [{ snapshotId: "snapshot-1", recordIndex: 0, evidenceReference: "snapshot:snapshot-1" }], provenance: { provider: "fake", model: "fake", promptVersion: "v1", preprocessingVersion: "v1", samplingVersion: "v1", confidence: 1 }, createdAt: new Date("2026-01-01T00:00:00.000Z") };
  await extractions.savePlan(mutate ? mutate(base) : base);
  return new ExtractionExecutionService(discoveries, schemas, extractions);
}

describe("deterministic extraction integration", () => {
  it("executes immutable fixtures, preserves provenance, and replays identical persisted output", async () => {
    const service = await fixture(['<article class="record"><span class="name">One</span></article>']);
    const first = await service.execute("plan-1"); const replay = await service.execute("plan-1");
    expect(first.evaluation.outcome).toBe("PASS");
    expect(first.result.records[0]?.fields.name.extractionRuleId).toBe("rule-name");
    expect(replay).toEqual(first);
  });

  it("classifies duplicates as REVIEW and missing required fields as FAIL", async () => {
    const review = await fixture(['<article class="record"><span class="name">One</span></article>', '<article class="record"><span class="name">One</span></article>']);
    expect((await review.execute("plan-1")).evaluation.outcome).toBe("REVIEW");
    const failed = await fixture(['<article class="record"><span class="other">Missing</span></article>']);
    const outcome = await failed.execute("plan-1");
    expect(outcome.evaluation.outcome).toBe("FAIL");
    expect(outcome.result.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_FIELD_MISSING")).toBe(true);
  });

  it("fails malformed persisted selectors without parsing or extracting records", async () => {
    const service = await fixture(['<article class="record"><span class="name">One</span></article>'], (plan) => ({ ...plan, planId: "plan-invalid", generationCacheKey: "cache-invalid", contentFingerprint: "invalid-content", pageTypes: [{ ...plan.pageTypes[0]!, recordSelector: "//article" }] }));
    const outcome = await service.execute("plan-invalid");
    expect(outcome.evaluation.outcome).toBe("FAIL");
    expect(outcome.result.records).toEqual([]);
    expect(outcome.result.diagnostics[0]?.code).toBe("INVALID_PLAN");
  });
});
