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
  it("reads GEMINI_API_KEY from the environment", () => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";

    try {
      const environment = loadEnvironment();
      expect(environment.geminiApiKey).toBe("test-key");
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous;
    }
  });

  it("creates a Gemini provider whenever a Gemini API key is configured", () => {
    const provider = createConfiguredGeminiProvider({ nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "", geminiApiKey: "test-key" });
    expect(provider?.name).toBe("gemini");
    expect(provider?.model).toBe("gemini-2.0-flash-exp");
  });

  it("uses only bounded redacted samples and caches a collection revision", async () => {
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
    const samples = (provider.calls[0]?.input as { samples: Array<{ excerpt: string }> }).samples;
    expect(samples).toHaveLength(3);
    expect(samples[0]?.excerpt).toContain("[REDACTED_EMAIL]");
    expect(samples[0]?.excerpt).toContain("[REDACTED_PHONE]");
    expect(samples[0]?.excerpt).not.toContain("secret()");
  });

  it("returns a deterministic valid schema when no provider is configured", async () => {
    const discoveries = new InMemoryDiscoveryRepository();
    await discoveries.saveSnapshotCollection({ id: "collection-2", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(), entries: [] });
    const schema = await new SchemaUnderstandingService(discoveries, new InMemorySchemaRepository(), null).analyze("collection-2");
    expect(schema.provenance.model).toBe("deterministic-fallback");
    expect(schema.schema).toEqual({ type: "object", properties: {}, required: [] });
  });
});
