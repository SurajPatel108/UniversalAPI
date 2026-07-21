import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AIProvider } from "../ai/providers/ai-provider.js";
import { ApplicationError } from "../core/errors.js";
import type { DiscoveryRepository } from "../database/discovery-repository.js";
import type { SchemaRepository } from "../database/schema-repository.js";
import type { DatasetSchema } from "../models/schema.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";

const proposalSchema = z.object({ schema: z.object({ type: z.literal("object"), properties: z.record(z.unknown()), required: z.array(z.string()).default([]) }), fields: z.array(z.object({ name: z.string().min(1), type: z.string().min(1), required: z.boolean(), confidence: z.number().min(0).max(1), evidence: z.string().min(1) })), rationale: z.string().min(1), confidence: z.number().min(0).max(1) });

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
  };
}

export class SchemaUnderstandingService {
  private lastRunMetadata: SchemaGenerationMetadata | null = null;
  constructor(private readonly discoveries: DiscoveryRepository, private readonly schemas: SchemaRepository, private readonly provider: AIProvider | null) {}
  async analyze(snapshotCollectionId: string): Promise<DatasetSchema> {
    const collection = await this.discoveries.findSnapshotCollection(snapshotCollectionId);
    if (!collection) throw new ApplicationError("not_found", "Snapshot collection not found");
    const revision = this.collectionRevision(collection);
    const cached = await this.schemas.findByCollectionRevision(revision);
    if (cached) return cached;
    const samples = this.samples(collection);
    let proposed: { schema: { type: "object"; properties: Record<string, unknown>; required: string[] }; fields: Array<{ name: string; type: string; required: boolean; confidence: number; evidence: string }>; rationale: string; confidence: number };
    try {
      proposed = this.provider ? proposalSchema.parse(await this.provider.generateStructured({ operation: "dataset_schema", prompt: `Infer only the requested JSON schema from the representative redacted samples. Return only a JSON object matching this exact schema:\n{"schema":{"type":"object","properties":{},"required":[]},"fields":[{"name":"string","type":"string","required":true,"confidence":0.0,"evidence":"string"}],"rationale":"string","confidence":0.0}\nDo not summarize data, explain the website, or write prose.`, input: { snapshotCollectionId: collection.id, samples } })) : { schema: { type: "object" as const, properties: {}, required: [] }, fields: [], rationale: "No AI provider is configured; deterministic empty schema fallback.", confidence: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI provider request failed";
      console.error("[schema-understanding] AI generation failed", { error: message });
      throw new ApplicationError("internal_error", `Schema generation failed: ${message}`, true);
    }
    this.lastRunMetadata = {
      provider: this.provider?.name ?? "deterministic-fallback",
      model: this.provider?.model ?? "deterministic-fallback",
      promptTokens: this.provider?.getLastUsage?.()?.promptTokens ?? 0,
      completionTokens: this.provider?.getLastUsage?.()?.completionTokens ?? 0,
      totalTokens: this.provider?.getLastUsage?.()?.totalTokens ?? 0,
      schemaPreview: { fields: proposed.fields, rationale: proposed.rationale, confidence: proposed.confidence }
    };
    const artifact: DatasetSchema = { id: randomUUID(), datasetId: collection.datasetId, snapshotCollectionId: collection.id, collectionRevision: revision, schema: proposed.schema, fields: proposed.fields, rationale: proposed.rationale, sampleSnapshotIds: samples.map((sample) => sample.snapshotId), provenance: { model: this.provider?.model ?? "deterministic-fallback", promptVersion: "dataset-schema-v1", confidence: proposed.confidence }, createdAt: new Date() };
    await this.schemas.save(artifact);
    return artifact;
  }
  getLastRunMetadata(): SchemaGenerationMetadata | null { return this.lastRunMetadata; }
  private collectionRevision(collection: SnapshotCollection): string { return createHash("sha256").update(JSON.stringify({ id: collection.id, entries: collection.entries.map((entry) => [entry.url, entry.snapshot?.fingerprint ?? entry.outcome]) })).digest("hex"); }
  private samples(collection: SnapshotCollection): Array<{ snapshotId: string; url: string; excerpt: string }> { return collection.entries.filter((entry) => entry.outcome === "captured" && entry.snapshot && entry.content).slice(0, 3).map((entry) => ({ snapshotId: entry.snapshot!.id, url: entry.url, excerpt: this.representativeText(this.redact(entry.content!)) })); }
  private representativeText(content: string): string { return content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_200); }
  private redact(content: string): string { return content.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED_PHONE]").replace(/\s+/g, " ").trim().slice(0, 4_000); }
}
