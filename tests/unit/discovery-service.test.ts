import { describe, expect, it } from "vitest";
import type { DatasetClassificationService } from "../../src/ai/dataset-classification-service.js";
import { WebsiteCrawler, type WebsiteHttpClient } from "../../src/crawlers/website-crawler.js";
import { InMemoryDiscoveryRepository } from "../../src/database/discovery-repository.js";
import { InMemorySourceRepository } from "../../src/database/source-repository.js";
import type { DatasetCandidate, DiscoveryResult } from "../../src/models/discovery.js";
import type { Source } from "../../src/models/source.js";
import { DiscoveryService } from "../../src/services/discovery-service.js";

const source: Source = { id: "source-1", publicSlug: "example", sourceType: "website", url: "https://example.test/", status: "draft", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") };

class FakeClient implements WebsiteHttpClient { async get(url: string): Promise<{ finalUrl: string; contentType: string; body: string }> { return { finalUrl: url, contentType: "text/html", body: url.endsWith("/") ? '<a href="/items">Items</a>' : "items" }; } }
class FakeClassifier implements DatasetClassificationService {
  async classify(result: DiscoveryResult): Promise<readonly DatasetCandidate[]> {
    return [{ id: "candidate-1", sourceId: result.sourceId, discoveryResultId: result.id, name: "Items", classification: "listings", membershipUrls: ["https://example.test/items"], representativeUrls: ["https://example.test/items"], estimatedPageCount: 1, estimatedRecordCount: null, estimatedCrawlSeconds: 1, confidence: 0.95, explanation: "Repeated item path", knownRisks: [], provenance: { model: "test-model", promptVersion: "v1", confidence: 0.95 }, createdAt: new Date("2026-01-01") }];
  }
}

describe("DiscoveryService", () => {
  it("keeps AI candidate proposals separate from user-approved datasets and captures the approved plan", async () => {
    const sources = new InMemorySourceRepository(); await sources.create(source);
    const repository = new InMemoryDiscoveryRepository();
    const service = new DiscoveryService(sources, repository, new WebsiteCrawler(new FakeClient(), () => new Date("2026-01-01")), new FakeClassifier());
    const preview = await service.discover(source.id, { maxPages: 5, maxDepth: 1, maxBytesPerPage: 10_000, timeoutMs: 1_000, maxRedirects: 5, allowedOrigins: [] });

    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]).toMatchObject({ name: "Items", confidence: 0.95 });
    const approved = await service.approveAndCapture({ candidateIds: ["candidate-1"], approvedBy: "user-1" });
    expect(approved.dataset.candidateIds).toEqual(["candidate-1"]);
    expect(approved.crawlPlan.urls).toEqual(["https://example.test/items"]);
    expect(approved.snapshots.entries).toHaveLength(1);
  });

  it("rejects scope expansion beyond selected candidate membership", async () => {
    const sources = new InMemorySourceRepository(); await sources.create(source);
    const service = new DiscoveryService(sources, new InMemoryDiscoveryRepository(), new WebsiteCrawler(new FakeClient()), new FakeClassifier());
    await service.discover(source.id, { maxPages: 5, maxDepth: 1, maxBytesPerPage: 10_000, timeoutMs: 1_000, maxRedirects: 5, allowedOrigins: [] });
    await expect(service.approveAndCapture({ candidateIds: ["candidate-1"], approvedBy: "user-1", scope: ["https://example.test/unapproved"] })).rejects.toThrow("outside approved candidate membership");
  });
});
