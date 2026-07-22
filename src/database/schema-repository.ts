import type { DatasetSchema } from "../models/schema.js";
import type { SchemaApprovalDecision } from "../models/schema-approval.js";

export interface SchemaRepository {
  findByCollectionRevision(collectionRevision: string): Promise<DatasetSchema | null>;
  findById(schemaId: string): Promise<DatasetSchema | null>;
  findLatestForDatasetAndCollection(datasetId: string, snapshotCollectionId: string): Promise<DatasetSchema | null>;
  save(schema: DatasetSchema): Promise<void>;
  findApproval(schemaId: string): Promise<SchemaApprovalDecision | null>;
  saveApproval(decision: SchemaApprovalDecision): Promise<void>;
}
export class InMemorySchemaRepository implements SchemaRepository {
  private readonly schemas = new Map<string, DatasetSchema>();
  private readonly schemasById = new Map<string, DatasetSchema>();
  private readonly approvals = new Map<string, SchemaApprovalDecision>();
  async findByCollectionRevision(collectionRevision: string): Promise<DatasetSchema | null> { return this.schemas.get(collectionRevision) ?? null; }
  async findById(schemaId: string): Promise<DatasetSchema | null> { return this.schemasById.get(schemaId) ?? null; }
  async findLatestForDatasetAndCollection(datasetId: string, snapshotCollectionId: string): Promise<DatasetSchema | null> { return [...this.schemasById.values()].filter((schema) => schema.datasetId === datasetId && schema.snapshotCollectionId === snapshotCollectionId).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null; }
  async save(schema: DatasetSchema): Promise<void> { if (this.schemas.has(schema.collectionRevision) || this.schemasById.has(schema.id)) throw new Error("Dataset schema is immutable and already exists"); this.schemas.set(schema.collectionRevision, schema); this.schemasById.set(schema.id, schema); }
  async findApproval(schemaId: string): Promise<SchemaApprovalDecision | null> { return this.approvals.get(schemaId) ?? null; }
  async saveApproval(decision: SchemaApprovalDecision): Promise<void> { if (this.approvals.has(decision.schemaId) || [...this.approvals.values()].some((existing) => existing.decisionId === decision.decisionId)) throw new Error("Schema approval decision is immutable and already exists"); this.approvals.set(decision.schemaId, decision); }
}
