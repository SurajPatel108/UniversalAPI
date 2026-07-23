import { randomUUID } from "node:crypto";
import { ApplicationError } from "../core/errors.js";
import type { SchemaRepository } from "../database/schema-repository.js";
import type { DatasetSchema } from "../models/schema.js";
import type { SchemaApprovalDecision } from "../models/schema-approval.js";

export interface SchemaApprovalOutcome { readonly schema: DatasetSchema | null; readonly decision: SchemaApprovalDecision | null; readonly diagnostics: readonly string[]; }

/** Deterministically validates a persisted schema proposal before creating an immutable approval decision. */
export class SchemaApprovalService {
  constructor(private readonly schemas: SchemaRepository) {}

  async autoApproveLatestForDevelopment(datasetId: string, snapshotCollectionId: string): Promise<SchemaApprovalOutcome> {
    const schema = await this.schemas.findLatestForDatasetAndCollection(datasetId, snapshotCollectionId);
    if (!schema) return { schema: null, decision: null, diagnostics: ["No schema proposal exists for the dataset and snapshot collection."] };
    const diagnostics = this.validate(schema);
    if (diagnostics.length > 0) return { schema, decision: null, diagnostics };
    const existing = await this.schemas.findApproval(schema.id);
    if (existing) return { schema, decision: existing.status === "REJECTED" ? null : existing, diagnostics: existing.status === "REJECTED" ? ["Schema proposal was previously rejected."] : ["Schema proposal passed deterministic validation."] };
    const decision: SchemaApprovalDecision = { decisionId: randomUUID(), schemaId: schema.id, datasetId: schema.datasetId, snapshotCollectionId: schema.snapshotCollectionId, schemaVersion: schema.collectionRevision, status: "AUTO_APPROVED", decidedBy: "testing-dashboard", deterministicGateEvidence: ["schema-object-valid", "fields-valid", "evidence-complete", "sample-evidence-valid"], createdAt: new Date() };
    await this.schemas.saveApproval(decision);
    return { schema, decision, diagnostics: ["Schema proposal passed deterministic validation and was auto-approved for development."] };
  }

  private validate(schema: DatasetSchema): string[] {
    const diagnostics: string[] = [];
    const propertyNames = new Set(Object.keys(schema.schema.properties));
    const fieldNames = new Set(schema.fields.map((field) => field.name));
    const evidenceReferences = new Set(schema.sampleSnapshotIds.map((snapshotId) => `snapshot:${snapshotId}`));
    if (schema.schema.type !== "object") diagnostics.push("Schema root must be an object.");
    if (schema.fields.length === 0) diagnostics.push("Schema proposal has no fields.");
    if (fieldNames.size !== schema.fields.length) diagnostics.push("Schema proposal contains duplicate field names.");
    for (const field of schema.fields) {
      if (!propertyNames.has(field.name)) diagnostics.push(`Schema field ${field.name} has no matching property.`);
      if (!field.evidence.trim()) diagnostics.push(`Schema field ${field.name} has no evidence.`);
      else if (!evidenceReferences.has(field.evidence)) diagnostics.push(`Schema field ${field.name} cites unknown evidence ${field.evidence}.`);
    }
    for (const required of schema.schema.required) if (!fieldNames.has(required)) diagnostics.push(`Required schema property ${required} has no field definition.`);
    for (const sampleId of schema.sampleSnapshotIds) if (!sampleId.trim()) diagnostics.push("Schema proposal contains an empty sample snapshot reference.");
    return diagnostics;
  }
}
