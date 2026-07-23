import { describe, expect, it } from "vitest";
import type { DatasetSchema } from "../../src/models/schema.js";
import type { ExtractionPlan, ExtractionResult } from "../../src/models/extraction.js";
import { ExtractionEngine } from "../../src/services/extraction-engine.js";
import { EvaluationService } from "../../src/services/evaluation-service.js";
import { NormalizationService } from "../../src/services/normalization-service.js";

const schema: DatasetSchema = { id: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "schema-v1", schema: { type: "object", properties: { name: { type: "string" }, price: { type: "number" } }, required: ["name", "price"] }, fields: [{ name: "name", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-1" }, { name: "price", type: "number", required: true, confidence: 1, evidence: "snapshot:snapshot-1" }], rationale: "fixture", sampleSnapshotIds: ["snapshot-1"], provenance: { model: "fake", promptVersion: "v1", confidence: 1 }, createdAt: new Date("2026-01-01T00:00:00.000Z") };
const plan: ExtractionPlan = { planId: "plan-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", schemaId: "schema-1", schemaVersion: "schema-v1", revision: 1, contentFingerprint: "plan-content", generationCacheKey: "cache", pageTypes: [{ pageType: "catalog", classificationEvidence: ["snapshot:snapshot-1"], recordSelector: ".record", fields: [{ ruleId: "rule-name", field: "name", selector: ".name", source: "text", transforms: ["trim"], required: true, evidenceReference: "snapshot:snapshot-1" }, { ruleId: "rule-price", field: "price", selector: ".price", source: "text", transforms: ["to_currency"], required: true, evidenceReference: "snapshot:snapshot-1" }], nested: [] }], pagination: { strategy: "none", evidenceReference: "snapshot:snapshot-1" }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["name"] }, missingFieldPolicy: "reject_record", executionPolicy: { allowHtmlExtraction: false, allowMissingFields: false, allowDuplicateRecords: false, allowPartialCollections: false, allowedNormalizers: ["unicode", "whitespace", "type", "enum", "url", "date", "number", "currency", "null_default"], allowedTransforms: ["trim", "to_currency"], maximumExtractionErrors: 0, maximumNestedDepth: 2, maximumCollectionSize: 100 }, examples: [{ snapshotId: "snapshot-1", recordIndex: 0, evidenceReference: "snapshot:snapshot-1" }], provenance: { provider: "fake", model: "fake", promptVersion: "v1", preprocessingVersion: "v1", samplingVersion: "v1", confidence: 1 }, createdAt: new Date("2026-01-01T00:00:00.000Z") };
const collection = { id: "collection-1", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "crawl-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/b", outcome: "captured" as const, content: '<article class="record"><span class="name"> Café&nbsp;One </span><span class="price">$12.50</span></article>', snapshot: { id: "snapshot-1", sourceId: "source-1", contentType: "text/html", fingerprint: "a", capturedAt: new Date() } }, { url: "https://example.test/a", outcome: "captured" as const, content: '<article class="record"><span class="name">Café One</span><span class="price">$12.50</span></article>', snapshot: { id: "snapshot-2", sourceId: "source-1", contentType: "text/html", fingerprint: "b", capturedAt: new Date() } }] };

describe("deterministic extraction primitives", () => {
  it("normalizes in a stable order without AI", () => {
    const result = new NormalizationService().normalize("  Café\u00a0One  ", plan.pageTypes[0]!.fields[0]!, { type: "string" }, "https://example.test/");
    expect(result.value).toBe("Café One");
    expect(result.actions).toEqual(["unicode", "trim", "whitespace"]);
  });

  it("orders records deterministically, retains provenance, and reports duplicate removal", () => {
    const output = new ExtractionEngine().execute(plan, collection, schema);
    expect(output.records).toHaveLength(1);
    expect(output.records[0]).toMatchObject({ sourcePageUrl: "https://example.test/a", pageType: "catalog", recordIndexWithinPage: 0, data: { name: "Café One", price: 12.5 } });
    expect(output.records[0]?.fields.name).toMatchObject({ snapshotId: "snapshot-2", selector: ".name", extractionRuleId: "rule-name", evidenceReference: "snapshot:snapshot-1" });
    expect(output.diagnostics.some((diagnostic) => diagnostic.code === "DUPLICATE_REMOVED")).toBe(true);
    expect(output.metrics.duplicatesRemoved).toBe(1);
  });

  it("extracts a field when its static selector matches the record root", () => {
    const rootRulePlan: ExtractionPlan = {
      ...plan,
      pageTypes: [{ ...plan.pageTypes[0]!, fields: [{ ...plan.pageTypes[0]!.fields[0]!, selector: ".record" }, plan.pageTypes[0]!.fields[1]! ] }]
    };
    const output = new ExtractionEngine().execute(rootRulePlan, collection, schema);
    expect(output.records[0]?.data.name).toContain("Café One");
    expect(output.records[0]?.fields.name.selector).toBe(".record");
  });

  it("does not report coverage for pages whose records all fail deterministic validation", () => {
    const invalidFieldPlan: ExtractionPlan = {
      ...plan,
      pageTypes: [{ ...plan.pageTypes[0]!, fields: [{ ...plan.pageTypes[0]!.fields[0]!, selector: ".missing" }, plan.pageTypes[0]!.fields[1]! ] }]
    };
    const output = new ExtractionEngine().execute(invalidFieldPlan, collection, schema);
    expect(output.records).toEqual([]);
    expect(output.metrics.pageCoveragePercent).toBe(0);
    expect(output.diagnostics.some((diagnostic) => diagnostic.code === "PAGE_NO_VALID_RECORDS")).toBe(true);
  });

  it("classifies deterministic quality thresholds without parsing snapshots", () => {
    const output = new ExtractionEngine().execute(plan, collection, schema);
    const result: ExtractionResult = { resultId: "result", planId: plan.planId, datasetId: plan.datasetId, snapshotCollectionId: plan.snapshotCollectionId, schemaVersion: plan.schemaVersion, planRevision: plan.revision, replayFingerprint: "replay", records: output.records, diagnostics: output.diagnostics, metrics: output.metrics, createdAt: plan.createdAt };
    const review = new EvaluationService().evaluate({ plan, schema, result, validPlan: true, validSchema: true });
    expect(review.outcome).toBe("REVIEW");
    expect(review.reasons.some((reason) => reason.code === "DUPLICATE_RATE_EXCEEDED")).toBe(true);
    expect(new EvaluationService().evaluate({ plan, schema, result: { ...result, metrics: { ...result.metrics, duplicatePercent: 0 } }, validPlan: true, validSchema: true }).outcome).toBe("PASS");
    expect(new EvaluationService().evaluate({ plan, schema, result: { ...result, records: [], metrics: { ...result.metrics, recordsExtracted: 0 } }, validPlan: true, validSchema: true }).outcome).toBe("FAIL");
  });
});
