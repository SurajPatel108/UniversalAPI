import { describe, expect, it } from "vitest";
import { StructuralDatasetClassificationService } from "../../src/ai/structural-dataset-classification-service.js";
import type { DiscoveryResult } from "../../src/models/discovery.js";

describe("StructuralDatasetClassificationService", () => {
  it("ranks repeated primary-content records above repeated navigation", async () => {
    const result: DiscoveryResult = {
      id: "discovery-1", sourceId: "source-1", seedUrl: "https://books.example/", limits: { maxPages: 10, maxDepth: 2, maxBytesPerPage: 1000, timeoutMs: 1000, maxRedirects: 2, allowedOrigins: [] }, completed: true, createdAt: new Date(),
      pages: [
        { url: "https://books.example/", canonicalUrl: "https://books.example/", depth: 0, parentUrl: null, links: ["https://books.example/category/fiction", "https://books.example/category/history"], title: "Books", contentType: "text/html", disposition: "captured", structure: { mainRecordCandidates: 20, mainLinkCount: 20, mainUniqueLinkCount: 20, mainAttributeCount: 40, repeatedSiblingGroups: 1, navigationLinkCount: 6, paginationLinkCount: 1, mainHeading: "Books" } },
        { url: "https://books.example/page-2", canonicalUrl: "https://books.example/page-2", depth: 1, parentUrl: "https://books.example/", links: ["https://books.example/category/fiction", "https://books.example/category/history"], title: "Books page 2", contentType: "text/html", disposition: "captured", structure: { mainRecordCandidates: 20, mainLinkCount: 20, mainUniqueLinkCount: 20, mainAttributeCount: 40, repeatedSiblingGroups: 1, navigationLinkCount: 6, paginationLinkCount: 1, mainHeading: "Books" } },
        { url: "https://books.example/category/fiction", canonicalUrl: "https://books.example/category/fiction", depth: 1, parentUrl: "https://books.example/", links: [], title: "Fiction", contentType: "text/html", disposition: "captured", structure: { mainRecordCandidates: 0, mainLinkCount: 0, mainUniqueLinkCount: 0, mainAttributeCount: 0, repeatedSiblingGroups: 0, navigationLinkCount: 12, paginationLinkCount: 0, mainHeading: "Fiction" } },
        { url: "https://books.example/category/history", canonicalUrl: "https://books.example/category/history", depth: 1, parentUrl: "https://books.example/", links: [], title: "History", contentType: "text/html", disposition: "captured", structure: { mainRecordCandidates: 0, mainLinkCount: 0, mainUniqueLinkCount: 0, mainAttributeCount: 0, repeatedSiblingGroups: 0, navigationLinkCount: 12, paginationLinkCount: 0, mainHeading: "History" } }
      ]
    };

    const candidates = await new StructuralDatasetClassificationService().classify(result);

    expect(candidates[0]).toMatchObject({ classification: "listings", estimatedRecordCount: 40, membershipUrls: ["https://books.example/", "https://books.example/page-2"] });
    expect(candidates[1]).toMatchObject({ classification: "categories", knownRisks: ["High navigation-likelihood; review before selecting"] });
    expect(candidates[0]!.confidence).toBeGreaterThan(candidates[1]!.confidence);
  });
});
