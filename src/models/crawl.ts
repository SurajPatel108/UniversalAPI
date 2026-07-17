import type { DiscoveryLimits } from "./discovery.js";

export interface CrawlPlan {
  readonly id: string;
  readonly datasetId: string;
  readonly revision: number;
  readonly urls: readonly string[];
  readonly limits: DiscoveryLimits;
  readonly createdAt: Date;
}
