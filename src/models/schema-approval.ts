/* Immutable approval decisions are separate from immutable Phase 3 schema proposals. */

export type SchemaApprovalStatus = "AUTO_APPROVED" | "APPROVED" | "REJECTED";

export interface SchemaApprovalDecision {
  readonly decisionId: string;
  readonly schemaId: string;
  readonly datasetId: string;
  readonly snapshotCollectionId: string;
  readonly schemaVersion: string;
  readonly status: SchemaApprovalStatus;
  readonly decidedBy: string;
  readonly deterministicGateEvidence: readonly string[];
  readonly createdAt: Date;
}
