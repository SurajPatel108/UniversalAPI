import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AIProviderError, type AIProvider, type StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";
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

    await expect(new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), failingProvider).analyze("collection-3")).rejects.toThrow("AI provider returned unusable structured output");
  });

  it("retains transient structured provider diagnostics without persisting an invalid schema", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    const schemas = new InMemorySchemaRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-provider-failure", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/items", outcome: "captured", content: "Catalog item", snapshot: { id: "snapshot-provider-failure", sourceId: "source-1", contentType: "text/html", fingerprint: "provider-failure", capturedAt: new Date() } }] });
    const rawResponse = '{"schema":"partial';
    const provider: AIProvider = {
      name: "fake",
      model: "fake-model",
      async generateStructured() {
        throw new AIProviderError({ operation: "dataset_schema", provider: "fake", model: "fake-model", failureType: "truncated_response", parserError: "Unexpected end of JSON input", responseLength: rawResponse.length, promptVersion: "schema-v3", rawResponse, finishReason: "MAX_TOKENS", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }, "fake output truncated");
      }
    };
    const service = new SchemaUnderstandingService(discoveries, schemas, provider);

    await expect(service.analyze("collection-provider-failure")).rejects.toThrow("AI provider returned unusable structured output");

    expect(service.getLastRunMetadata()).toMatchObject({
      provider: "fake",
      model: "fake-model",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      schemaPreview: null,
      failure: { stage: "Schema Generation", failureType: "truncated_response", rawResponse, finishReason: "MAX_TOKENS" }
    });
    expect(await schemas.findLatestForDatasetAndCollection("dataset-1", "collection-provider-failure")).toBeNull();
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
    expect(input.semanticPageContent.join(" ")).toContain("[REDACTED_EMAIL]");
    expect(input.semanticPageContent.join(" ")).toContain("[REDACTED_PHONE]");
    expect(input.semanticPageContent.join(" ")).not.toContain("secret()");
    expect(input.semanticPageContent.join(" ")).not.toContain("snapshot-1");
    expect(input.nonSchemaMetadata.snapshotCollectionId).toBe("collection-1");
    expect(input.nonSchemaMetadata.sampleEvidence).toEqual(expect.arrayContaining([{ evidenceReference: "snapshot:snapshot-1", snapshotId: "snapshot-1", sourcePageUrl: "https://example.test/one" }]));
    expect(provider.calls[0]?.prompt).toContain("Use only semanticPageContent");
    expect(provider.calls[0]?.prompt).toContain("transport metadata, provenance, and evidence context are non-schema information");
    expect(provider.calls[0]?.promptVersion).toBe("dataset-schema-main-content-v3");
    expect(provider.calls[0]?.responseSchema).toMatchObject({ required: ["schema", "fields", "rationale", "confidence"] });
  });

  it("keeps semantic catalog content separate from evidence transport metadata", async () => {
    const content = await readFile(join(process.cwd(), "tests/fixtures/schema-understanding/product-catalog.html"), "utf8");
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-catalog", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/products/trail-lantern", outcome: "captured", content, snapshot: { id: "snapshot-catalog", sourceId: "source-1", contentType: "text/html", fingerprint: "catalog", capturedAt: new Date() } }] });
    const provider = new FakeProvider();

    await new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), provider).analyze("collection-catalog");

    const input = provider.calls[0]?.input as { semanticPageContent: string[]; nonSchemaMetadata: { sampleEvidence: Array<{ sourcePageUrl: string }> } };
    expect(input.semanticPageContent).toEqual(["Trail Lantern $29.99 In stock"]);
    expect(input.semanticPageContent.join(" ")).not.toContain("https://example.test");
    expect(input.nonSchemaMetadata.sampleEvidence[0]?.sourcePageUrl).toBe("https://example.test/products/trail-lantern");
  });

  it("extracts bounded primary-content evidence after long page chrome", async () => {
    const navigation = Array.from({ length: 350 }, (_value, index) => `<a href="/category/${index}">Navigation item ${index}</a>`).join("");
    const content = `<!doctype html><html><body><header>Store header</header><aside class="sidebar">${navigation}</aside><section class="products"><article class="product"><h2>Meaningful Product</h2><p class="price">$29.99</p><a href="/products/meaningful-product">View product</a></article></section><footer>Store footer</footer></body></html>`;
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-long-chrome", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [{ url: "https://example.test/products", outcome: "captured", content, snapshot: { id: "snapshot-long-chrome", sourceId: "source-1", contentType: "text/html", fingerprint: "long-chrome", capturedAt: new Date() } }] });
    const provider = new FakeProvider();

    await new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), provider).analyze("collection-long-chrome");

    const input = provider.calls[0]?.input as { semanticPageContent: string[] };
    expect(content.length).toBeGreaterThan(4_000);
    expect(input.semanticPageContent).toHaveLength(1);
    expect(input.semanticPageContent[0]).toContain("Meaningful Product");
    expect(input.semanticPageContent[0]).toContain("$29.99");
    expect(input.semanticPageContent[0]).not.toContain("Navigation item");
    expect(input.semanticPageContent[0]!.length).toBeLessThanOrEqual(1_400);
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
