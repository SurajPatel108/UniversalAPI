import { describe, expect, it } from "vitest";
import type { DatasetSchema } from "../../src/models/schema.js";
import type { EvaluationReport, ExtractionPlan, ExtractionResult } from "../../src/models/extraction.js";
import type { SchemaApprovalDecision } from "../../src/models/schema-approval.js";
import { DevelopmentPhase4WorkflowService } from "../../src/services/development-phase4-workflow-service.js";

const schema = { id: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "schema-v1" } as DatasetSchema;
const decision: SchemaApprovalDecision = { decisionId: "approval-1", schemaId: schema.id, datasetId: schema.datasetId, snapshotCollectionId: schema.snapshotCollectionId, schemaVersion: schema.collectionRevision, status: "AUTO_APPROVED", decidedBy: "testing-dashboard", deterministicGateEvidence: ["valid"], createdAt: new Date() };
const plan = { planId: "plan-1" } as ExtractionPlan;
const result = { resultId: "result-1", diagnostics: [], metrics: {} } as unknown as ExtractionResult;
const evaluation = { outcome: "PASS" } as EvaluationReport;

describe("DevelopmentPhase4WorkflowService", () => {
  it("stops cleanly when deterministic schema validation does not approve", async () => {
    const workflow = new DevelopmentPhase4WorkflowService({ async autoApproveLatestForDevelopment() { return { schema, decision: null, diagnostics: ["Schema has no fields."] }; } }, { async generate() { throw new Error("must not run"); } }, { async execute() { throw new Error("must not run"); } });
    const outcome = await workflow.run(schema.datasetId, schema.snapshotCollectionId);
    expect(outcome.plan).toBeNull();
    expect(outcome.error).toContain("approval");
  });

  it("retains the approved decision when plan generation fails and skips execution", async () => {
    const workflow = new DevelopmentPhase4WorkflowService({ async autoApproveLatestForDevelopment() { return { schema, decision, diagnostics: ["approved"] }; } }, { async generate() { throw new Error("provider unavailable"); } }, { async execute() { throw new Error("must not run"); } });
    const outcome = await workflow.run(schema.datasetId, schema.snapshotCollectionId);
    expect(outcome.schemaApproval).toBe(decision);
    expect(outcome.plan).toBeNull();
    expect(outcome.error).toContain("provider unavailable");
  });

  it("retains the generated plan when execution fails and returns no fabricated records", async () => {
    const workflow = new DevelopmentPhase4WorkflowService({ async autoApproveLatestForDevelopment() { return { schema, decision, diagnostics: ["approved"] }; } }, { async generate() { return plan; } }, { async execute() { throw new Error("parser failure"); } });
    const outcome = await workflow.run(schema.datasetId, schema.snapshotCollectionId);
    expect(outcome.plan).toBe(plan);
    expect(outcome.result).toBeNull();
    expect(outcome.evaluation).toBeNull();
    expect(outcome.error).toContain("parser failure");
  });

  it.each(["PASS", "REVIEW", "FAIL"] as const)("preserves %s evaluations from deterministic execution", async (status) => {
    const workflow = new DevelopmentPhase4WorkflowService({ async autoApproveLatestForDevelopment() { return { schema, decision, diagnostics: ["approved"] }; } }, { async generate() { return plan; } }, { async execute() { return { result, evaluation: { ...evaluation, outcome: status } as EvaluationReport }; } });
    expect((await workflow.run(schema.datasetId, schema.snapshotCollectionId)).evaluation?.outcome).toBe(status);
  });
});
