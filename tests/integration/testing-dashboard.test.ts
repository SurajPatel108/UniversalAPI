import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { WebsiteConnector, type WebsiteAcquisitionEngine } from "../../src/connectors/website-connector.js";
import type { AIProvider, StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";

class FakeWebsiteEngine implements WebsiteAcquisitionEngine {
  async acquire(url: string): Promise<{ rawHtml: string; metadata: Record<string, unknown>; links: string[]; finalUrl: string }> {
    if (url === "https://example.test/") return { finalUrl: url, metadata: {}, links: ["/items"], rawHtml: '<title>Catalog</title>' };
    if (url === "https://example.test/items") return { finalUrl: url, metadata: {}, links: [], rawHtml: "<title>Items</title>" };
    throw new Error("not found");
  }
}

class FakeSchemaProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  async generateStructured(_request: StructuredGenerationRequest): Promise<unknown> {
    return { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, fields: [{ name: "name", type: "string", required: true, confidence: 0.8, evidence: "title" }], rationale: "Test schema", confidence: 0.8 };
  }
}

class FailedWebsiteEngine implements WebsiteAcquisitionEngine {
  async acquire(): Promise<never> { throw new Error("Crawl4AI network request failed"); }
}

describe("testing dashboard", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ websiteConnector: new WebsiteConnector(new FakeWebsiteEngine()), aiProvider: new FakeSchemaProvider(), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves the testing dashboard in development and runs the pipeline", async () => {
    const htmlResponse = await app.inject({ method: "GET", url: "/testing" });
    expect(htmlResponse.statusCode).toBe(200);
    expect(htmlResponse.body).toContain("Universal API Testing Dashboard");

    const runResponse = await app.inject({
      method: "POST",
      url: "/testing/run",
      payload: {
        url: "https://example.test/",
        steps: { discovery: true, approval: true, snapshotCapture: true, schema: true }
      }
    });

    expect(runResponse.statusCode).toBe(200);
    const payload = JSON.parse(runResponse.body);
    expect(payload.logs.length).toBeGreaterThan(0);
    expect(payload.discoveredDatasets).toBeGreaterThanOrEqual(1);
    expect(payload.datasetId).toBeTruthy();
    expect(payload.schemaFields).toBeGreaterThan(0);
    expect(payload.acquisitionDiagnostics).toEqual([]);
  });

  it("reports persisted acquisition failures without attempting later prerequisites", async () => {
    const failedApp = await buildApp({ websiteConnector: new WebsiteConnector(new FailedWebsiteEngine()), aiProvider: new FakeSchemaProvider(), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    await failedApp.ready();
    try {
      const response = await failedApp.inject({
        method: "POST",
        url: "/testing/run",
        payload: { url: "https://example.test/", steps: { discovery: true, approval: true, snapshotCapture: true, schema: true } }
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.discoveredDatasets).toBe(0);
      expect(payload.datasetId).toBeNull();
      expect(payload.snapshotCollectionId).toBeNull();
      expect(payload.schemaId).toBeNull();
      expect(payload.acquisitionDiagnostics).toEqual([{ url: "https://example.test/", stage: "Acquisition", reason: "Crawl4AI network request failed" }]);
      expect(payload.logs.join("\n")).toContain("Acquisition failed for https://example.test/");
      expect(payload.logs.join("\n")).toContain("Dataset approval skipped because prerequisite discovery did not succeed.");
      expect(payload.error).toContain("acquisition failed");
      expect(payload.generatedIds).toHaveLength(1);
    } finally {
      await failedApp.close();
    }
  });
});
