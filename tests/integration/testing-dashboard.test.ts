import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { WebsiteConnector, type WebsiteAcquisitionEngine } from "../../src/connectors/website-connector.js";
import type { AIProvider, StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";

class FakeWebsiteEngine implements WebsiteAcquisitionEngine {
  async acquire(url: string): Promise<{ rawHtml: string; metadata: Record<string, unknown>; links: string[]; finalUrl: string }> {
    if (url === "https://example.test/") return { finalUrl: url, metadata: {}, links: ["/items"], rawHtml: '<title>Catalog</title><article class="record"><span class="name">Catalog</span></article>' };
    if (url === "https://example.test/items") return { finalUrl: url, metadata: {}, links: [], rawHtml: '<title>Items</title><article class="record"><span class="name">Item</span></article>' };
    throw new Error("not found");
  }
}

class FakeSchemaProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    if (request.operation === "extraction_plan") {
      const input = request.input as { samples: Array<{ snapshotId: string; evidenceReference: string }> };
      const sample = input.samples[0]!;
      return { pageTypes: [{ pageType: "path:root", classificationEvidence: [sample.evidenceReference], recordSelector: ".record", fields: [{ field: "name", selector: ".name", source: "text", transforms: ["trim"], required: true, evidenceReference: sample.evidenceReference }] }], pagination: { strategy: "none", evidenceReference: sample.evidenceReference }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["name"] }, missingFieldPolicy: "reject_record", examples: [{ snapshotId: sample.snapshotId, recordIndex: 0, evidenceReference: sample.evidenceReference }], confidence: 0.8 };
    }
    return { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, fields: [{ name: "name", type: "string", required: true, confidence: 0.8, evidence: "title" }], rationale: "Test schema", confidence: 0.8 };
  }
}

class ScenarioProvider extends FakeSchemaProvider {
  constructor(private readonly scenario: "invalid-schema" | "plan-failure" | "missing-records" | "invalid-plan") { super(); }
  override async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    if (this.scenario === "invalid-schema" && request.operation === "dataset_schema") return { schema: { type: "object", properties: {}, required: [] }, fields: [], rationale: "Invalid fixture", confidence: 0 };
    if (this.scenario === "plan-failure" && request.operation === "extraction_plan") throw new Error("planned provider failure");
    if (this.scenario === "invalid-plan" && request.operation === "extraction_plan") return {
      pageTypes: [{ pageType: "path:root", classificationEvidence: ["snapshot:missing"], collectionSelector: "javascript:alert(1)", recordSelector: "[", fields: [{ field: "unknown", selector: "//article", source: "html", transforms: ["javascript"], required: true, evidenceReference: "snapshot:missing" }, { field: "name", selector: ".name", source: "attribute", transforms: [], required: true, evidenceReference: "snapshot:missing" }] }],
      pagination: { strategy: "none", evidenceReference: "snapshot:missing" }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["unknown"] }, missingFieldPolicy: "reject_record", examples: [{ snapshotId: "snapshot:missing", recordIndex: 0, evidenceReference: "snapshot:missing" }], confidence: 0.8
    };
    if (this.scenario === "missing-records" && request.operation === "extraction_plan") {
      const input = request.input as { samples: Array<{ snapshotId: string; evidenceReference: string }> };
      const sample = input.samples[0]!;
      return { pageTypes: [{ pageType: "path:root", classificationEvidence: [sample.evidenceReference], recordSelector: ".missing", fields: [{ field: "name", selector: ".name", source: "text", transforms: ["trim"], required: true, evidenceReference: sample.evidenceReference }] }], pagination: { strategy: "none", evidenceReference: sample.evidenceReference }, duplicatePolicy: { strategy: "deduplicate", keyFields: ["name"] }, missingFieldPolicy: "reject_record", examples: [{ snapshotId: sample.snapshotId, recordIndex: 0, evidenceReference: sample.evidenceReference }], confidence: 0.8 };
    }
    return super.generateStructured(request);
  }
}

class DuplicateWebsiteEngine extends FakeWebsiteEngine {
  override async acquire(url: string): Promise<{ rawHtml: string; metadata: Record<string, unknown>; links: string[]; finalUrl: string }> {
    if (url === "https://example.test/") return { finalUrl: url, metadata: {}, links: ["/items"], rawHtml: '<article class="record"><span class="name">Same</span></article>' };
    if (url === "https://example.test/items") return { finalUrl: url, metadata: {}, links: [], rawHtml: '<article class="record"><span class="name">Same</span></article>' };
    throw new Error("not found");
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
    expect(payload.phase4.schemaApproval.status).toBe("AUTO_APPROVED");
    expect(payload.phase4.plan).toBeTruthy();
    expect(payload.phase4.result.records.length).toBeGreaterThan(0);
    expect(payload.phase4.evaluation.outcome).toBe("PASS");
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

  it("stops Phase 4 cleanly when schema validation cannot auto-approve", async () => {
    const scenarioApp = await buildApp({ websiteConnector: new WebsiteConnector(new FakeWebsiteEngine()), aiProvider: new ScenarioProvider("invalid-schema"), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({ method: "POST", url: "/testing/run", payload: { url: "https://example.test/", steps: { discovery: true, approval: true, snapshotCapture: true, schema: true } } });
      const payload = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(payload.phase4.schemaApproval).toBeNull();
      expect(payload.phase4.plan).toBeNull();
      expect(payload.phase4.result).toBeNull();
      expect(payload.phase4.approvalDiagnostics.join(" ")).toContain("no fields");
    } finally { await scenarioApp.close(); }
  });

  it("retains approval but skips execution when plan generation fails", async () => {
    const scenarioApp = await buildApp({ websiteConnector: new WebsiteConnector(new FakeWebsiteEngine()), aiProvider: new ScenarioProvider("plan-failure"), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    await scenarioApp.ready();
    try {
      const payload = JSON.parse((await scenarioApp.inject({ method: "POST", url: "/testing/run", payload: { url: "https://example.test/", steps: { discovery: true, approval: true, snapshotCapture: true, schema: true } } })).body);
      expect(payload.phase4.schemaApproval.status).toBe("AUTO_APPROVED");
      expect(payload.phase4.plan).toBeNull();
      expect(payload.phase4.result).toBeNull();
      expect(payload.phase4.error).toContain("planned provider failure");
    } finally { await scenarioApp.close(); }
  });

  it("returns every extraction-plan validation diagnostic and skips persistence and execution", async () => {
    const scenarioApp = await buildApp({ websiteConnector: new WebsiteConnector(new FakeWebsiteEngine()), aiProvider: new ScenarioProvider("invalid-plan"), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    await scenarioApp.ready();
    try {
      const dashboard = await scenarioApp.inject({ method: "GET", url: "/testing" });
      expect(dashboard.body).toContain("Extraction Plan Validation");
      const response = await scenarioApp.inject({ method: "POST", url: "/testing/run", payload: { url: "https://example.test/", steps: { discovery: true, approval: true, snapshotCapture: true, schema: true } } });
      const payload = JSON.parse(response.body);
      const diagnostics = payload.phase4.planValidationDiagnostics;

      expect(response.statusCode).toBe(200);
      expect(payload.phase4.plan).toBeNull();
      expect(payload.phase4.result).toBeNull();
      expect(payload.phase4.evaluation).toBeNull();
      expect(diagnostics.map((diagnostic: { validationRuleId: string }) => diagnostic.validationRuleId)).toEqual(expect.arrayContaining(["SCHEMA_FIELD_UNKNOWN", "SELECTOR_PROHIBITED", "SELECTOR_UNSUPPORTED", "HTML_EXTRACTION_DISABLED", "TRANSFORM_DISALLOWED", "ATTRIBUTE_NAME_REQUIRED", "DUPLICATE_KEY_FIELD_UNKNOWN"]));
      expect(payload.logs.join("\n")).toContain("Extraction Plan Validation failed with");
      expect(payload.phase4.error).toContain("Extraction plan validation failed with");
    } finally { await scenarioApp.close(); }
  });

  it("displays REVIEW and FAIL evaluation outcomes without fabricated records", async () => {
    const reviewApp = await buildApp({ websiteConnector: new WebsiteConnector(new DuplicateWebsiteEngine()), aiProvider: new FakeSchemaProvider(), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    const failApp = await buildApp({ websiteConnector: new WebsiteConnector(new FakeWebsiteEngine()), aiProvider: new ScenarioProvider("missing-records"), environment: { nodeEnv: "development", port: 3000, databaseUrl: "", redisUrl: "" } });
    await reviewApp.ready(); await failApp.ready();
    try {
      const request = { method: "POST" as const, url: "/testing/run", payload: { url: "https://example.test/", steps: { discovery: true, approval: true, snapshotCapture: true, schema: true } } };
      const review = JSON.parse((await reviewApp.inject(request)).body);
      const failed = JSON.parse((await failApp.inject(request)).body);
      expect(review.phase4.evaluation.outcome).toBe("REVIEW");
      expect(review.phase4.result.metrics.duplicatesRemoved).toBeGreaterThan(0);
      expect(failed.phase4.evaluation.outcome).toBe("FAIL");
      expect(failed.phase4.result.records).toEqual([]);
    } finally { await reviewApp.close(); await failApp.close(); }
  });
});
