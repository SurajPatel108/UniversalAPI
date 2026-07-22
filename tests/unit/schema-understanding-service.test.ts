import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AIProvider, StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";
import { createConfiguredGeminiProvider } from "../../src/ai/providers/gemini-provider.js";
import { loadEnvironment } from "../../src/config/environment.js";
import { InMemoryDiscoveryRepository } from "../../src/database/discovery-repository.js";
import { InMemorySchemaRepository } from "../../src/database/schema-repository.js";
import { SchemaUnderstandingService } from "../../src/services/schema-understanding-service.js";

class FakeProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls: StructuredGenerationRequest[] = [];
  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> { this.calls.push(request); return { schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, fields: [{ name: "title", type: "string", required: true, confidence: 0.9, evidence: "title" }], rationale: "A title is present", confidence: 0.9 }; }
}

describe("SchemaUnderstandingService", () => {
  it("reads GEMINI_API_KEY from injected production environment", () => {
    const previous = process.env.GEMINI_API_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.GEMINI_API_KEY = "test-key";

    try {
      const environment = loadEnvironment();
      expect(environment.geminiApiKey).toBe("test-key");
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("creates a Gemini provider whenever a Gemini API key is configured", () => {
    const provider = createConfiguredGeminiProvider({ nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "", geminiApiKey: "test-key" });
    expect(provider?.name).toBe("gemini");
    expect(provider?.model).toBe("gemini-3.1-flash-lite");
  });

  it("surfaces provider failures instead of silently returning an empty schema", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-3", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [] });
    const failingProvider: AIProvider = { name: "fake", model: "fake-model", async generateStructured() { throw new Error("Gemini auth failed"); } };

    await expect(new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), failingProvider).analyze("collection-3")).rejects.toThrow("Gemini auth failed");
  });

  it("uses only bounded semantic content, labels metadata as non-schema context, and caches a collection revision", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-1", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [
      { url: "https://example.test/one", outcome: "captured", content: '<script>secret()</script>alice@example.test +1 555 123 4567 <h1>One</h1>', snapshot: { id: "snapshot-1", sourceId: "source-1", contentType: "text/html", fingerprint: "a", capturedAt: new Date() } },
      { url: "https://example.test/two", outcome: "captured", content: "Two", snapshot: { id: "snapshot-2", sourceId: "source-1", contentType: "text/html", fingerprint: "b", capturedAt: new Date() } },
      { url: "https://example.test/three", outcome: "captured", content: "Three", snapshot: { id: "snapshot-3", sourceId: "source-1", contentType: "text/html", fingerprint: "c", capturedAt: new Date() } },
      { url: "https://example.test/four", outcome: "captured", content: "Four", snapshot: { id: "snapshot-4", sourceId: "source-1", contentType: "text/html", fingerprint: "d", capturedAt: new Date() } }
    ] });
    const provider = new FakeProvider();
    const service = new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), provider);
    const first = await service.analyze("collection-1");
    const second = await service.analyze("collection-1");

    expect(first.id).toBe(second.id);
    expect(provider.calls).toHaveLength(1);
    const input = provider.calls[0]?.input as {
      semanticPageContent: string[];
      nonSchemaMetadata: { snapshotCollectionId: string; sampleEvidence: Array<{ evidenceReference: string; snapshotId: string; sourcePageUrl: string }> };
    };
    expect(input.semanticPageContent).toHaveLength(3);
    expect(input.semanticPageContent[0]).toContain("[REDACTED_EMAIL]");
    expect(input.semanticPageContent[0]).toContain("[REDACTED_PHONE]");
    expect(input.semanticPageContent[0]).not.toContain("secret()");
    expect(input.semanticPageContent[0]).not.toContain("snapshot-1");
    expect(input.nonSchemaMetadata).toEqual({ snapshotCollectionId: "collection-1", sampleEvidence: [{ evidenceReference: "snapshot:snapshot-1", snapshotId: "snapshot-1", sourcePageUrl: "https://example.test/one" }, { evidenceReference: "snapshot:snapshot-2", snapshotId: "snapshot-2", sourcePageUrl: "https://example.test/two" }, { evidenceReference: "snapshot:snapshot-3", snapshotId: "snapshot-3", sourcePageUrl: "https://example.test/three" }] });
    expect(provider.calls[0]?.prompt).toContain("Use only semanticPageContent");
    expect(provider.calls[0]?.prompt).toContain("nonSchemaMetadata is transport");
  });

  it("keeps semantic catalog content separate from evidence transport metadata", async () => {
    const content = await readFile(join(process.cwd(), "tests/fixtures/schema-understanding/product-catalog.html"), "utf8");
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-catalog", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/products/trail-lantern", outcome: "captured", content, snapshot: { id: "snapshot-catalog", sourceId: "source-1", contentType: "text/html", fingerprint: "catalog", capturedAt: new Date() } }] });
    const provider = new FakeProvider();

    await new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), provider).analyze("collection-catalog");

    const input = provider.calls[0]?.input as { semanticPageContent: string[]; nonSchemaMetadata: { sampleEvidence: Array<{ sourcePageUrl: string }> } };
    expect(input.semanticPageContent).toEqual(["Product catalog Trail Lantern $29.99 In stock"]);
    expect(input.semanticPageContent.join(" ")).not.toContain("https://example.test");
    expect(input.nonSchemaMetadata.sampleEvidence[0]?.sourcePageUrl).toBe("https://example.test/products/trail-lantern");
  });

  it("rejects proposed reserved metadata fields before persistence", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    const schemas = new InMemorySchemaRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-reserved", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/items", outcome: "captured", content: "Catalog item", snapshot: { id: "snapshot-reserved", sourceId: "source-1", contentType: "text/html", fingerprint: "reserved", capturedAt: new Date() } }] });
    const provider: AIProvider = {
      name: "fake",
      model: "fake-model",
      async generateStructured() {
        return { schema: { type: "object", properties: { snapshotCollectionId: { type: "string" }, title: { type: "string" } }, required: ["snapshotCollectionId", "title"] }, fields: [{ name: "snapshotCollectionId", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-reserved" }, { name: "title", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-reserved" }], rationale: "Incorrectly used transport metadata", confidence: 1 };
      }
    };

    await expect(new SchemaUnderstandingService(discoveries, schemas, provider).analyze("collection-reserved")).rejects.toThrow("reserved metadata field(s): snapshotCollectionId");
    expect(await schemas.findLatestForDatasetAndCollection("dataset-1", "collection-reserved")).toBeNull();
  });

  it("returns a deterministic valid schema when no provider is configured", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-2", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [] });
    const schema = await new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), null).analyze("collection-2");
    expect(schema.provenance.model).toBe("deterministic-fallback");
    expect(schema.schema).toEqual({ type: "object", properties: {}, required: [] });
  });
});
