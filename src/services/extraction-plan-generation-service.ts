import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AIProvider } from "../ai/providers/ai-provider.js";
import { ApplicationError } from "../core/errors.js";
import type { DiscoveryRepository } from "../database/discovery-repository.js";
import type { ExtractionRepository } from "../database/extraction-repository.js";
import type { SchemaRepository } from "../database/schema-repository.js";
import type { ExecutionPolicy, ExtractionFieldRule, ExtractionPlan, ExtractionPlanProvenance, ExtractionTransform } from "../models/extraction.js";
import type { DatasetSchema } from "../models/schema.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";

export const EXTRACTION_PLAN_PROMPT_VERSION = "extraction-plan-v3-main-content";
export const EXTRACTION_PLAN_PREPROCESSING_VERSION = "extraction-plan-main-content-dom-v2";
export const EXTRACTION_PLAN_SAMPLING_VERSION = "extraction-plan-samples-v1";

export const conservativeExecutionPolicy: ExecutionPolicy = {
  allowHtmlExtraction: false,
  allowMissingFields: false,
  allowDuplicateRecords: false,
  allowPartialCollections: false,
  allowedNormalizers: ["unicode", "whitespace", "type", "enum", "url", "date", "number", "currency", "null_default"],
  allowedTransforms: ["unicode_normalize", "trim", "collapse_whitespace", "to_string", "to_number", "to_boolean", "to_date", "to_currency", "canonical_url", "enum_normalize"],
  maximumExtractionErrors: 0,
  maximumNestedDepth: 2,
  maximumCollectionSize: 1_000
};

const proposalSchema = z.object({
  pageTypes: z.array(z.object({
    pageType: z.string().min(1),
    classificationEvidence: z.array(z.string().min(1)).min(1),
    collectionSelector: z.string().min(1).optional(),
    recordSelector: z.string().min(1),
    fields: z.array(z.object({
      field: z.string().min(1),
      selector: z.string().min(1),
      source: z.enum(["text", "attribute", "html"]),
      attribute: z.string().min(1).optional(),
      transforms: z.array(z.string()),
      defaultValue: z.unknown().optional(),
      required: z.boolean(),
      evidenceReference: z.string().min(1)
    })).min(1)
  })).min(1),
  pagination: z.object({ strategy: z.enum(["none", "snapshot_pages"]), evidenceReference: z.string().min(1) }),
  duplicatePolicy: z.object({ strategy: z.enum(["allow", "deduplicate", "reject"]), keyFields: z.array(z.string().min(1)) }),
  missingFieldPolicy: z.enum(["allow", "reject_record", "use_default"]),
  examples: z.array(z.object({ snapshotId: z.string().min(1), recordIndex: z.number().int().nonnegative(), evidenceReference: z.string().min(1) })).min(1),
  confidence: z.number().min(0).max(1)
});

type ExtractionPlanProposal = z.infer<typeof proposalSchema>;

const requiredTopLevelProperties = ["pageTypes", "pagination", "duplicatePolicy", "missingFieldPolicy", "examples", "confidence"] as const;
const topLevelPropertyTypes: Record<(typeof requiredTopLevelProperties)[number], string> = {
  pageTypes: "array<PageTypeDefinition> (at least one item)",
  pagination: "PaginationDefinition object",
  duplicatePolicy: "DuplicatePolicyDefinition object",
  missingFieldPolicy: 'string enum "allow" | "reject_record" | "use_default"',
  examples: "array<ExampleDefinition> (at least one item)",
  confidence: "number from 0 through 1"
};

export interface ExtractionPlanValidationDiagnostic {
  readonly validationRuleId: string;
  readonly category: "structure" | "provider_response" | "schema" | "selector" | "evidence" | "execution_policy" | "duplicate_policy" | "example" | "sample_validation";
  readonly severity: "error";
  readonly field?: string;
  readonly selector?: string;
  readonly affectedRule?: string;
  readonly evidenceReference?: string;
  readonly explanation: string;
  readonly suggestedCorrection: string;
}

/** A rejected proposal is never persisted; this error carries every deterministic validation failure. */
export class ExtractionPlanValidationError extends ApplicationError {
  constructor(readonly diagnostics: readonly ExtractionPlanValidationDiagnostic[]) {
    super("invalid_extraction_plan", `Extraction plan validation failed with ${diagnostics.length} error(s).`);
    this.name = "ExtractionPlanValidationError";
  }
}

export interface ExtractionPlanGenerationMetadata {
  readonly planId: string;
  readonly generationCacheKey: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly preprocessingVersion: string;
  readonly samplingVersion: string;
  readonly generatedAt: Date;
}

/** Provider-neutral AI planning boundary. It only creates validated declarative plans from persisted artifacts. */
export class ExtractionPlanGenerationService {
  private lastRunMetadata: ExtractionPlanGenerationMetadata | null = null;
  private lastInvalidProposal: unknown | null = null;
  private lastValidationDiagnostics: readonly ExtractionPlanValidationDiagnostic[] = [];

  constructor(
    private readonly discoveries: DiscoveryRepository,
    private readonly schemas: SchemaRepository,
    private readonly extractions: ExtractionRepository,
    private readonly provider: AIProvider | null,
    private readonly executionPolicy: ExecutionPolicy = conservativeExecutionPolicy
  ) {}

  async generate(schemaId: string): Promise<ExtractionPlan> {
    this.lastInvalidProposal = null;
    this.lastValidationDiagnostics = [];
    if (!this.provider) throw new ApplicationError("ai_provider_unavailable", "Extraction plan generation requires a configured AI provider");
    const schema = await this.requireSchema(schemaId);
    const approval = await this.schemas.findApproval(schema.id);
    if (!approval || (approval.status !== "APPROVED" && approval.status !== "AUTO_APPROVED")) throw new ApplicationError("schema_not_approved", "Extraction plan generation requires an approved schema decision");
    if (approval.datasetId !== schema.datasetId || approval.snapshotCollectionId !== schema.snapshotCollectionId || approval.schemaVersion !== schema.collectionRevision) throw new ApplicationError("invalid_schema_approval", "Schema approval decision does not match the schema artifact");
    const collection = await this.requireCollection(schema.snapshotCollectionId);
    if (collection.datasetId !== schema.datasetId) throw new ApplicationError("invalid_schema", "Schema and snapshot collection belong to different datasets");

    const context = this.context(collection, schema);
    const generationCacheKey = this.cacheKey(context.collectionFingerprint, schema, this.provider);
    const cached = await this.extractions.findPlanByGenerationCacheKey(generationCacheKey);
    if (cached) {
      this.lastRunMetadata = this.metadata(cached, cached.createdAt);
      return cached;
    }

    let rawProposal: unknown;
    try {
      rawProposal = await this.provider.generateStructured({
        operation: "extraction_plan",
        prompt: this.prompt(),
        input: {
          schema: { id: schema.id, version: schema.collectionRevision, fields: schema.fields.map((field) => ({ name: field.name, type: field.type, required: field.required, evidence: field.evidence })) },
          samples: context.samples,
          pageClassifications: context.pageClassifications,
          deterministicMetadata: context.deterministicMetadata,
          evidenceReferences: context.evidenceReferences,
          executionPolicy: this.executionPolicy
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI provider request failed";
      throw new ApplicationError("extraction_plan_generation_failed", `Extraction plan generation failed: ${message}`, true);
    }

    const responseDiagnostics = this.providerResponseDiagnostics(rawProposal);
    if (responseDiagnostics.length > 0) this.rejectProposal(rawProposal, responseDiagnostics);
    const topLevelDiagnostics = this.missingTopLevelPropertyDiagnostics(rawProposal);
    const parsedProposal = proposalSchema.safeParse(rawProposal);
    if (!parsedProposal.success) this.rejectProposal(rawProposal, [...topLevelDiagnostics, ...this.structureDiagnostics(parsedProposal.error, new Set(topLevelDiagnostics.flatMap((diagnostic) => diagnostic.affectedRule ? [diagnostic.affectedRule] : [])))]);
    const proposal = parsedProposal.data;
    const validationDiagnostics = this.validateProposal(proposal, schema, context.evidenceReferences, context.sampleSnapshotIds);
    if (validationDiagnostics.length > 0) this.rejectProposal(rawProposal, validationDiagnostics);
    const latest = await this.extractions.findLatestPlanForDataset(schema.datasetId);
    const createdAt = new Date();
    const provenance: ExtractionPlanProvenance = {
      provider: this.provider.name,
      model: this.provider.model,
      promptVersion: EXTRACTION_PLAN_PROMPT_VERSION,
      preprocessingVersion: EXTRACTION_PLAN_PREPROCESSING_VERSION,
      samplingVersion: EXTRACTION_PLAN_SAMPLING_VERSION,
      confidence: proposal.confidence
    };
    const contentFingerprint = this.fingerprint({ proposal, schemaVersion: schema.collectionRevision, executionPolicy: this.executionPolicy, provenance });
    const plan: ExtractionPlan = {
      planId: randomUUID(),
      datasetId: schema.datasetId,
      snapshotCollectionId: schema.snapshotCollectionId,
      schemaId: schema.id,
      schemaVersion: schema.collectionRevision,
      revision: (latest?.revision ?? 0) + 1,
      contentFingerprint,
      generationCacheKey,
      pageTypes: proposal.pageTypes.map((pageType) => ({
        ...pageType,
        fields: pageType.fields.map((field) => ({
          ...field,
          ruleId: this.fingerprint({ pageType: pageType.pageType, field: field.field, selector: field.selector, source: field.source, attribute: field.attribute, evidenceReference: field.evidenceReference })
        })) as readonly ExtractionFieldRule[],
        nested: []
      })),
      pagination: proposal.pagination,
      duplicatePolicy: proposal.duplicatePolicy,
      missingFieldPolicy: proposal.missingFieldPolicy,
      executionPolicy: this.executionPolicy,
      examples: proposal.examples,
      provenance,
      createdAt
    };
    await this.extractions.savePlan(plan);
    this.lastRunMetadata = this.metadata(plan, createdAt);
    return plan;
  }

  getLastRunMetadata(): ExtractionPlanGenerationMetadata | null { return this.lastRunMetadata; }
  getLastValidationDiagnostics(): readonly ExtractionPlanValidationDiagnostic[] { return this.lastValidationDiagnostics; }

  private async requireSchema(schemaId: string): Promise<DatasetSchema> { const schema = await this.schemas.findById(schemaId); if (!schema) throw new ApplicationError("not_found", "Schema not found"); return schema; }
  private async requireCollection(snapshotCollectionId: string): Promise<SnapshotCollection> { const collection = await this.discoveries.findSnapshotCollection(snapshotCollectionId); if (!collection) throw new ApplicationError("not_found", "Snapshot collection not found"); return collection; }

  private context(collection: SnapshotCollection, schema: DatasetSchema) {
    const captured = collection.entries.filter((entry) => entry.outcome === "captured" && entry.snapshot && entry.content).sort((left, right) => left.url.localeCompare(right.url) || left.snapshot!.id.localeCompare(right.snapshot!.id));
    const samples = captured.slice(0, 3).map((entry) => ({
      snapshotId: entry.snapshot!.id,
      url: entry.url,
      semanticText: this.semanticText(entry.content!),
      structuralDom: this.structuralDom(entry.content!),
      evidenceReference: this.evidenceReference(entry.snapshot!.id)
    }));
    const evidenceReferences = samples.map((sample) => sample.evidenceReference);
    return {
      collectionFingerprint: this.fingerprint({ id: collection.id, entries: collection.entries.map((entry) => ({ url: entry.url, outcome: entry.outcome, fingerprint: entry.snapshot?.fingerprint ?? null })) }),
      samples,
      capturedEntries: captured,
      evidenceReferences,
      sampleSnapshotIds: samples.map((sample) => sample.snapshotId),
      pageClassifications: samples.map((sample) => ({ snapshotId: sample.snapshotId, pageType: this.pageType(sample.url), evidenceReference: sample.evidenceReference })),
      deterministicMetadata: {
        datasetId: schema.datasetId,
        snapshotCollectionId: collection.id,
        capturedPageCount: captured.length,
        totalEntryCount: collection.entries.length,
        collectionCompleted: collection.completed,
        schemaFieldNames: schema.fields.map((field) => field.name).sort()
      }
    };
  }

  private prompt(): string {
    return `Return exactly one JSON object. Do not output markdown, explanations, code fences, comments, prose, code, JavaScript, XPath, regular expressions, executable expressions, crawling instructions, or HTML parsing instructions. The output must be a complete declarative ExtractionPlan proposal. Every required property below must be present. Omission of any required property invalidates the proposal. Do not invent a different structure and do not rely on defaults.

Use only the approved schema fields, supplied evidenceReferences, supplied sample snapshot IDs, supplied pageClassifications, deterministic structuralDom evidence inside samples, and supplied executionPolicy. Use only static CSS selectors supported by Cheerio. Every selector and field rule must cite supplied evidence. structuralDom contains bounded redacted main-content hierarchy and candidate field locations; navigation, sidebars, breadcrumbs, headers, and footers are excluded. Plan record boundaries only for primary-content collections. Do not plan a repeated navigation collection or a page that cannot contribute dataset records.

Required top-level properties:
- pageTypes: required array<PageTypeDefinition>; at least one item; no default; empty array is not permitted.
- pagination: required PaginationDefinition object; no default.
- duplicatePolicy: required DuplicatePolicyDefinition object; no default.
- missingFieldPolicy: required string enum "allow", "reject_record", or "use_default"; no default.
- examples: required array<ExampleDefinition>; at least one item; no default; empty array is not permitted.
- confidence: required number from 0 through 1; no default.

PageTypeDefinition:
- pageType: required non-empty string.
- classificationEvidence: required non-empty array<string>; every value must be a supplied evidence reference.
- collectionSelector: optional non-empty static CSS selector; omit it when no collection wrapper is needed; no default.
- recordSelector: required non-empty static CSS selector.
- fields: required non-empty array<FieldDefinition>; empty array is not permitted.

FieldDefinition:
- field: required non-empty string and an approved schema field name.
- selector: required non-empty static CSS selector.
- source: required enum "text", "attribute", or "html". Use "html" only when executionPolicy.allowHtmlExtraction is true.
- attribute: required non-empty string only when source is "attribute"; otherwise omit it; no default.
- transforms: required array<string>; empty array is permitted; include it even when empty; every item must be allowed by executionPolicy.allowedTransforms; no default.
- defaultValue: optional JSON value; omit it when no default is needed; no default.
- required: required boolean.
- evidenceReference: required non-empty string from evidenceReferences.

PaginationDefinition: {"strategy":"none"|"snapshot_pages","evidenceReference":"supplied evidence reference"}. Both properties are required; no defaults.
DuplicatePolicyDefinition: {"strategy":"allow"|"deduplicate"|"reject","keyFields":["approved schema field name"]}. Both properties are required. keyFields may be empty. No defaults.
ExampleDefinition: {"snapshotId":"supplied sample snapshot ID","recordIndex":0,"evidenceReference":"supplied evidence reference"}. All properties are required. examples must contain at least one item.

JSON Schema guidance:
{"type":"object","required":["pageTypes","pagination","duplicatePolicy","missingFieldPolicy","examples","confidence"],"properties":{"pageTypes":{"type":"array","minItems":1,"items":{"type":"object","required":["pageType","classificationEvidence","recordSelector","fields"],"properties":{"pageType":{"type":"string","minLength":1},"classificationEvidence":{"type":"array","minItems":1,"items":{"type":"string"}},"collectionSelector":{"type":"string","minLength":1},"recordSelector":{"type":"string","minLength":1},"fields":{"type":"array","minItems":1,"items":{"type":"object","required":["field","selector","source","transforms","required","evidenceReference"],"properties":{"field":{"type":"string","minLength":1},"selector":{"type":"string","minLength":1},"source":{"enum":["text","attribute","html"]},"attribute":{"type":"string","minLength":1},"transforms":{"type":"array","items":{"type":"string"}},"defaultValue":{},"required":{"type":"boolean"},"evidenceReference":{"type":"string","minLength":1}}}}}}},"pagination":{"type":"object","required":["strategy","evidenceReference"],"properties":{"strategy":{"enum":["none","snapshot_pages"]},"evidenceReference":{"type":"string","minLength":1}}},"duplicatePolicy":{"type":"object","required":["strategy","keyFields"],"properties":{"strategy":{"enum":["allow","deduplicate","reject"]},"keyFields":{"type":"array","items":{"type":"string","minLength":1}}}},"missingFieldPolicy":{"enum":["allow","reject_record","use_default"]},"examples":{"type":"array","minItems":1,"items":{"type":"object","required":["snapshotId","recordIndex","evidenceReference"],"properties":{"snapshotId":{"type":"string","minLength":1},"recordIndex":{"type":"integer","minimum":0},"evidenceReference":{"type":"string","minLength":1}}}},"confidence":{"type":"number","minimum":0,"maximum":1}}}

Complete example with placeholder values:
{"pageTypes":[{"pageType":"path:catalog","classificationEvidence":["snapshot:sample-1"],"collectionSelector":"main.catalog","recordSelector":"article.record","fields":[{"field":"title","selector":"h2.title","source":"text","transforms":["trim"],"required":true,"evidenceReference":"snapshot:sample-1"},{"field":"detailUrl","selector":"a.detail","source":"attribute","attribute":"href","transforms":["canonical_url"],"defaultValue":null,"required":false,"evidenceReference":"snapshot:sample-1"}]}],"pagination":{"strategy":"snapshot_pages","evidenceReference":"snapshot:sample-1"},"duplicatePolicy":{"strategy":"deduplicate","keyFields":["title"]},"missingFieldPolicy":"reject_record","examples":[{"snapshotId":"sample-1","recordIndex":0,"evidenceReference":"snapshot:sample-1"}],"confidence":0.9}`;
  }

  private validateProposal(proposal: ExtractionPlanProposal, schema: DatasetSchema, evidenceReferences: readonly string[], sampleSnapshotIds: readonly string[]): ExtractionPlanValidationDiagnostic[] {
    const diagnostics: ExtractionPlanValidationDiagnostic[] = [];
    const knownFields = new Set(schema.fields.map((field) => field.name));
    const requiredFields = new Set(schema.fields.filter((field) => field.required).map((field) => field.name));
    const proposedFields = new Set<string>();
    const evidence = new Set(evidenceReferences);
    const validateEvidence = (reference: string, context: Omit<ExtractionPlanValidationDiagnostic, "validationRuleId" | "category" | "severity" | "explanation" | "suggestedCorrection"> = {}): void => {
      if (!evidence.has(reference)) diagnostics.push({ validationRuleId: "EVIDENCE_UNKNOWN", category: "evidence", severity: "error", evidenceReference: reference, ...context, explanation: `Evidence reference \"${reference}\" is not present in the deterministic sample set.`, suggestedCorrection: "Use one of the supplied evidence references." });
    };
    for (const pageType of proposal.pageTypes) {
      pageType.classificationEvidence.forEach((reference) => validateEvidence(reference, { affectedRule: pageType.pageType }));
      this.validateSelector(pageType.recordSelector, { affectedRule: pageType.pageType }, diagnostics);
      if (pageType.collectionSelector) this.validateSelector(pageType.collectionSelector, { affectedRule: pageType.pageType }, diagnostics);
      for (const field of pageType.fields) {
        const fieldContext = { field: field.field, selector: field.selector, affectedRule: pageType.pageType, evidenceReference: field.evidenceReference };
        if (!knownFields.has(field.field)) diagnostics.push({ validationRuleId: "SCHEMA_FIELD_UNKNOWN", category: "schema", severity: "error", ...fieldContext, explanation: `Unknown schema field \"${field.field}\".`, suggestedCorrection: "Use a field defined by the approved schema." });
        if (field.source === "attribute" && !field.attribute) diagnostics.push({ validationRuleId: "ATTRIBUTE_NAME_REQUIRED", category: "structure", severity: "error", ...fieldContext, explanation: `Attribute extraction for field \"${field.field}\" does not specify an attribute name.`, suggestedCorrection: "Provide the attribute to read, such as href or content." });
        if (field.source === "html" && !this.executionPolicy.allowHtmlExtraction) diagnostics.push({ validationRuleId: "HTML_EXTRACTION_DISABLED", category: "execution_policy", severity: "error", ...fieldContext, explanation: "HTML extraction is disabled by the execution policy.", suggestedCorrection: "Use text or attribute extraction, or generate the plan under a policy that permits HTML extraction." });
        for (const transform of field.transforms) if (!this.executionPolicy.allowedTransforms.includes(transform as ExtractionTransform)) diagnostics.push({ validationRuleId: "TRANSFORM_DISALLOWED", category: "execution_policy", severity: "error", ...fieldContext, explanation: `Transform \"${transform}\" is not allowed by the execution policy.`, suggestedCorrection: "Use only transforms allowed by the execution policy." });
        this.validateSelector(field.selector, fieldContext, diagnostics);
        validateEvidence(field.evidenceReference, fieldContext);
        proposedFields.add(field.field);
      }
    }
    for (const requiredField of requiredFields) if (!proposedFields.has(requiredField)) diagnostics.push({ validationRuleId: "REQUIRED_SCHEMA_FIELD_OMITTED", category: "schema", severity: "error", field: requiredField, explanation: `Required schema field \"${requiredField}\" has no extraction rule.`, suggestedCorrection: "Add an extraction rule for this required schema field." });
    proposal.duplicatePolicy.keyFields.forEach((field) => { if (!knownFields.has(field)) diagnostics.push({ validationRuleId: "DUPLICATE_KEY_FIELD_UNKNOWN", category: "duplicate_policy", severity: "error", field, explanation: `Duplicate policy references unknown schema field \"${field}\".`, suggestedCorrection: "Use approved schema fields as duplicate keys." }); });
    validateEvidence(proposal.pagination.evidenceReference, { affectedRule: "pagination" });
    proposal.examples.forEach((example) => {
      validateEvidence(example.evidenceReference, { affectedRule: "example", evidenceReference: example.evidenceReference });
      if (!sampleSnapshotIds.includes(example.snapshotId)) diagnostics.push({ validationRuleId: "EXAMPLE_SNAPSHOT_UNKNOWN", category: "example", severity: "error", evidenceReference: example.evidenceReference, affectedRule: "example", explanation: `Example references snapshot \"${example.snapshotId}\", which is not a deterministic sample.`, suggestedCorrection: "Use one of the supplied sample snapshot IDs." });
    });
    return diagnostics;
  }

  private validateSelector(selector: string, context: Omit<ExtractionPlanValidationDiagnostic, "validationRuleId" | "category" | "severity" | "explanation" | "suggestedCorrection" | "selector">, diagnostics: ExtractionPlanValidationDiagnostic[]): void {
    const prohibited = /(?:xpath|javascript:|\beval\b|\bfunction\b|=>|\bwindow\b|\bdocument\b|\bscript\b|\bregex\b|\bregexp\b|\.match\s*\(|^\s*\/|\/\/)/i;
    if (prohibited.test(selector)) {
      diagnostics.push({ validationRuleId: "SELECTOR_PROHIBITED", category: "selector", severity: "error", selector, ...context, explanation: `Selector \"${selector}\" contains an unsupported or executable primitive.`, suggestedCorrection: "Use a static CSS selector supported by Cheerio." });
      return;
    }
    try { cheerio.load("<main><article class=\"record\"><span class=\"name\">value</span></article></main>")(selector); }
    catch { diagnostics.push({ validationRuleId: "SELECTOR_UNSUPPORTED", category: "selector", severity: "error", selector, ...context, explanation: `Selector \"${selector}\" is not supported by deterministic Cheerio parsing.`, suggestedCorrection: "Replace it with a valid static CSS selector supported by Cheerio." }); }
  }

  /** Checks that declarative selectors are grounded in bounded, immutable sample snapshots before persistence. */
  private validateSampleMatches(proposal: ExtractionPlanProposal, entries: readonly SnapshotCollection["entries"][number][]): ExtractionPlanValidationDiagnostic[] {
    const diagnostics: ExtractionPlanValidationDiagnostic[] = [];
    const captured = entries.filter((entry) => entry.snapshot && entry.content);
    for (const pageType of proposal.pageTypes) {
      const evidenceSnapshotIds = new Set(pageType.classificationEvidence.map((reference) => reference.replace(/^snapshot:/, "")));
      const evidenceEntries = captured.filter((entry) => evidenceSnapshotIds.has(entry.snapshot!.id));
      let recordMatched = false;
      let navigationOnly = false;
      const fieldMatches = new Set<string>();
      for (const entry of evidenceEntries) {
        const $ = cheerio.load(entry.content!);
        const allRecords = $(pageType.recordSelector).toArray();
        const navigation = this.navigationNodes($);
        const navigationRecords = navigation.find(pageType.recordSelector).toArray();
        if (allRecords.length > 0) {
          recordMatched = true;
          if (navigationRecords.length === allRecords.length) navigationOnly = true;
        }
        const root = this.mainContent($);
        const records = root.find(pageType.recordSelector).toArray();
        for (const record of records) {
          for (const field of pageType.fields) {
            const node = $(record);
            if ((node.is(field.selector) ? node : node.find(field.selector)).length > 0) fieldMatches.add(field.field);
          }
        }
      }
      if (!recordMatched) diagnostics.push({ validationRuleId: "RECORD_SELECTOR_NO_SAMPLE_MATCH", category: "sample_validation", severity: "error", affectedRule: pageType.pageType, selector: pageType.recordSelector, explanation: `Record selector "${pageType.recordSelector}" did not match any supplied evidence snapshot.`, suggestedCorrection: "Use a record selector observed in the supplied main-content structural evidence." });
      else if (navigationOnly) diagnostics.push({ validationRuleId: "RECORD_SELECTOR_NAVIGATION_ONLY", category: "sample_validation", severity: "error", affectedRule: pageType.pageType, selector: pageType.recordSelector, explanation: `Record selector "${pageType.recordSelector}" matches only excluded navigation structures in its evidence samples.`, suggestedCorrection: "Choose a repeated primary-content record container instead of navigation, sidebar, breadcrumb, header, or footer content." });
      for (const field of pageType.fields.filter((field) => field.required && !fieldMatches.has(field.field))) {
        diagnostics.push({ validationRuleId: "REQUIRED_FIELD_SELECTOR_NO_SAMPLE_MATCH", category: "sample_validation", severity: "error", field: field.field, affectedRule: pageType.pageType, selector: field.selector, evidenceReference: field.evidenceReference, explanation: `Required field selector "${field.selector}" for "${field.field}" did not match a record in supplied evidence.`, suggestedCorrection: "Use a field selector observed within a matching primary-content record." });
      }
    }
    return diagnostics;
  }

  private providerResponseDiagnostics(proposal: unknown): ExtractionPlanValidationDiagnostic[] {
    if (typeof proposal === "string") {
      const output = proposal.trim();
      const rule = output.startsWith("```") ? "PROVIDER_OUTPUT_CODE_FENCE" : output.startsWith("#") || output.startsWith("*") || output.startsWith("-") ? "PROVIDER_OUTPUT_MARKDOWN" : "PROVIDER_OUTPUT_EXPLANATORY_PROSE";
      const label = rule === "PROVIDER_OUTPUT_CODE_FENCE" ? "code fences" : rule === "PROVIDER_OUTPUT_MARKDOWN" ? "markdown" : "explanatory prose";
      return [{ validationRuleId: rule, category: "provider_response", severity: "error", explanation: `Provider output is ${label}, not one JSON object.`, suggestedCorrection: "Return one complete JSON object with no surrounding text or formatting." }];
    }
    if (!this.isRecord(proposal)) return [{ validationRuleId: "PROVIDER_OUTPUT_NOT_OBJECT", category: "provider_response", severity: "error", explanation: "Provider output is not a JSON object.", suggestedCorrection: "Return one complete JSON object matching the ExtractionPlan proposal contract." }];
    return [];
  }

  private missingTopLevelPropertyDiagnostics(proposal: unknown): ExtractionPlanValidationDiagnostic[] {
    if (!this.isRecord(proposal)) return [];
    return requiredTopLevelProperties.filter((property) => !Object.hasOwn(proposal, property) || proposal[property] === undefined).map((property) => ({
      validationRuleId: "TOP_LEVEL_PROPERTY_REQUIRED",
      category: "structure" as const,
      severity: "error" as const,
      affectedRule: property,
      explanation: `Missing required top-level property "${property}". Expected type: ${topLevelPropertyTypes[property]}. The provider returned an incomplete ExtractionPlan.`,
      suggestedCorrection: `Include the required top-level property "${property}" using the exact ExtractionPlan proposal structure.`
    }));
  }

  private structureDiagnostics(error: z.ZodError, topLevelPropertiesAlreadyReported: ReadonlySet<string>): ExtractionPlanValidationDiagnostic[] {
    return error.issues.filter((issue) => !(issue.path.length === 1 && topLevelPropertiesAlreadyReported.has(String(issue.path[0])))).map((issue) => {
      const property = String(issue.path.at(-1) ?? "proposal");
      const rule = property === "evidenceReference" || property === "classificationEvidence" ? "EVIDENCE_REQUIRED" : property === "selector" || property === "recordSelector" ? "SELECTOR_REQUIRED" : "STRUCTURE_INVALID";
      const category = rule === "EVIDENCE_REQUIRED" ? "evidence" : rule === "SELECTOR_REQUIRED" ? "selector" : "structure";
      return { validationRuleId: rule, category, severity: "error", affectedRule: issue.path.join(".") || "proposal", explanation: `Proposal structure is invalid at ${issue.path.join(".") || "the root"}: ${issue.message}.`, suggestedCorrection: "Return a value that matches the required declarative extraction-plan structure." };
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

  private rejectProposal(proposal: unknown, diagnostics: readonly ExtractionPlanValidationDiagnostic[]): never {
    this.lastInvalidProposal = proposal;
    this.lastValidationDiagnostics = diagnostics;
    throw new ExtractionPlanValidationError(diagnostics);
  }

  private semanticText(content: string): string {
    const $ = cheerio.load(content.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED_PHONE]"));
    this.removeChrome($);
    return this.mainContent($).text().replace(/\s+/g, " ").trim().slice(0, 1_200);
  }
  private structuralDom(content: string): readonly { readonly selectorHint: string; readonly occurrences: number; readonly fieldLocations: readonly { readonly selectorHint: string; readonly text: string; readonly attributes: readonly string[] }[] }[] {
    const $ = cheerio.load(content);
    this.removeChrome($);
    const root = this.mainContent($);
    const candidates = root.find("article, [itemtype], [class*=product], [class*=listing], [class*=record]").toArray().slice(0, 8);
    return candidates.map((element) => {
      const selectorHint = this.selectorHint($, element);
      const fieldLocations = $(element).find("a, h1, h2, h3, p, span, time, img").toArray().slice(0, 10).map((child) => ({
        selectorHint: this.selectorHint($, child),
        text: $(child).text().replace(/\s+/g, " ").trim().slice(0, 100),
        attributes: Object.keys(child.attribs ?? {}).filter((name) => ["href", "src", "title", "alt", "datetime", "content"].includes(name)).sort()
      }));
      return { selectorHint, occurrences: root.find(selectorHint).length, fieldLocations };
    });
  }
  private selectorHint($: cheerio.CheerioAPI, element: unknown): string {
    const node = $(element as never);
    const tag = (element as { tagName?: string }).tagName || "div";
    const classes = (node.attr("class") ?? "").split(/\s+/).filter((value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)).slice(0, 3);
    return `${tag}${classes.map((value) => `.${value}`).join("")}`;
  }
  private removeChrome($: cheerio.CheerioAPI): void { $("script, style, nav, aside, header, footer, [role=navigation], [role=banner], [role=contentinfo], [class*=sidebar], [class*=breadcrumb], [class*=menu], [id*=sidebar], [id*=breadcrumb], [id*=menu]").remove(); }
  private mainContent($: cheerio.CheerioAPI) { return $("main").first().length > 0 ? $("main").first() : $("body").first(); }
  private navigationNodes($: cheerio.CheerioAPI) { return $("nav, aside, header, footer, [role=navigation], [role=banner], [role=contentinfo], [class*=sidebar], [class*=breadcrumb], [class*=menu], [id*=sidebar], [id*=breadcrumb], [id*=menu]"); }
  private pageType(url: string): string { try { const segments = new URL(url).pathname.split("/").filter(Boolean); return `path:${segments.slice(0, 2).join("/") || "root"}`; } catch { return "path:unknown"; } }
  private evidenceReference(snapshotId: string): string { return `snapshot:${snapshotId}`; }
  private cacheKey(collectionFingerprint: string, schema: DatasetSchema, provider: AIProvider): string { return this.fingerprint({ collectionFingerprint, preprocessingVersion: EXTRACTION_PLAN_PREPROCESSING_VERSION, samplingVersion: EXTRACTION_PLAN_SAMPLING_VERSION, schemaVersion: schema.collectionRevision, provider: provider.name, model: provider.model, promptVersion: EXTRACTION_PLAN_PROMPT_VERSION }); }
  private fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private metadata(plan: ExtractionPlan, generatedAt: Date): ExtractionPlanGenerationMetadata { return { planId: plan.planId, generationCacheKey: plan.generationCacheKey, provider: plan.provenance.provider, model: plan.provenance.model, promptVersion: plan.provenance.promptVersion, preprocessingVersion: plan.provenance.preprocessingVersion, samplingVersion: plan.provenance.samplingVersion, generatedAt }; }
}
