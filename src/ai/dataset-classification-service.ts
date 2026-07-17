import type { DatasetCandidate, DiscoveryResult } from "../models/discovery.js";

/** Provider-neutral Phase 2 boundary: implementations must return auditable proposals, never crawl instructions. */
export interface DatasetClassificationService {
  classify(result: DiscoveryResult): Promise<readonly DatasetCandidate[]>;
}
