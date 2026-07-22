import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { ApplicationError } from "../core/errors.js";
import type { DiscoveryRepository } from "../database/discovery-repository.js";
import type { ExtractionRepository } from "../database/extraction-repository.js";
import type { SchemaRepository } from "../database/schema-repository.js";
import type { DatasetSchema } from "../models/schema.js";
import type { ExtractionDiagnostic, ExtractionMetrics, ExtractionPlan, ExtractionResult } from "../models/extraction.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";
import { ExtractionEngine } from "./extraction-engine.js";
import { EvaluationService } from "./evaluation-service.js";

const emptyMetrics: ExtractionMetrics = { pagesProcessed: 0, pagesSucceeded: 0, pagesFailed: 0, recordsExtracted: 0, recordsRejected: 0, fieldsExtracted: 0, missingRequiredFields: 0, duplicatesRemoved: 0, selectorFailures: 0, normalizationFailures: 0, executionDurationMs: 0, snapshotCoveragePercent: 0, pageCoveragePercent: 0, requiredFieldCompletenessPercent: 0, duplicatePercent: 0, schemaInvalidRecords: 0 };

export interface ExtractionExecutionOutcome { readonly result: ExtractionResult; readonly evaluation: import("../models/extraction.js").EvaluationReport; }

/** Coordinates validated deterministic execution and evaluation. It has no AI dependency. */
export class ExtractionExecutionService {
  constructor(private readonly discoveries: DiscoveryRepository, private readonly schemas: SchemaRepository, private readonly extractions: ExtractionRepository, private readonly engine = new ExtractionEngine(), private readonly evaluator = new EvaluationService()) {}

  async execute(planId: string): Promise<ExtractionExecutionOutcome> {
    const plan = await this.requirePlan(planId);
    const collection = await this.requireCollection(plan.snapshotCollectionId);
    const schema = await this.requireSchema(plan.schemaId);
    const replayFingerprint = this.fingerprint({ planContentFingerprint: plan.contentFingerprint, snapshotCollectionFingerprint: this.collectionFingerprint(collection), schemaVersion: schema.collectionRevision });
    const existing = await this.extractions.findResultByReplayFingerprint(replayFingerprint);
    if (existing) {
      const evaluation = await this.extractions.findEvaluationForResult(existing.resultId);
      if (evaluation) return { result: existing, evaluation };
    }
    const validSchema = this.schemaValid(schema, plan);
    const planDiagnostics = this.planDiagnostics(plan, schema, collection);
    const validPlan = planDiagnostics.length === 0;
    const output = validPlan && validSchema ? this.engine.execute(plan, collection, schema) : { records: [], diagnostics: planDiagnostics, metrics: emptyMetrics };
    const result: ExtractionResult = {
      resultId: replayFingerprint,
      planId: plan.planId,
      datasetId: plan.datasetId,
      snapshotCollectionId: plan.snapshotCollectionId,
      schemaVersion: plan.schemaVersion,
      planRevision: plan.revision,
      replayFingerprint,
      records: output.records,
      diagnostics: output.diagnostics,
      metrics: output.metrics,
      createdAt: plan.createdAt
    };
    const evaluation = this.evaluator.evaluate({ plan, schema, result, validPlan, validSchema });
    await this.extractions.saveResult(result);
    await this.extractions.saveEvaluation(evaluation);
    return { result, evaluation };
  }

  private async requirePlan(planId: string): Promise<ExtractionPlan> { const plan = await this.extractions.findPlan(planId); if (!plan) throw new ApplicationError("not_found", "Extraction plan not found"); return plan; }
  private async requireCollection(id: string): Promise<SnapshotCollection> { const collection = await this.discoveries.findSnapshotCollection(id); if (!collection) throw new ApplicationError("not_found", "Snapshot collection not found"); return collection; }
  private async requireSchema(id: string): Promise<DatasetSchema> { const schema = await this.schemas.findById(id); if (!schema) throw new ApplicationError("not_found", "Schema not found"); return schema; }
  private schemaValid(schema: DatasetSchema, plan: ExtractionPlan): boolean { return schema.datasetId === plan.datasetId && schema.snapshotCollectionId === plan.snapshotCollectionId && schema.collectionRevision === plan.schemaVersion && schema.schema.type === "object" && new Set(schema.fields.map((field) => field.name)).size === schema.fields.length; }
  private planDiagnostics(plan: ExtractionPlan, schema: DatasetSchema, collection: SnapshotCollection): ExtractionDiagnostic[] {
    const diagnostics: ExtractionDiagnostic[] = [];
    if (plan.datasetId !== collection.datasetId) diagnostics.push({ scope: "page", status: "error", code: "INVALID_PLAN", message: "Plan and snapshot collection belong to different datasets" });
    if (collection.entries.length > plan.executionPolicy.maximumCollectionSize) diagnostics.push({ scope: "page", status: "error", code: "INVALID_PLAN", message: "Snapshot collection exceeds the plan execution-policy limit" });
    if (!collection.completed && !plan.executionPolicy.allowPartialCollections) diagnostics.push({ scope: "page", status: "error", code: "INVALID_PLAN", message: "Plan execution policy does not allow partial collections" });
    const knownFields = new Set(schema.fields.map((field) => field.name));
    const evidence = new Set(plan.pageTypes.flatMap((page) => page.classificationEvidence));
    for (const page of plan.pageTypes) {
      if (!this.selectorValid(page.recordSelector) || page.collectionSelector && !this.selectorValid(page.collectionSelector)) diagnostics.push({ scope: "page", status: "error", pageType: page.pageType, code: "INVALID_PLAN", message: "Plan contains an unsupported selector" });
      for (const field of page.fields) {
        if (!knownFields.has(field.field) || !field.selector || !field.evidenceReference || !evidence.has(field.evidenceReference) || field.source === "attribute" && !field.attribute || field.source === "html" && !plan.executionPolicy.allowHtmlExtraction || field.transforms.some((transform) => !plan.executionPolicy.allowedTransforms.includes(transform))) diagnostics.push({ scope: "field", status: "error", field: field.field, selector: field.selector, extractionRuleId: field.ruleId, code: "INVALID_PLAN", message: "Plan field violates deterministic execution policy" });
      }
    }
    return diagnostics;
  }
  private selectorValid(selector: string): boolean { if (/(?:xpath|javascript:|\beval\b|\bfunction\b|=>|\bwindow\b|\bdocument\b|\bscript\b|\bregex\b|\bregexp\b|\.match\s*\(|^\s*\/|\/\/)/i.test(selector)) return false; try { cheerio.load("<main><article class=record /></main>")(selector); return true; } catch { return false; } }
  private collectionFingerprint(collection: SnapshotCollection): string { return this.fingerprint(collection.entries.map((entry) => ({ url: entry.url, outcome: entry.outcome, fingerprint: entry.snapshot?.fingerprint ?? null }))); }
  private fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
}
