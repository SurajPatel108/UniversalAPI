import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { z } from "zod";
import {
  AIProviderError,
  type AIProvider,
  type AIProviderFailureDiagnostic,
  type StructuredJsonSchema
} from "../ai/providers/ai-provider.js";
import { ApplicationError } from "../core/errors.js";
import type { DiscoveryRepository } from "../database/discovery-repository.js";
import type { SchemaRepository } from "../database/schema-repository.js";
import type { DatasetSchema } from "../models/schema.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";

const proposalSchema = z.object({ schema: z.object({ type: z.literal("object"), properties: z.record(z.unknown()), required: z.array(z.string()).default([]) }), fields: z.array(z.object({ name: z.string().min(1), type: z.string().min(1), required: z.boolean(), confidence: z.number().min(0).max(1), evidence: z.string().min(1) })), rationale: z.string().min(1), confidence: z.number().min(0).max(1) });
const schemaPromptVersion = "dataset-schema-main-content-v3";
const schemaPreprocessingVersion = "schema-main-content-redaction-v3";
const schemaSamplingVersion = "schema-stratified-samples-v2";
const schemaProposalResponseSchema: StructuredJsonSchema = {
  type: "object",
  properties: {
    schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["object"] },
        properties: { type: "object", additionalProperties: { type: "object" } },
        required: { type: "array", items: { type: "string" } }
      },
      required: ["type", "properties", "required"]
    },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          required: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string" }
        },
        required: ["name", "type", "required", "confidence", "evidence"]
      }
    },
    rationale: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["schema", "fields", "rationale", "confidence"]
};

/**
 * These names describe the transport/provenance envelope supplied to schema
 * generation. They are never fields of the dataset represented by a page.
 */
const reservedMetadataFieldNames = new Set([
  "snapshotcollectionid",
  "snapshotid",
  "datasetid",
  "sourceid",
  "sourcepageurl",
  "url",
  "excerpt",
  "content",
  "semanticpagecontent",
  "nonschemametadata",
  "transportmetadata",
  "sampleevidence",
  "evidence",
  "evidencereference",
  "metadata",
  "collectionrevision",
  "provenance"
]);

export interface SchemaGenerationMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly schemaPreview: {
    readonly fields: Array<{ readonly name: string; readonly type: string; readonly required: boolean; readonly confidence: number; readonly evidence: string }>;
    readonly rationale: string;
    readonly confidence: number;
  } | null;
  readonly failure: SchemaGenerationFailureDiagnostic | null;
}

export interface SchemaGenerationFailureDiagnostic extends AIProviderFailureDiagnostic {
  readonly stage: "Schema Generation";
}

export class SchemaUnderstandingService {
  private lastRunMetadata: SchemaGenerationMetadata | null = null;
  constructor(private readonly discoveries: DiscoveryRepository, private readonly schemas: SchemaRepository, private readonly provider: AIProvider | null) {}
  async analyze(snapshotCollectionId: string): Promise<DatasetSchema> {
    const collection = await this.discoveries.findSnapshotCollection(snapshotCollectionId);
    if (!collection) throw new ApplicationError("not_found", "Snapshot collection not found");
    const revision = this.collectionRevision(collection);
    const cached = await this.schemas.findByCollectionRevision(revision);
    if (cached) {
      this.validateNoReservedMetadataFields(cached.schema, cached.fields);
      return cached;
    }
    const samples = this.samples(collection);
    let proposed: { schema: { type: "object"; properties: Record<string, unknown>; required: string[] }; fields: Array<{ name: string; type: string; required: boolean; confidence: number; evidence: string }>; rationale: string; confidence: number };
    let rawProposal: unknown;
    try {
      rawProposal = this.provider ? await this.provider.generateStructured({
        operation: "dataset_schema",
        promptVersion: schemaPromptVersion,
        responseSchema: schemaProposalResponseSchema,
        prompt: `Infer only the dataset schema represented by supplied main-content semantic evidence. Return only a JSON object matching this exact schema:\n{"schema":{"type":"object","properties":{},"required":[]},"fields":[{"name":"string","type":"string","required":true,"confidence":0.0,"evidence":"snapshot:known-snapshot-id"}],"rationale":"string","confidence":0.0}\nUse only semanticPageContent to infer stable observed dataset fields. Navigation, sidebars, breadcrumbs, headers, footers, transport metadata, provenance, and evidence context are non-schema information and must never become fields. Semantic links, identifiers, slugs, counts, prices, dates, image attributes, and other stable attributes may be proposed only when present in supplied semantic evidence. Every field evidence value must exactly equal one supplied evidenceReference. Never propose transport metadata fields such as snapshotCollectionId, snapshotId, datasetId, sourceId, sourcePageUrl, url, excerpt, content, evidence, metadata, collectionRevision, or provenance. Do not summarize data, explain the website, or write prose.`,
        input: {
          semanticPageContent: samples.map((sample) => sample.content),
          nonSchemaMetadata: {
            snapshotCollectionId: collection.id,
            sampleEvidence: samples.map((sample) => ({ evidenceReference: sample.evidenceReference, snapshotId: sample.snapshotId, sourcePageUrl: sample.url }))
          }
        }
      }) : { schema: { type: "object" as const, properties: {}, required: [] }, fields: [], rationale: "No AI provider is configured; deterministic empty schema fallback.", confidence: 0 };
      proposed = proposalSchema.parse(rawProposal);
    } catch (error) {
      const failure = this.failureDiagnostic(error, rawProposal);
      this.lastRunMetadata = {
        provider: failure.provider,
        model: failure.model,
        promptTokens: failure.usage?.promptTokens ?? 0,
        completionTokens: failure.usage?.completionTokens ?? 0,
        totalTokens: failure.usage?.totalTokens ?? 0,
        schemaPreview: null,
        failure
      };
      console.error("[schema-understanding] AI generation failed", { provider: failure.provider, model: failure.model, failureType: failure.failureType, parserError: failure.parserError, responseLength: failure.responseLength, promptVersion: failure.promptVersion });
      throw new ApplicationError("ai_provider_error", "Schema generation failed because the AI provider returned unusable structured output", error instanceof AIProviderError ? error.retryable : false);
    }
    this.validateNoReservedMetadataFields(proposed.schema, proposed.fields);
    this.lastRunMetadata = {
      provider: this.provider?.name ?? "deterministic-fallback",
      model: this.provider?.model ?? "deterministic-fallback",
      promptTokens: this.provider?.getLastUsage?.()?.promptTokens ?? 0,
      completionTokens: this.provider?.getLastUsage?.()?.completionTokens ?? 0,
      totalTokens: this.provider?.getLastUsage?.()?.totalTokens ?? 0,
      schemaPreview: { fields: proposed.fields, rationale: proposed.rationale, confidence: proposed.confidence },
      failure: null
    };
    const artifact: DatasetSchema = { id: randomUUID(), datasetId: collection.datasetId, snapshotCollectionId: collection.id, collectionRevision: revision, schema: proposed.schema, fields: proposed.fields, rationale: proposed.rationale, sampleSnapshotIds: samples.map((sample) => sample.snapshotId), provenance: { model: this.provider?.model ?? "deterministic-fallback", promptVersion: schemaPromptVersion, confidence: proposed.confidence }, createdAt: new Date() };
    await this.schemas.save(artifact);
    return artifact;
  }
  getLastRunMetadata(): SchemaGenerationMetadata | null { return this.lastRunMetadata; }
  private failureDiagnostic(error: unknown, rawProposal: unknown): SchemaGenerationFailureDiagnostic {
    if (error instanceof AIProviderError) return { stage: "Schema Generation", ...error.diagnostic };
    const rawResponse = this.serializedProposal(rawProposal);
    const usage = this.provider?.getLastUsage?.() ?? null;
    return {
      stage: "Schema Generation",
      operation: "dataset_schema",
      provider: this.provider?.name ?? "deterministic-fallback",
      model: this.provider?.model ?? "deterministic-fallback",
      failureType: error instanceof z.ZodError ? "invalid_envelope" : "provider_exception",
      parserError: error instanceof Error ? error.message : "AI provider request failed",
      responseLength: rawResponse?.length ?? 0,
      promptVersion: schemaPromptVersion,
      rawResponse,
      finishReason: null,
      usage
    };
  }
  private serializedProposal(value: unknown): string | null {
    if (value === undefined) return null;
    try { return JSON.stringify(value); } catch { return "[unserializable provider response]"; }
  }
  private collectionRevision(collection: SnapshotCollection): string { return createHash("sha256").update(JSON.stringify({ id: collection.id, schemaPromptVersion, schemaPreprocessingVersion, schemaSamplingVersion, entries: collection.entries.map((entry) => [entry.url, entry.snapshot?.fingerprint ?? entry.outcome]) })).digest("hex"); }
  private samples(collection: SnapshotCollection): Array<{ snapshotId: string; url: string; evidenceReference: string; content: string }> {
    const captured = collection.entries.filter((entry) => entry.outcome === "captured" && entry.snapshot && entry.content).sort((left, right) => left.url.localeCompare(right.url) || left.snapshot!.id.localeCompare(right.snapshot!.id));
    const selected: typeof captured = [];
    const seenShapes = new Set<string>();
    for (const entry of captured) {
      const shape = this.pathShape(entry.url);
      if (!seenShapes.has(shape)) { selected.push(entry); seenShapes.add(shape); }
      if (selected.length === 3) break;
    }
    for (const entry of captured) {
      if (!selected.includes(entry)) selected.push(entry);
      if (selected.length === 3) break;
    }
    return selected.map((entry) => ({
      snapshotId: entry.snapshot!.id,
      url: entry.url,
      evidenceReference: `snapshot:${entry.snapshot!.id}`,
      content: this.representativeText(this.redact(entry.content!))
    }));
  }
  private validateNoReservedMetadataFields(schema: { readonly properties: Record<string, unknown>; readonly required: readonly string[] }, fields: readonly { readonly name: string }[]): void {
    const names = [...Object.keys(schema.properties), ...schema.required, ...fields.map((field) => field.name)];
    const reserved = [...new Set(names.filter((name) => reservedMetadataFieldNames.has(this.normalizedFieldName(name))))];
    if (reserved.length > 0) throw new ApplicationError("invalid_schema", `Schema proposal contains reserved metadata field(s): ${reserved.join(", ")}`);
  }
  private normalizedFieldName(name: string): string { return name.replace(/[^a-z0-9]/gi, "").toLowerCase(); }
  private pathShape(value: string): string { try { return new URL(value).pathname.replace(/\d+/g, ":id").replace(/\/+/g, "/") || "/"; } catch { return value; } }
  private representativeText(content: string): string {
    const $ = cheerio.load(content);
    this.removeChrome($);
    const root = $("main").first().length > 0 ? $("main").first() : $("body").first();
    const text = root.text().replace(/\s+/g, " ").trim().slice(0, 1_000);
    const attributes: string[] = [];
    root.find("a[href], img[src], time[datetime], [id]").each((_index, element) => {
      if (attributes.length >= 24) return false;
      const node = $(element);
      const label = node.text().replace(/\s+/g, " ").trim().slice(0, 80);
      if (node.attr("href")) attributes.push(`link text="${label}" href="${node.attr("href")}"`);
      if (node.attr("src")) attributes.push(`image src="${node.attr("src")}" alt="${node.attr("alt") ?? ""}"`);
      if (node.attr("datetime")) attributes.push(`time datetime="${node.attr("datetime")}"`);
      for (const [name, value] of Object.entries(element.attribs ?? {}).filter(([name]) => name.startsWith("data-")).slice(0, 2)) attributes.push(`attribute ${name}="${String(value).slice(0, 80)}"`);
    });
    return [text, attributes.length > 0 ? `Observed main-content attributes: ${attributes.join("; ")}` : ""].filter(Boolean).join("\n").slice(0, 1_400);
  }
  private removeChrome($: cheerio.CheerioAPI): void {
    $("script, style, nav, aside, header, footer, [role=navigation], [role=banner], [role=contentinfo]").remove();
    $("*").each((_index, element) => {
      const node = $(element);
      if (/(?:nav|menu|sidebar|side_categories|breadcrumb|header|footer)/i.test(`${node.attr("class") ?? ""} ${node.attr("id") ?? ""}`)) node.remove();
    });
  }
  private redact(content: string): string {
    // Preserve document structure until after chrome removal. Truncating raw HTML
    // can leave only a page's header or navigation for the semantic extractor.
    // representativeText applies the bounded provider-facing content limit.
    return content
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED_PHONE]");
  }
}
