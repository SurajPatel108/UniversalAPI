import { describe, expect, it } from "vitest";
import { InMemoryExtractionRepository } from "../../src/database/extraction-repository.js";
import { InMemorySchemaRepository } from "../../src/database/schema-repository.js";
import type { EvaluationReport, ExtractionPlan, ExtractionResult } from "../../src/models/extraction.js";
import type { DatasetSchema } from "../../src/models/schema.js";
import type { SchemaApprovalDecision } from "../../src/models/schema-approval.js";

const metrics = {
  pagesProcessed: 1, pagesSucceeded: 1, pagesFailed: 0, recordsExtracted: 1, recordsRejected: 0,
  fieldsExtracted: 1, missingRequiredFields: 0, duplicatesRemoved: 0, selectorFailures: 0,
  normalizationFailures: 0, executionDurationMs: 1, snapshotCoveragePercent: 100, pageCoveragePercent: 100, requiredFieldCompletenessPercent: 100, duplicatePercent: 0, schemaInvalidRecords: 0
};

function plan(overrides: Partial<ExtractionPlan> = {}): ExtractionPlan {
  return {
    planId: "plan-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", schemaId: "schema-1", schemaVersion: "schema-revision-1", revision: 1,
    contentFingerprint: "content-fingerprint", generationCacheKey: "generation-cache-key",
    pageTypes: [{ pageType: "listing", classificationEvidence: ["snapshot-1"], recordSelector: ".record", fields: [{ ruleId: "rule-1", field: "name", selector: ".name", source: "text", transforms: ["trim"], required: true, evidenceReference: "snapshot-1" }], nested: [] }],
    pagination: { strategy: "none", evidenceReference: "snapshot-1" }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["name"] }, missingFieldPolicy: "reject_record",
    executionPolicy: { allowHtmlExtraction: false, allowMissingFields: false, allowDuplicateRecords: false, allowPartialCollections: false, allowedNormalizers: ["unicode", "whitespace", "type", "enum", "url", "date", "number", "currency", "null_default"], allowedTransforms: ["unicode_normalize", "trim", "collapse_whitespace", "to_string", "to_number", "to_boolean", "to_date", "to_currency", "canonical_url", "enum_normalize"], maximumExtractionErrors: 0, maximumNestedDepth: 2, maximumCollectionSize: 1000 },
    examples: [{ snapshotId: "snapshot-1", recordIndex: 0, evidenceReference: "snapshot-1" }],
    provenance: { provider: "fake", model: "fake-model", promptVersion: "extraction-plan-v1", preprocessingVersion: "preprocessing-v1", samplingVersion: "sampling-v1", confidence: 0.9 }, createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

function result(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return { resultId: "result-1", planId: "plan-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", schemaVersion: "schema-revision-1", planRevision: 1, replayFingerprint: "result-replay-fingerprint", records: [], diagnostics: [], metrics, createdAt: new Date("2026-01-01T00:00:01.000Z"), ...overrides } as ExtractionResult;
}

describe("Phase 4 immutable artifact repositories", () => {
  it("persists plans by deterministic generation cache key and rejects in-place replacement", async () => {
    const repository = new InMemoryExtractionRepository();
    const artifact = plan();
    await repository.savePlan(artifact);

    expect(await repository.findPlan(artifact.planId)).toBe(artifact);
    expect(await repository.findPlanByGenerationCacheKey(artifact.generationCacheKey)).toBe(artifact);
    await expect(repository.savePlan(artifact)).rejects.toThrow("immutable");
    await expect(repository.savePlan(plan({ planId: "plan-2" }))).rejects.toThrow("cache key");
  });

  it("persists extraction results and evaluation reports as separate immutable artifacts", async () => {
    const repository = new InMemoryExtractionRepository();
    const extracted = result();
    const evaluation: EvaluationReport = { evaluationId: "evaluation-1", resultId: extracted.resultId, planId: extracted.planId, datasetId: extracted.datasetId, snapshotCollectionId: extracted.snapshotCollectionId, schemaVersion: extracted.schemaVersion, planRevision: extracted.planRevision, replayFingerprint: "evaluation-replay-fingerprint", outcome: "PASS", metrics, reasons: [], diagnostics: [], evaluatedAt: new Date("2026-01-01T00:00:02.000Z") };
    await repository.saveResult(extracted);
    await repository.saveEvaluation(evaluation);

    expect(await repository.findResult(extracted.resultId)).toBe(extracted);
    expect(await repository.findEvaluation(evaluation.evaluationId)).toBe(evaluation);
    await expect(repository.saveResult(extracted)).rejects.toThrow("immutable");
    await expect(repository.saveEvaluation(evaluation)).rejects.toThrow("immutable");
  });

  it("keeps schema proposals and approval decisions immutable and separate", async () => {
    const repository = new InMemorySchemaRepository();
    const schema: DatasetSchema = { id: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "schema-revision-1", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, fields: [{ name: "name", type: "string", required: true, confidence: 1, evidence: "snapshot-1" }], rationale: "fixture", sampleSnapshotIds: ["snapshot-1"], provenance: { model: "fake-model", promptVersion: "dataset-schema-v1", confidence: 1 }, createdAt: new Date("2026-01-01T00:00:00.000Z") };
    const approval: SchemaApprovalDecision = { decisionId: "approval-1", schemaId: schema.id, datasetId: schema.datasetId, snapshotCollectionId: schema.snapshotCollectionId, schemaVersion: schema.collectionRevision, status: "AUTO_APPROVED", decidedBy: "testing-dashboard", deterministicGateEvidence: ["schema-valid"], createdAt: new Date("2026-01-01T00:00:01.000Z") };
    await repository.save(schema);
    await repository.saveApproval(approval);

    expect(await repository.findById(schema.id)).toBe(schema);
    expect(await repository.findLatestForDatasetAndCollection(schema.datasetId, schema.snapshotCollectionId)).toBe(schema);
    expect(await repository.findApproval(schema.id)).toBe(approval);
    await expect(repository.save(schema)).rejects.toThrow("immutable");
    await expect(repository.saveApproval(approval)).rejects.toThrow("immutable");
  });
});
