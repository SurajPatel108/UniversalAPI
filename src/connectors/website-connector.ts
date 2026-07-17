import { ApplicationError } from "../core/errors.js";
import type { CrawlPlan } from "../models/crawl.js";
import type { DiscoveryLimits, DiscoveryResult } from "../models/discovery.js";
import type { Source } from "../models/source.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";
import { WebsiteCrawler } from "../crawlers/website-crawler.js";
import type { CapturedSource, DatasetDiscoveryConnector } from "./connector.js";

/** Website-specific adapter. It owns deterministic safety/crawling; it has no AI dependency. */
export class WebsiteConnector implements DatasetDiscoveryConnector {
  readonly sourceType = "website" as const;
  readonly capabilities = { supportsIncrementalSync: false, supportsStructuredMetadata: true, requiresCredentialReference: false, supportsBoundedDiscovery: true };
  constructor(private readonly crawler: WebsiteCrawler) {}
  async validate(source: Source): Promise<void> { if (source.sourceType !== "website") throw new ApplicationError("invalid_source", "WebsiteConnector only supports website sources"); const url = new URL(source.url); if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApplicationError("invalid_url", "Website sources must use HTTP or HTTPS"); }
  async discover(source: Source, limits: DiscoveryLimits): Promise<DiscoveryResult> { await this.validate(source); return this.crawler.discover(source, limits); }
  async capturePlan(source: Source, plan: CrawlPlan): Promise<SnapshotCollection> { await this.validate(source); return this.crawler.capturePlan(source, plan); }
  async capture(source: Source): Promise<CapturedSource> {
    const result = await this.discover(source, { maxPages: 1, maxDepth: 0, maxBytesPerPage: 1_000_000, timeoutMs: 10_000, maxRedirects: 5, allowedOrigins: [] });
    const first = result.pages.find((page) => page.disposition === "captured");
    if (!first) throw new ApplicationError("capture_failed", "Unable to capture source");
    const collection = await this.capturePlan(source, { id: "compatibility-capture", datasetId: "compatibility-capture", revision: 1, urls: [first.canonicalUrl], limits: result.limits, createdAt: new Date() });
    const entry = collection.entries[0];
    if (!entry?.snapshot) throw new ApplicationError("capture_failed", entry?.error ?? "Unable to capture source");
    return { snapshot: entry.snapshot, content: entry.content ?? "" };
  }
}
