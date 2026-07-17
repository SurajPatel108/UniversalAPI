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
  async generateStructured(_request: StructuredGenerationRequest): Promise<unknown> { return { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, fields: [{ name: "name", type: "string", required: true, confidence: 0.8, evidence: "title" }], rationale: "Test schema", confidence: 0.8 }; }
}

describe("discovery API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp({ websiteHttpClient: new FakeWebsiteHttpClient(), aiProvider: new FakeSchemaProvider() }); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it("discovers deterministically, returns a preview, and approves/captures a selected dataset", async () => {
    const sourceResponse = await app.inject({ method: "POST", url: "/v1/sources", payload: { sourceType: "website", url: "https://example.test/" } });
    const source = JSON.parse(sourceResponse.body) as { id: string };
    const discoveryResponse = await app.inject({ method: "POST", url: `/v1/sources/${source.id}/discover`, payload: { limits: { maxPages: 5, maxDepth: 1 } } });
    expect(discoveryResponse.statusCode).toBe(201);
    const preview = JSON.parse(discoveryResponse.body) as { discoveryResultId: string; candidates: Array<{ candidateId: string; estimatedPageCount: number }> };
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.estimatedPageCount).toBe(2);

    const previewResponse = await app.inject({ method: "GET", url: `/v1/discoveries/${preview.discoveryResultId}/preview` });
    expect(previewResponse.statusCode).toBe(200);

    const approvalResponse = await app.inject({ method: "POST", url: `/v1/discoveries/${preview.discoveryResultId}/approve`, payload: { candidateIds: [preview.candidates[0]!.candidateId], approvedBy: "integration-test", crawlBudget: { maxPages: 2, maxDepth: 1, maxBytesPerPage: 100_000, timeoutMs: 5_000, maxRedirects: 2 } } });
    expect(approvalResponse.statusCode).toBe(201);
    const approved = JSON.parse(approvalResponse.body) as { dataset: { id: string }; crawlPlan: { id: string }; snapshotCollection: { id: string } };
    expect(approved.dataset.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(approved.crawlPlan.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(approved.snapshotCollection.id).toMatch(/^[0-9a-f-]{36}$/i);
    const schemaResponse = await app.inject({ method: "POST", url: `/v1/snapshot-collections/${approved.snapshotCollection.id}/schema` });
    expect(schemaResponse.statusCode).toBe(201);
    expect(JSON.parse(schemaResponse.body)).toMatchObject({ snapshotCollectionId: approved.snapshotCollection.id, schema: { type: "object" }, fields: [expect.objectContaining({ name: "name" })] });
  });

  it("accepts the default scope sentinel when approving a discovery", async () => {
    const sourceResponse = await app.inject({ method: "POST", url: "/v1/sources", payload: { sourceType: "website", url: "https://example.test/" } });
    const source = JSON.parse(sourceResponse.body) as { id: string };
    const discoveryResponse = await app.inject({ method: "POST", url: `/v1/sources/${source.id}/discover`, payload: { limits: { maxPages: 5, maxDepth: 1 } } });
    const preview = JSON.parse(discoveryResponse.body) as { discoveryResultId: string; candidates: Array<{ candidateId: string }> };

    const approvalResponse = await app.inject({
      method: "POST",
      url: `/v1/discoveries/${preview.discoveryResultId}/approve`,
      payload: { candidateIds: [preview.candidates[0]!.candidateId], approvedBy: "integration-test", scope: ["default"], crawlBudget: { maxPages: 2, maxDepth: 1, maxBytesPerPage: 100_000, timeoutMs: 5_000, maxRedirects: 2 } }
    });

    expect(approvalResponse.statusCode).toBe(201);
  });

  it("rejects approval of a candidate not present in the requested discovery", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/discoveries/00000000-0000-4000-8000-000000000000/approve", payload: { candidateIds: ["00000000-0000-4000-8000-000000000001"], approvedBy: "test" } });
    expect(response.statusCode).toBe(404);
  });

  it("publishes the approval workflow contract in OpenAPI", () => {
    const openapi = (app as unknown as { swagger(): { paths: Record<string, { post?: { parameters?: Array<{ name: string; in: string }>; requestBody?: { content: Record<string, { schema: { required?: string[]; properties?: Record<string, unknown> } }> }; responses?: Record<string, unknown> } }> } }).swagger();
    const operation = openapi.paths["/v1/discoveries/{discoveryResultId}/approve"]?.post;
    expect(operation?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "discoveryResultId", in: "path" })]));
    const schema = operation?.requestBody?.content["application/json"]?.schema;
    expect(schema?.required).toEqual(expect.arrayContaining(["candidateIds", "approvedBy"]));
    expect(schema?.properties).toHaveProperty("crawlBudget");
    expect(operation?.responses).toHaveProperty("201");
  });
});
