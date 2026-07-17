import { describe, expect, it } from "vitest";
import { WebsiteConnector } from "../../src/connectors/website-connector.js";
import { WebsiteCrawler, type WebsiteHttpClient } from "../../src/crawlers/website-crawler.js";
import type { Source } from "../../src/models/source.js";

class FakeClient implements WebsiteHttpClient {
  async get(url: string): Promise<{ finalUrl: string; contentType: string; body: string }> { return { finalUrl: url, contentType: "text/html", body: "<title>Captured</title>" }; }
}

describe("WebsiteConnector", () => {
  it("validates a website source and returns a reproducible compatibility capture", async () => {
    const source: Source = { id: "source-1", publicSlug: "example", sourceType: "website", url: "https://example.test/", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    const connector = new WebsiteConnector(new WebsiteCrawler(new FakeClient()));
    const captured = await connector.capture(source);
    expect(captured.content).toContain("Captured");
    expect(captured.snapshot.contentType).toBe("text/html");
  });

  it("rejects a non-website source", async () => {
    const connector = new WebsiteConnector(new WebsiteCrawler(new FakeClient()));
    const source: Source = { id: "source-2", publicSlug: "pdf", sourceType: "pdf", url: "https://example.test/file.pdf", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    await expect(connector.validate(source)).rejects.toThrow("WebsiteConnector only supports website sources");
  });
});
