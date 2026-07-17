import type { AiProvenance } from "../ai/ai-types.js";

export interface DatasetSchemaField { readonly name: string; readonly type: string; readonly required: boolean; readonly confidence: number; readonly evidence: string; }
export interface DatasetSchema {
  readonly id: string;
  readonly datasetId: string;
  readonly snapshotCollectionId: string;
  readonly collectionRevision: string;
  readonly schema: { readonly type: "object"; readonly properties: Record<string, unknown>; readonly required: readonly string[] };
  readonly fields: readonly DatasetSchemaField[];
  readonly rationale: string;
  readonly sampleSnapshotIds: readonly string[];
  readonly provenance: AiProvenance;
  readonly createdAt: Date;
}
