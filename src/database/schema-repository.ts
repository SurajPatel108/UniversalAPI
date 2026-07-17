import type { DatasetSchema } from "../models/schema.js";

export interface SchemaRepository { findByCollectionRevision(collectionRevision: string): Promise<DatasetSchema | null>; save(schema: DatasetSchema): Promise<void>; }
export class InMemorySchemaRepository implements SchemaRepository {
  private readonly schemas = new Map<string, DatasetSchema>();
  async findByCollectionRevision(collectionRevision: string): Promise<DatasetSchema | null> { return this.schemas.get(collectionRevision) ?? null; }
  async save(schema: DatasetSchema): Promise<void> { this.schemas.set(schema.collectionRevision, schema); }
}
