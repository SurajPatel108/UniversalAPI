import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StructuralDatasetClassificationService } from "../../src/ai/structural-dataset-classification-service.js";
import { WebsiteConnector, type WebsiteAcquisitionEngine } from "../../src/connectors/website-connector.js";
import type { Source } from "../../src/models/source.js";

class FakeEngine implements WebsiteAcquisitionEngine {
  async acquire(url: string): Promise<{ rawHtml: string; markdown: string; cleanedContent: string; metadata: Record<string, unknown>; links: string[]; finalUrl: string; screenshot: string }> { return { rawHtml: "<title>Captured</title>", markdown: "# Captured", cleanedContent: "Captured", metadata: { title: "Captured" }, links: [], finalUrl: url, screenshot: "data:image/png;base64,abc" }; }
}

describe("WebsiteConnector", () => {
  it("validates a website source and returns a reproducible compatibility capture", async () => {
    const source: Source = { id: "source-1", publicSlug: "example", sourceType: "website", url: "https://example.test/", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    const connector = new WebsiteConnector(new FakeEngine());
    const captured = await connector.capture(source);
    expect(captured.content).toContain("Captured");
    expect(captured.snapshot.contentType).toBe("text/html");
    expect(captured.artifacts).toMatchObject({ markdown: "# Captured", screenshot: "data:image/png;base64,abc" });
  });

  it("rejects a non-website source", async () => {
    const connector = new WebsiteConnector(new FakeEngine());
    const source: Source = { id: "source-2", publicSlug: "pdf", sourceType: "pdf", url: "https://example.test/file.pdf", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    await expect(connector.validate(source)).rejects.toThrow("WebsiteConnector only supports website sources");
  });

  it("preserves neutral artifacts in a snapshot collection and enforces origin scope", async () => {
    const source: Source = { id: "source-3", publicSlug: "example", sourceType: "website", url: "https://example.test/", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    const connector = new WebsiteConnector(new FakeEngine());
    const collection = await connector.capturePlan(source, { id: "plan-1", datasetId: "dataset-1", revision: 1, urls: ["https://example.test/", "https://outside.test/"], limits: { maxPages: 2, maxDepth: 1, maxBytesPerPage: 10_000, timeoutMs: 1_000, maxRedirects: 2, allowedOrigins: [] }, createdAt: new Date() });
    expect(collection.entries[0]?.artifacts).toMatchObject({ cleanedContent: "Captured", links: [] });
    expect(collection.entries[1]).toMatchObject({ outcome: "out_of_scope" });
  });

  it("persists primary-content structural evidence and ranks book cards over navigation", async () => {
    const catalog = await readFile(join(process.cwd(), "tests/fixtures/books-to-scrape/catalog.html"), "utf8");
    const secondPage = await readFile(join(process.cwd(), "tests/fixtures/books-to-scrape/catalog-page-2.html"), "utf8");
    const pages: Record<string, { rawHtml: string; links: string[] }> = {
      "https://books.example/": { rawHtml: catalog, links: ["/catalogue/page-2.html", "/category/books/travel", "/category/books/mystery"] },
      "https://books.example/catalogue/page-2.html": { rawHtml: secondPage, links: ["/category/books/travel", "/category/books/mystery"] },
      "https://books.example/category/books/travel": { rawHtml: '<aside class="side_categories"><a href="/category/books/mystery">Mystery</a></aside>', links: [] },
      "https://books.example/category/books/mystery": { rawHtml: '<aside class="side_categories"><a href="/category/books/travel">Travel</a></aside>', links: [] }
    };
    const engine: WebsiteAcquisitionEngine = { async acquire(url) { const page = pages[url]; if (!page) throw new Error("not found"); return { ...page, metadata: {}, finalUrl: url }; } };
    const source: Source = { id: "books-source", publicSlug: "books", sourceType: "website", url: "https://books.example/", status: "draft", createdAt: new Date(), updatedAt: new Date() };

    const discovery = await new WebsiteConnector(engine).discover(source, { maxPages: 10, maxDepth: 1, maxBytesPerPage: 10_000, timeoutMs: 1_000, maxRedirects: 2, allowedOrigins: [] });
    const root = discovery.pages.find((page) => page.canonicalUrl === "https://books.example/");
    const candidates = await new StructuralDatasetClassificationService().classify(discovery);

    expect(root?.structure).toMatchObject({ mainRecordCandidates: 2, mainUniqueLinkCount: 3, navigationLinkCount: 3, paginationLinkCount: 1 });
    expect(candidates[0]).toMatchObject({ classification: "listings", estimatedRecordCount: 4, membershipUrls: ["https://books.example/", "https://books.example/catalogue/page-2.html"] });
    expect(candidates[1]).toMatchObject({ classification: "categories", knownRisks: ["High navigation-likelihood; review before selecting"] });
  });
});
