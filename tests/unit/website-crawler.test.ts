import { describe, expect, it } from "vitest";
import { WebsiteCrawler, type WebsiteHttpClient } from "../../src/crawlers/website-crawler.js";
import type { Source } from "../../src/models/source.js";

const source: Source = { id: "source-1", publicSlug: "example-root", sourceType: "website", url: "https://example.test/", status: "draft", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") };

class FakeHttpClient implements WebsiteHttpClient {
  readonly calls: string[] = [];
  constructor(private readonly pages: Record<string, string>) {}
  async get(url: string): Promise<{ finalUrl: string; contentType: string; body: string }> {
    this.calls.push(url);
    const body = this.pages[url];
    if (!body) throw new Error("not found");
    return { finalUrl: url, contentType: "text/html", body };
  }
}

describe("WebsiteCrawler", () => {
  it("performs bounded same-origin deterministic discovery and records exclusions", async () => {
    const client = new FakeHttpClient({
      "https://example.test/": '<title>Home</title><a href="/products">Products</a><a href="https://outside.test/">Outside</a>',
      "https://example.test/products": '<a href="/products/one">One</a>',
      "https://example.test/products/one": "<title>One</title>"
    });
    const crawler = new WebsiteCrawler(client, () => new Date("2026-01-01"));
    const result = await crawler.discover(source, { maxPages: 2, maxDepth: 3, maxBytesPerPage: 10_000, timeoutMs: 1_000, maxRedirects: 5, allowedOrigins: [] });

    expect(result.pages.filter((page) => page.disposition === "captured")).toHaveLength(2);
    expect(result.pages.some((page) => page.disposition === "limit_reached")).toBe(true);
    expect(result.pages[0]).toMatchObject({ title: "Home", links: ["https://example.test/products"] });
    expect(client.calls).not.toContain("https://outside.test/");
  });

  it("captures every crawl-plan URL and retains failures in the collection", async () => {
    const client = new FakeHttpClient({ "https://example.test/a": "A" });
    const crawler = new WebsiteCrawler(client, () => new Date("2026-01-01"));
    const collection = await crawler.capturePlan(source, { id: "plan-1", datasetId: "dataset-1", revision: 1, urls: ["https://example.test/a", "https://example.test/missing"], limits: { maxPages: 3, maxDepth: 1, maxBytesPerPage: 10_000, timeoutMs: 1_000, maxRedirects: 5, allowedOrigins: ["https://example.test"] }, createdAt: new Date("2026-01-01") });

    expect(collection.entries).toHaveLength(2);
    expect(collection.entries[0]?.snapshot?.fingerprint).toHaveLength(64);
    expect(collection.entries[0]?.content).toBe("A");
    expect(collection.entries[1]).toMatchObject({ outcome: "failed" });
    expect(collection.completed).toBe(false);
  });
});
