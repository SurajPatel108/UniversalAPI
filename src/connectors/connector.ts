/*
Purpose: define the common acquisition boundary for every supported information source.
Responsibilities: declare connector identity/capabilities, validate source-specific configuration, and capture a reproducible snapshot.
Connections: SourceService selects a connector by Source.sourceType; RefreshSourceWorker uses it before AI planning and deterministic execution.
Future: website, PDF, spreadsheet, database, Notion, and internal-dashboard implementations live beside this contract.
Best practice: connectors return neutral snapshots, isolate vendor SDKs, and reference secrets through a vault rather than exposing them to AI prompts.
*/

import type { Source, SourceType } from "../models/source.js";
import type { SourceSnapshot } from "../models/snapshot.js";
import type { CrawlPlan } from "../models/crawl.js";
import type { DiscoveryLimits, DiscoveryResult } from "../models/discovery.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";
import type { CapturedPageArtifacts } from "../models/captured-page-artifacts.js";

export interface ConnectorCapabilities {
  readonly supportsIncrementalSync: boolean;
  readonly supportsStructuredMetadata: boolean;
  readonly requiresCredentialReference: boolean;
  readonly supportsBoundedDiscovery?: boolean;
}

export interface CapturedSource {
  readonly snapshot: SourceSnapshot;
  readonly content: string | Uint8Array;
  readonly artifacts?: CapturedPageArtifacts;
}


export interface Connector {
  readonly sourceType: SourceType;
  readonly capabilities: ConnectorCapabilities;
  validate(source: Source): Promise<void>;
  capture(source: Source): Promise<CapturedSource>;
}

/** Phase 2 extension: source exploration and collection capture remain connector-owned and deterministic. */
export interface DatasetDiscoveryConnector extends Connector {
  discover(source: Source, limits: DiscoveryLimits): Promise<DiscoveryResult>;
  capturePlan(source: Source, plan: CrawlPlan): Promise<SnapshotCollection>;
}
