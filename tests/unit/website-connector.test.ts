import { describe, expect, it } from "vitest";
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
});
