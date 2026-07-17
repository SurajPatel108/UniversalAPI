import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import type { WebsiteHttpClient } from "../../src/crawlers/website-crawler.js";
import type { AIProvider, StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";

class FakeWebsiteHttpClient implements WebsiteHttpClient {
  async get(url: string): Promise<{ finalUrl: string; contentType: string; body: string }> {
    if (url === "https://example.test/") return { finalUrl: url, contentType: "text/html", body: '<title>Catalog</title><a href="/items">Items</a>' };
    if (url === "https://example.test/items") return { finalUrl: url, contentType: "text/html", body: "<title>Items</title>" };
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

describe("testing dashboard", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ websiteHttpClient: new FakeWebsiteHttpClient(), aiProvider: new FakeSchemaProvider(), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
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
  });
});
