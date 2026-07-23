import { describe, expect, it } from "vitest";
import { AIProviderError, type AIProvider, type StructuredGenerationRequest } from "../../src/ai/providers/ai-provider.js";
import { InMemoryDiscoveryRepository } from "../../src/database/discovery-repository.js";
import { InMemoryExtractionRepository } from "../../src/database/extraction-repository.js";
import { InMemorySchemaRepository } from "../../src/database/schema-repository.js";
import { ExtractionPlanGenerationService } from "../../src/services/extraction-plan-generation-service.js";

class FakePlanningProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly calls: StructuredGenerationRequest[] = [];
  private readonly responses: readonly unknown[];
  constructor(response: unknown | readonly unknown[]) { this.responses = Array.isArray(response) ? response : [response]; }
  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    this.calls.push(request);
    const response = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    if (response instanceof Error) throw response;
    return response;
  }
}

const validProposal = {
  pageTypes: [{ pageType: "path:catalog", classificationEvidence: ["snapshot:snapshot-1"], recordSelector: ".record", fields: [
    { field: "title", selector: ".title", source: "text", transforms: ["trim"], required: true, evidenceReference: "snapshot:snapshot-1" },
    { field: "price", selector: ".price", source: "text", transforms: ["trim", "to_currency"], required: true, evidenceReference: "snapshot:snapshot-1" }
  ] }],
  pagination: { strategy: "snapshot_pages", evidenceReference: "snapshot:snapshot-1" },
  duplicatePolicy: { strategy: "deduplicate", keyFields: ["title"] },
  missingFieldPolicy: "reject_record",
  examples: [{ snapshotId: "snapshot-1", recordIndex: 0, evidenceReference: "snapshot:snapshot-1" }],
  confidence: 0.9
};

async function fixture(response: unknown | readonly unknown[] = validProposal, content: string | readonly string[] = '<article class="record"><h2 class="title">Item</h2><p class="price">$1</p><script>secret()</script>person@example.test +1 555 123 4567</article>') {
  const discoveries = new InMemoryDiscoveryRepository();
  const schemas = new InMemorySchemaRepository();
  const extractions = new InMemoryExtractionRepository();
  await discoveries.saveSnapshotCollection({
    id: "collection-1", sourceId: "source-1", datasetId: "dataset-1", crawlPlanId: "plan-1", completed: true, createdAt: new Date(),
    entries: Array.from({ length: 4 }, (_, index) => ({
      url: `https://example.test/catalog/${index + 1}`,
      outcome: "captured" as const,
      content: Array.isArray(content) ? content[index % content.length]! : content,
      snapshot: { id: `snapshot-${index + 1}`, sourceId: "source-1", contentType: "text/html", fingerprint: `fingerprint-${index + 1}`, capturedAt: new Date() }
    }))
  });
  const schema = { id: "schema-1", datasetId: "dataset-1", snapshotCollectionId: "collection-1", collectionRevision: "schema-version-1", schema: { type: "object" as const, properties: { title: { type: "string" }, price: { type: "string" } }, required: ["title", "price"] }, fields: [{ name: "title", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-1" }, { name: "price", type: "string", required: true, confidence: 1, evidence: "snapshot:snapshot-1" }], rationale: "fixture", sampleSnapshotIds: ["snapshot-1"], provenance: { model: "fake-model", promptVersion: "dataset-schema-v1", confidence: 1 }, createdAt: new Date() };
  await schemas.save(schema);
  await schemas.saveApproval({ decisionId: "approval-1", schemaId: schema.id, datasetId: schema.datasetId, snapshotCollectionId: schema.snapshotCollectionId, schemaVersion: schema.collectionRevision, status: "APPROVED", decidedBy: "test", deterministicGateEvidence: ["valid"], createdAt: new Date() });
  const provider = new FakePlanningProvider(response);
  return { provider, service: new ExtractionPlanGenerationService(discoveries, schemas, extractions, provider), extractions };
}

describe("ExtractionPlanGenerationService", () => {
  it("uses a fake provider once and reuses the immutable plan for identical cache inputs", async () => {
    const { provider, service, extractions } = await fixture();
    const first = await service.generate("schema-1");
    const second = await service.generate("schema-1");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.operation).toBe("extraction_plan");
    expect(second).toBe(first);
    expect(await extractions.findPlanByGenerationCacheKey(first.generationCacheKey)).toBe(first);
    expect(first.provenance).toMatchObject({ provider: "fake", model: "fake-model", promptVersion: "extraction-plan-v4-grounded-main-content", preprocessingVersion: "extraction-plan-main-content-dom-v3", samplingVersion: "extraction-plan-stratified-samples-v2" });
  });

  it("retries one truncated provider response with a larger bounded output budget and then caches the valid plan", async () => {
    const truncated = new AIProviderError({ operation: "extraction_plan", provider: "fake", model: "fake-model", failureType: "truncated_response", parserError: "Unexpected end of JSON input", responseLength: 20, promptVersion: "extraction-plan-v4-grounded-main-content", rawResponse: '{"pageTypes":[', finishReason: "MAX_TOKENS", usage: null }, "partial plan");
    const { provider, service, extractions } = await fixture([truncated, validProposal]);

    const first = await service.generate("schema-1");
    const second = await service.generate("schema-1");

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.map((call) => call.maxOutputTokens)).toEqual([2048, 4096]);
    expect(provider.calls.every((call) => call.responseSchema)).toBe(true);
    expect(second).toBe(first);
    expect(await extractions.findPlanByGenerationCacheKey(first.generationCacheKey)).toBe(first);
  });

  it("sends only capped redacted semantic samples and deterministic metadata to the provider", async () => {
    const { provider, service } = await fixture();
    await service.generate("schema-1");

    const input = provider.calls[0]?.input as { samples: Array<{ semanticText: string }>; deterministicMetadata: { capturedPageCount: number } };
    expect(input.samples).toHaveLength(1);
    expect(input.deterministicMetadata.capturedPageCount).toBe(4);
    for (const sample of input.samples) {
      expect(sample.semanticText.length).toBeLessThanOrEqual(600);
      expect(sample.semanticText).not.toContain("<article");
      expect(sample.semanticText).not.toContain("secret()");
      expect(sample.semanticText).not.toContain("@example.test");
      expect(sample.semanticText).toContain("[REDACTED_EMAIL]");
    }
    const prompt = provider.calls[0]?.prompt ?? "";
    expect(provider.calls[0]?.responseSchema).toMatchObject({
      required: ["pageTypes", "pagination", "duplicatePolicy", "missingFieldPolicy", "examples", "confidence"]
    });
    expect(prompt).toContain("Return exactly one complete JSON object matching the supplied response schema");
    expect(prompt).toContain("Do not output Markdown, code fences, prose");
  });

  it("preserves a complete valid proposal unchanged through structural validation", async () => {
    const { service } = await fixture(validProposal);

    const plan = await service.generate("schema-1");

    expect(plan.pageTypes[0]?.pageType).toBe(validProposal.pageTypes[0]?.pageType);
    expect(plan.pagination).toEqual(validProposal.pagination);
    expect(plan.duplicatePolicy).toEqual(validProposal.duplicatePolicy);
    expect(plan.missingFieldPolicy).toBe(validProposal.missingFieldPolicy);
    expect(plan.examples).toEqual(validProposal.examples);
    expect(plan.provenance.promptVersion).toBe("extraction-plan-v4-grounded-main-content");
  });

  it("supplies bounded redacted main-content DOM evidence to the provider", async () => {
    const { provider, service } = await fixture();
    await service.generate("schema-1");
    const input = provider.calls[0]!.input as { samples: Array<{ structuralDom: unknown; semanticText: string }> };
    expect(input.samples[0]!.structuralDom).toEqual(expect.arrayContaining([expect.objectContaining({ selectorHint: "article.record" })]));
    expect(input.samples[0]!.semanticText).not.toContain("secret()");
  });

  it("selects at most three primary-content templates with capped record and field examples", async () => {
    const recordTemplate = '<nav><a>Navigation</a></nav><main><article class="record"><h2 class="title">Item</h2><p class="price">$1</p><a href="/item">Detail</a><span>Extra</span></article><article class="record"><h2 class="title">Item 2</h2><p class="price">$2</p></article><article class="record"><h2 class="title">Item 3</h2><p class="price">$3</p></article><article class="record"><h2 class="title">Item 4</h2><p class="price">$4</p></article></main>';
    const productTemplate = '<aside class="sidebar">Chrome</aside><main><section class="product"><h2 class="title">Product</h2><p class="price">$5</p><a href="/product">Detail</a><span>Extra</span></section></main>';
    const { provider, service } = await fixture(validProposal, [recordTemplate, productTemplate]);
    await service.generate("schema-1");

    const input = provider.calls[0]!.input as { samples: Array<{ semanticText: string; structuralDom: Array<{ fieldLocations: unknown[] }> }> };
    expect(input.samples).toHaveLength(2);
    expect(input.samples.every((sample) => sample.semanticText.length <= 600 && !sample.semanticText.includes("Navigation") && !sample.semanticText.includes("Chrome"))).toBe(true);
    expect(input.samples.every((sample) => sample.structuralDom.length <= 3 && sample.structuralDom.every((record) => record.fieldLocations.length <= 3))).toBe(true);
  });

  it("rejects syntactically valid selectors when deterministic evidence has no matches", async () => {
    const proposal = { ...validProposal, pageTypes: [{ ...validProposal.pageTypes[0], recordSelector: ".missing" }] };
    const { service, extractions } = await fixture(proposal);
    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");
    expect(service.getLastValidationDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ validationRuleId: "RECORD_SELECTOR_NO_SAMPLE_MATCH" })]));
    expect(await extractions.findLatestPlanForDataset("dataset-1")).toBeNull();
  });

  it("rejects static navigation selectors before deterministic execution", async () => {
    const proposal = { ...validProposal, pageTypes: [{ ...validProposal.pageTypes[0], recordSelector: ".category", fields: [{ ...validProposal.pageTypes[0].fields[0], selector: ".category" }, validProposal.pageTypes[0].fields[1]] }] };
    const content = '<nav><a class="category">Books</a></nav><main><article class="record"><h2 class="title">Item</h2><p class="price">$1</p></article></main>';
    const { service } = await fixture(proposal, content);
    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");
    expect(service.getLastValidationDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ validationRuleId: "RECORD_SELECTOR_NAVIGATION_ONLY" })]));
  });

  it.each(["pageTypes", "pagination", "duplicatePolicy", "missingFieldPolicy", "examples", "confidence"] as const)("reports a precise diagnostic when required top-level property %s is absent", async (property) => {
    const incomplete = { ...validProposal } as Record<string, unknown>;
    delete incomplete[property];
    const { service, extractions } = await fixture(incomplete);

    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");

    expect(service.getLastValidationDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        validationRuleId: "TOP_LEVEL_PROPERTY_REQUIRED",
        affectedRule: property,
        explanation: expect.stringContaining(`Missing required top-level property "${property}".`),
        suggestedCorrection: expect.stringContaining(`"${property}"`)
      })
    ]));
    expect(await extractions.findLatestPlanForDataset("dataset-1")).toBeNull();
  });

  it.each([
    ["markdown", "## Extraction plan\n{}", "PROVIDER_OUTPUT_MARKDOWN"],
    ["code fences", "```json\n{}\n```", "PROVIDER_OUTPUT_CODE_FENCE"],
    ["explanatory prose", "Here is the requested extraction plan: {}", "PROVIDER_OUTPUT_EXPLANATORY_PROSE"]
  ])("rejects %s instead of interpreting it as an extraction plan", async (_label, response, rule) => {
    const { service, extractions } = await fixture(response);

    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");

    expect(service.getLastValidationDiagnostics()).toEqual([expect.objectContaining({ validationRuleId: rule, category: "provider_response" })]);
    expect(await extractions.findLatestPlanForDataset("dataset-1")).toBeNull();
  });

  it("reports every absent property for a partially complete proposal", async () => {
    const partial = { pageTypes: validProposal.pageTypes, confidence: validProposal.confidence };
    const { service } = await fixture(partial);

    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");

    const missing = service.getLastValidationDiagnostics().filter((diagnostic) => diagnostic.validationRuleId === "TOP_LEVEL_PROPERTY_REQUIRED").map((diagnostic) => diagnostic.affectedRule);
    expect(missing).toEqual(["pagination", "duplicatePolicy", "missingFieldPolicy", "examples"]);
  });

  it.each([
    ["unknown schema field", { ...validProposal, pageTypes: [{ ...validProposal.pageTypes[0], fields: [{ ...validProposal.pageTypes[0].fields[0], field: "unknown" }, validProposal.pageTypes[0].fields[1]] }] }],
    ["unsupported selector", { ...validProposal, pageTypes: [{ ...validProposal.pageTypes[0], recordSelector: "//article" }] }],
    ["missing evidence", { ...validProposal, pageTypes: [{ ...validProposal.pageTypes[0], fields: [{ ...validProposal.pageTypes[0].fields[0], evidenceReference: "snapshot:missing" }, validProposal.pageTypes[0].fields[1]] }] }],
    ["invalid structured proposal", { ...validProposal, pageTypes: [{ pageType: "path:catalog", classificationEvidence: ["snapshot:snapshot-1"], fields: [] }] }]
  ])("rejects %s before plan persistence", async (_name, response) => {
    const { service, extractions } = await fixture(response);
    await expect(service.generate("schema-1")).rejects.toThrow();
    expect(await extractions.findLatestPlanForDataset("dataset-1")).toBeNull();
  });

  it("collects every deterministic validation failure without persisting or executing an invalid plan", async () => {
    const invalidProposal = {
      ...validProposal,
      pageTypes: [{
        pageType: "path:catalog",
        classificationEvidence: ["snapshot:missing"],
        collectionSelector: "javascript:alert(1)",
        recordSelector: "[",
        fields: [
          { field: "unknown", selector: "//article", source: "html", transforms: ["javascript"], required: true, evidenceReference: "snapshot:missing" },
          { field: "title", selector: ".title", source: "attribute", transforms: [], required: true, evidenceReference: "snapshot:missing" }
        ]
      }],
      pagination: { strategy: "none", evidenceReference: "snapshot:missing" },
      duplicatePolicy: { strategy: "deduplicate", keyFields: ["unknown"] },
      examples: [{ snapshotId: "snapshot:missing", recordIndex: 0, evidenceReference: "snapshot:missing" }]
    };
    const { service, extractions } = await fixture(invalidProposal);

    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");

    const diagnostics = service.getLastValidationDiagnostics();
    expect(diagnostics.map((diagnostic) => diagnostic.validationRuleId)).toEqual(expect.arrayContaining([
      "EVIDENCE_UNKNOWN",
      "SELECTOR_PROHIBITED",
      "SELECTOR_UNSUPPORTED",
      "SCHEMA_FIELD_UNKNOWN",
      "ATTRIBUTE_NAME_REQUIRED",
      "HTML_EXTRACTION_DISABLED",
      "TRANSFORM_DISALLOWED",
      "REQUIRED_SCHEMA_FIELD_OMITTED",
      "DUPLICATE_KEY_FIELD_UNKNOWN",
      "EXAMPLE_SNAPSHOT_UNKNOWN"
    ]));
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ validationRuleId: "SCHEMA_FIELD_UNKNOWN", field: "unknown", selector: "//article", evidenceReference: "snapshot:missing", severity: "error" }),
      expect.objectContaining({ validationRuleId: "HTML_EXTRACTION_DISABLED", suggestedCorrection: expect.any(String) })
    ]));
    expect(await extractions.findLatestPlanForDataset("dataset-1")).toBeNull();
  });

  it("reports every structured proposal failure as a diagnostic", async () => {
    const { service, extractions } = await fixture({ ...validProposal, pageTypes: [{ pageType: "path:catalog", classificationEvidence: [], fields: [] }] });

    await expect(service.generate("schema-1")).rejects.toThrow("Extraction plan validation failed with");

    expect(service.getLastValidationDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ validationRuleId: "EVIDENCE_REQUIRED", category: "evidence", severity: "error" }),
      expect.objectContaining({ validationRuleId: "STRUCTURE_INVALID", category: "structure", severity: "error" })
    ]));
    expect(await extractions.findLatestPlanForDataset("dataset-1")).toBeNull();
  });
});
