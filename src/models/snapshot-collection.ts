import type { SourceSnapshot } from "./snapshot.js";

export type SnapshotOutcome = "captured" | "failed" | "skipped" | "duplicate" | "out_of_scope";

export interface SnapshotCollectionEntry {
  readonly url: string;
  readonly outcome: SnapshotOutcome;
  readonly snapshot?: SourceSnapshot;
  /** Immutable captured content; production storage adapters may replace this with an object-storage reference. */
  readonly content?: string;
  readonly error?: string;
}

export interface SnapshotCollection {
  readonly id: string;
  readonly sourceId: string;
  readonly datasetId: string;
  readonly crawlPlanId: string;
  readonly entries: readonly SnapshotCollectionEntry[];
  readonly completed: boolean;
  readonly createdAt: Date;
}
