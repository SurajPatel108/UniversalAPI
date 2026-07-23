import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { z } from "zod";
import { AIProviderError, type AIProvider, type StructuredJsonSchema } from "../ai/providers/ai-provider.js";
import { ApplicationError } from "../core/errors.js";
import type { DiscoveryRepository } from "../database/discovery-repository.js";
import type { ExtractionRepository } from "../database/extraction-repository.js";
import type { SchemaRepository } from "../database/schema-repository.js";
import type { ExecutionPolicy, ExtractionFieldRule, ExtractionPlan, ExtractionPlanProvenance, ExtractionTransform } from "../models/extraction.js";
import type { DatasetSchema } from "../models/schema.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";

export const EXTRACTION_PLAN_PROMPT_VERSION = "extraction-plan-v4-grounded-main-content";
export const EXTRACTION_PLAN_PREPROCESSING_VERSION = "extraction-plan-main-content-dom-v3";
export const EXTRACTION_PLAN_SAMPLING_VERSION = "extraction-plan-stratified-samples-v2";

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

const extractionPlanResponseSchema: StructuredJsonSchema = {
  type: "object",
  properties: {
    pageTypes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pageType: { type: "string" },
          classificationEvidence: { type: "array", items: { type: "string" } },
          collectionSelector: { type: "string" },
          recordSelector: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                selector: { type: "string" },
                source: { type: "string", enum: ["text", "attribute", "html"] },
                attribute: { type: "string" },
                transforms: { type: "array", items: { type: "string" } },
                defaultValue: {},
                required: { type: "boolean" },
                evidenceReference: { type: "string" }
              },
              required: ["field", "selector", "source", "transforms", "required", "evidenceReference"]
            }
          }
        },
        required: ["pageType", "classificationEvidence", "recordSelector", "fields"]
      }
    },
    pagination: { type: "object", properties: { strategy: { type: "string", enum: ["none", "snapshot_pages"] }, evidenceReference: { type: "string" } }, required: ["strategy", "evidenceReference"] },
    duplicatePolicy: { type: "object", properties: { strategy: { type: "string", enum: ["allow", "deduplicate", "reject"] }, keyFields: { type: "array", items: { type: "string" } } }, required: ["strategy", "keyFields"] },
    missingFieldPolicy: { type: "string", enum: ["allow", "reject_record", "use_default"] },
    examples: { type: "array", items: { type: "object", properties: { snapshotId: { type: "string" }, recordIndex: { type: "integer", minimum: 0 }, evidenceReference: { type: "string" } }, required: ["snapshotId", "recordIndex", "evidenceReference"] } },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["pageTypes", "pagination", "duplicatePolicy", "missingFieldPolicy", "examples", "confidence"]
};

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

    const generationRequest = (maxOutputTokens: number) => ({
        operation: "extraction_plan" as const,
        promptVersion: EXTRACTION_PLAN_PROMPT_VERSION,
        responseSchema: extractionPlanResponseSchema,
        maxOutputTokens,
        prompt: this.prompt(),
        input: {
          schema: { id: schema.id, version: schema.collectionRevision, fields: schema.fields.map((field) => ({ name: field.name, type: field.type, required: field.required, evidence: field.evidence })) },
          samples: context.samples,
          deterministicMetadata: context.deterministicMetadata,
          executionPolicy: this.executionPolicy
        }
      });
    let rawProposal: unknown;
    try {
      rawProposal = await this.provider.generateStructured(generationRequest(2_048));
    } catch (error) {
      if (this.isRetryableTruncation(error)) {
        try {
          rawProposal = await this.provider.generateStructured(generationRequest(4_096));
        } catch (retryError) {
          throw this.providerFailure(retryError);
        }
      } else {
        throw this.providerFailure(error);
      }
    }

    const responseDiagnostics = this.providerResponseDiagnostics(rawProposal);
    if (responseDiagnostics.length > 0) this.rejectProposal(rawProposal, responseDiagnostics);
    const topLevelDiagnostics = this.missingTopLevelPropertyDiagnostics(rawProposal);
    const parsedProposal = proposalSchema.safeParse(rawProposal);
    if (!parsedProposal.success) this.rejectProposal(rawProposal, [...topLevelDiagnostics, ...this.structureDiagnostics(parsedProposal.error, new Set(topLevelDiagnostics.flatMap((diagnostic) => diagnostic.affectedRule ? [diagnostic.affectedRule] : [])))]);
    const proposal = parsedProposal.data;
    const validationDiagnostics = [
      ...this.validateProposal(proposal, schema, context.evidenceReferences, context.sampleSnapshotIds),
      ...this.validateSampleMatches(proposal, context.capturedEntries)
    ];
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

  private isRetryableTruncation(error: unknown): boolean {
    return error instanceof AIProviderError && error.diagnostic.operation === "extraction_plan" && error.diagnostic.failureType === "truncated_response";
  }
  private providerFailure(error: unknown): ApplicationError {
    const message = error instanceof Error ? error.message : "AI provider request failed";
    return new ApplicationError("extraction_plan_generation_failed", `Extraction plan generation failed: ${message}`, true);
  }

  private async requireSchema(schemaId: string): Promise<DatasetSchema> { const schema = await this.schemas.findById(schemaId); if (!schema) throw new ApplicationError("not_found", "Schema not found"); return schema; }
  private async requireCollection(snapshotCollectionId: string): Promise<SnapshotCollection> { const collection = await this.discoveries.findSnapshotCollection(snapshotCollectionId); if (!collection) throw new ApplicationError("not_found", "Snapshot collection not found"); return collection; }

  private context(collection: SnapshotCollection, schema: DatasetSchema) {
    const captured = collection.entries.filter((entry) => entry.outcome === "captured" && entry.snapshot && entry.content).sort((left, right) => left.url.localeCompare(right.url) || left.snapshot!.id.localeCompare(right.snapshot!.id));
    const samples = this.representativeTemplateSamples(captured).map((entry) => ({
      snapshotId: entry.snapshot!.id,
      url: entry.url,
      pageType: this.pageType(entry.url),
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

  private representativeTemplateSamples<T extends SnapshotCollection["entries"][number]>(captured: readonly T[]): readonly T[] {
    const samples: T[] = [];
    const seenTemplates = new Set<string>();
    for (const entry of captured) {
      const template = this.templateSignature(entry.content ?? "");
      if (!seenTemplates.has(template)) { samples.push(entry); seenTemplates.add(template); }
      if (samples.length === 3) return samples;
    }
    return samples;
  }

  private prompt(): string {
    return `Return exactly one complete JSON object matching the supplied response schema. Do not output Markdown, code fences, prose, comments, code, JavaScript, XPath, regular expressions, executable expressions, or HTML parsing instructions.

Use only approved schema fields and the bounded primary-content samples. Each sample contains its pageType, snapshotId, evidenceReference, semanticText, and structuralDom. Every classificationEvidence and field evidenceReference must use a sample evidenceReference; every example snapshotId must be a supplied sample snapshotId. Plan only primary-content record containers, never navigation, sidebars, breadcrumbs, headers, footers, menus, or pages that cannot add dataset records.

Use only static CSS selectors supported by Cheerio. Field source must be text, attribute, or html; use html only when executionPolicy.allowHtmlExtraction is true. Attribute source requires attribute. Every transforms array must be present and contain only executionPolicy.allowedTransforms. Use only executionPolicy-safe duplicate, missing-field, and collection behavior. The deterministic validator is authoritative: do not omit required response-schema properties or invent fields, evidence, selectors, transforms, or defaults.`;
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
      let collectionMatched = !pageType.collectionSelector;
      const fieldMatches = new Set<string>();
      for (const entry of evidenceEntries) {
        const $ = cheerio.load(entry.content!);
        const allRecords = $(pageType.recordSelector).toArray();
        const navigation = this.navigationNodes($);
        const navigationRecords = navigation.find(pageType.recordSelector).toArray();
        if (allRecords.length > 0 && navigationRecords.length === allRecords.length) navigationOnly = true;
        this.removeChrome($);
        const root = this.mainContent($);
        const collections = pageType.collectionSelector ? (root.is(pageType.collectionSelector) ? root.toArray() : root.find(pageType.collectionSelector).toArray()) : root.toArray();
        if (collections.length > 0) collectionMatched = true;
        const records = collections.flatMap((container) => {
          const node = $(container);
          return node.is(pageType.recordSelector) ? node.toArray() : node.find(pageType.recordSelector).toArray();
        });
        if (records.length > 0) recordMatched = true;
        for (const record of records) {
          for (const field of pageType.fields) {
            const node = $(record);
            if ((node.is(field.selector) ? node : node.find(field.selector)).length > 0) fieldMatches.add(field.field);
          }
        }
      }
      if (!collectionMatched && pageType.collectionSelector) diagnostics.push({ validationRuleId: "COLLECTION_SELECTOR_NO_SAMPLE_MATCH", category: "sample_validation", severity: "error", affectedRule: pageType.pageType, selector: pageType.collectionSelector, explanation: `Collection selector "${pageType.collectionSelector}" did not match primary content in supplied evidence.`, suggestedCorrection: "Use a collection selector observed in the supplied primary-content structural evidence." });
      if (navigationOnly && !recordMatched) diagnostics.push({ validationRuleId: "RECORD_SELECTOR_NAVIGATION_ONLY", category: "sample_validation", severity: "error", affectedRule: pageType.pageType, selector: pageType.recordSelector, explanation: `Record selector "${pageType.recordSelector}" matches only excluded navigation structures in its evidence samples.`, suggestedCorrection: "Choose a repeated primary-content record container instead of navigation, sidebar, breadcrumb, header, or footer content." });
      else if (!recordMatched) diagnostics.push({ validationRuleId: "RECORD_SELECTOR_NO_SAMPLE_MATCH", category: "sample_validation", severity: "error", affectedRule: pageType.pageType, selector: pageType.recordSelector, explanation: `Record selector "${pageType.recordSelector}" did not match any supplied evidence snapshot.`, suggestedCorrection: "Use a record selector observed in the supplied main-content structural evidence." });
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
    return this.mainContent($).text().replace(/\s+/g, " ").trim().slice(0, 600);
  }
  private pathShape(value: string): string { try { return new URL(value).pathname.replace(/\d+/g, ":id").replace(/\/+/g, "/") || "/"; } catch { return value; } }
  private structuralDom(content: string): readonly { readonly selectorHint: string; readonly occurrences: number; readonly fieldLocations: readonly { readonly selectorHint: string; readonly text: string; readonly attributes: readonly string[] }[] }[] {
    const $ = cheerio.load(content);
    this.removeChrome($);
    const root = this.mainContent($);
    const candidates = root.find("article, [itemtype], [class*=product], [class*=listing], [class*=record]").toArray().slice(0, 3);
    return candidates.map((element) => {
      const selectorHint = this.selectorHint($, element);
      const fieldLocations = $(element).find("a, h1, h2, h3, p, span, time, img").toArray().slice(0, 3).map((child) => ({
        selectorHint: this.selectorHint($, child),
        text: $(child).text().replace(/\s+/g, " ").trim().slice(0, 100),
        attributes: Object.keys(child.attribs ?? {}).filter((name) => ["href", "src", "title", "alt", "datetime", "content"].includes(name)).sort()
      }));
      return { selectorHint, occurrences: root.find(selectorHint).length, fieldLocations };
    });
  }
  private templateSignature(content: string): string {
    const $ = cheerio.load(content);
    this.removeChrome($);
    const selectors = this.mainContent($)
      .find("article, [itemtype], [class*=product], [class*=listing], [class*=record]")
      .toArray()
      .slice(0, 3)
      .map((element) => this.selectorHint($, element));
    return [...new Set(selectors)].sort().join("|") || "no-primary-record-candidates";
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
