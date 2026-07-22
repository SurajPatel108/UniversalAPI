import { createHash } from "node:crypto";
import type { CheerioAPI } from "cheerio";
import type { DatasetSchema } from "../models/schema.js";
import type { ExtractionDiagnostic, ExtractionFieldRule, ExtractionMetrics, ExtractionPlan, ExtractedRecord } from "../models/extraction.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";
import { CheerioExtractionParser } from "../parsers/cheerio-extraction-parser.js";
import { NormalizationService } from "./normalization-service.js";

export interface ExtractionEngineOutput { readonly records: readonly ExtractedRecord[]; readonly diagnostics: readonly ExtractionDiagnostic[]; readonly metrics: ExtractionMetrics; }

/** Executes a persisted declarative plan with static Cheerio only; it never assigns quality outcomes. */
export class ExtractionEngine {
  constructor(private readonly parser = new CheerioExtractionParser(), private readonly normalizer = new NormalizationService()) {}

  execute(plan: ExtractionPlan, collection: SnapshotCollection, schema: DatasetSchema): ExtractionEngineOutput {
    const diagnostics: ExtractionDiagnostic[] = [];
    const records: ExtractedRecord[] = [];
    const counters = { pagesProcessed: 0, pagesSucceeded: 0, pagesFailed: 0, recordsRejected: 0, fieldsExtracted: 0, missingRequiredFields: 0, selectorFailures: 0, normalizationFailures: 0, schemaInvalidRecords: 0 };
    const entries = [...collection.entries].sort((left, right) => left.url.localeCompare(right.url) || (left.snapshot?.id ?? "").localeCompare(right.snapshot?.id ?? ""));
    for (const entry of entries) {
      counters.pagesProcessed += 1;
      if (entry.outcome !== "captured" || !entry.snapshot || entry.content === undefined) {
        counters.pagesFailed += 1;
        diagnostics.push({ scope: "page", status: "warning", sourcePageUrl: entry.url, code: "PAGE_SKIPPED", message: entry.error ?? `Snapshot outcome is ${entry.outcome}` });
        continue;
      }
      const rule = this.pageRule(plan, entry.snapshot.id);
      if (!rule) {
        counters.pagesFailed += 1;
        diagnostics.push({ scope: "page", status: "warning", snapshotId: entry.snapshot.id, sourcePageUrl: entry.url, code: "PAGE_TYPE_UNCLASSIFIED", message: "No deterministic page-type rule matches this snapshot" });
        continue;
      }
      let $: CheerioAPI;
      try { $ = this.parser.parse(entry.content); }
      catch (error) {
        counters.pagesFailed += 1;
        diagnostics.push({ scope: "page", status: "error", snapshotId: entry.snapshot.id, sourcePageUrl: entry.url, pageType: rule.pageType, code: "PARSER_FAILURE", message: error instanceof Error ? error.message : "Static parser failed" });
        continue;
      }
      try {
        const recordNodes = this.recordNodes($, rule.collectionSelector, rule.recordSelector);
        if (recordNodes.length === 0) diagnostics.push({ scope: "page", status: "info", snapshotId: entry.snapshot.id, sourcePageUrl: entry.url, pageType: rule.pageType, selector: rule.recordSelector, code: "NO_RECORDS", message: "Record selector matched no records" });
        recordNodes.forEach((node, index) => {
          const extracted = this.record($, node, index, entry.snapshot!.id, entry.url, rule.pageType, rule.fields, schema, plan.revision, diagnostics, counters);
          if (extracted) records.push(extracted);
        });
        counters.pagesSucceeded += 1;
        diagnostics.push({ scope: "page", status: "info", snapshotId: entry.snapshot.id, sourcePageUrl: entry.url, pageType: rule.pageType, code: "PAGE_PROCESSED", message: "Page processed deterministically" });
      } catch (error) {
        counters.pagesFailed += 1;
        diagnostics.push({ scope: "page", status: "error", snapshotId: entry.snapshot.id, sourcePageUrl: entry.url, pageType: rule.pageType, code: "PAGE_EXTRACTION_FAILED", message: error instanceof Error ? error.message : "Page extraction failed" });
      }
    }
    const ordered = records.sort((left, right) => left.sourcePageUrl.localeCompare(right.sourcePageUrl) || left.recordIndexWithinPage - right.recordIndexWithinPage || left.pageType.localeCompare(right.pageType));
    const deduplicated = this.duplicates(ordered, plan, diagnostics, counters);
    const capturedPages = entries.filter((entry) => entry.outcome === "captured" && entry.snapshot && entry.content !== undefined).length;
    const requiredTotal = ordered.length * schema.fields.filter((field) => field.required).length;
    const metrics: ExtractionMetrics = { pagesProcessed: counters.pagesProcessed, pagesSucceeded: counters.pagesSucceeded, pagesFailed: counters.pagesFailed, recordsExtracted: deduplicated.length, recordsRejected: counters.recordsRejected, fieldsExtracted: counters.fieldsExtracted, missingRequiredFields: counters.missingRequiredFields, duplicatesRemoved: counters.recordsRejected - counters.schemaInvalidRecords < 0 ? 0 : 0, selectorFailures: counters.selectorFailures, normalizationFailures: counters.normalizationFailures, executionDurationMs: 0, snapshotCoveragePercent: this.percent(counters.pagesProcessed, entries.length), pageCoveragePercent: this.percent(counters.pagesSucceeded, capturedPages), requiredFieldCompletenessPercent: this.percent(requiredTotal - counters.missingRequiredFields, requiredTotal), duplicatePercent: 0, schemaInvalidRecords: counters.schemaInvalidRecords };
    const duplicateCount = diagnostics.filter((diagnostic) => diagnostic.code === "DUPLICATE_REMOVED" || diagnostic.code === "DUPLICATE_REJECTED").length;
    return { records: deduplicated, diagnostics: diagnostics.sort(this.diagnosticOrder), metrics: { ...metrics, duplicatesRemoved: duplicateCount, duplicatePercent: this.percent(duplicateCount, duplicateCount + deduplicated.length) } };
  }

  private pageRule(plan: ExtractionPlan, snapshotId: string) { const evidence = `snapshot:${snapshotId}`; return plan.pageTypes.find((rule) => rule.classificationEvidence.includes(evidence)) ?? (plan.pageTypes.length === 1 ? plan.pageTypes[0] : undefined); }
  private recordNodes($: CheerioAPI, collectionSelector: string | undefined, recordSelector: string): unknown[] { if (!collectionSelector) return $(recordSelector).toArray(); return $(collectionSelector).toArray().flatMap((node) => $(node).find(recordSelector).toArray()); }
  private record($: CheerioAPI, node: unknown, index: number, snapshotId: string, url: string, pageType: string, fields: readonly ExtractionFieldRule[], schema: DatasetSchema, revision: number, diagnostics: ExtractionDiagnostic[], counters: { recordsRejected: number; fieldsExtracted: number; missingRequiredFields: number; selectorFailures: number; normalizationFailures: number; schemaInvalidRecords: number }): ExtractedRecord | null {
    const data: Record<string, unknown> = {}; const provenance: Record<string, ExtractedRecord["fields"][string]> = {}; let reject = false;
    for (const rule of [...fields].sort((left, right) => left.field.localeCompare(right.field))) {
      const recordNode = $(node as never);
      const matches = recordNode.is(rule.selector) ? recordNode : recordNode.find(rule.selector);
      const raw = matches.length === 0 ? null : rule.source === "attribute" ? matches.first().attr(rule.attribute!) ?? null : rule.source === "html" ? matches.first().html() ?? null : matches.first().text();
      if (matches.length === 0) { counters.selectorFailures += 1; diagnostics.push({ scope: "field", status: "warning", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, field: rule.field, pageType, selector: rule.selector, extractionRuleId: rule.ruleId, code: "SELECTOR_UNMATCHED", message: "Field selector matched no node" }); }
      const schemaField = schema.fields.find((field) => field.name === rule.field)!;
      const normalized = this.normalizer.normalize(raw, rule, schema.schema.properties[rule.field], url);
      if (normalized.error) { counters.normalizationFailures += 1; diagnostics.push({ scope: "field", status: "error", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, field: rule.field, pageType, selector: rule.selector, extractionRuleId: rule.ruleId, normalizationActions: normalized.actions, code: "NORMALIZATION_FAILED", message: normalized.error }); }
      if (normalized.value === null && schemaField.required) { counters.missingRequiredFields += 1; reject = true; diagnostics.push({ scope: "field", status: "error", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, field: rule.field, pageType, selector: rule.selector, extractionRuleId: rule.ruleId, normalizationActions: normalized.actions, code: "REQUIRED_FIELD_MISSING", message: "Required field is missing" }); }
      else if (normalized.value !== null) counters.fieldsExtracted += 1;
      diagnostics.push({ scope: "field", status: normalized.error ? "error" : "info", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, field: rule.field, pageType, selector: rule.selector, extractionRuleId: rule.ruleId, normalizationActions: normalized.actions, code: normalized.defaultApplied ? "DEFAULT_APPLIED" : "FIELD_EXTRACTED", message: normalized.defaultApplied ? "Default value applied" : "Field processed" });
      data[rule.field] = normalized.value;
      provenance[rule.field] = { snapshotId, sourcePageUrl: url, planRevision: revision, selector: rule.selector, extractionRuleId: rule.ruleId, evidenceReference: rule.evidenceReference, recordIndexWithinPage: index };
    }
    if (!this.conforms(data, schema)) { reject = true; counters.schemaInvalidRecords += 1; diagnostics.push({ scope: "record", status: "error", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, pageType, code: "SCHEMA_INVALID", message: "Extracted record does not conform to schema" }); }
    if (reject) { counters.recordsRejected += 1; diagnostics.push({ scope: "record", status: "warning", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, pageType, code: "RECORD_REJECTED", message: "Record rejected by deterministic validation" }); return null; }
    diagnostics.push({ scope: "record", status: "info", snapshotId, sourcePageUrl: url, recordIndexWithinPage: index, pageType, code: "RECORD_EXTRACTED", message: "Record extracted" });
    return { data, snapshotId, sourcePageUrl: url, planRevision: revision, pageType, recordIndexWithinPage: index, fields: provenance };
  }
  private duplicates(records: readonly ExtractedRecord[], plan: ExtractionPlan, diagnostics: ExtractionDiagnostic[], counters: { recordsRejected: number }): ExtractedRecord[] { const seen = new Set<string>(); const output: ExtractedRecord[] = []; for (const record of records) { const key = createHash("sha256").update(JSON.stringify(plan.duplicatePolicy.keyFields.map((field) => record.data[field] ?? null))).digest("hex"); if (seen.has(key)) { const code = plan.duplicatePolicy.strategy === "allow" ? "DUPLICATE_DETECTED" : plan.duplicatePolicy.strategy === "deduplicate" ? "DUPLICATE_REMOVED" : "DUPLICATE_REJECTED"; diagnostics.push({ scope: "record", status: plan.duplicatePolicy.strategy === "allow" ? "warning" : "info", snapshotId: record.snapshotId, sourcePageUrl: record.sourcePageUrl, recordIndexWithinPage: record.recordIndexWithinPage, pageType: record.pageType, code, message: "Duplicate record detected" }); if (plan.duplicatePolicy.strategy !== "allow") { counters.recordsRejected += 1; continue; } } else seen.add(key); output.push(record); } return output; }
  private conforms(data: Readonly<Record<string, unknown>>, schema: DatasetSchema): boolean {
    return schema.fields.every((field) => {
      const value = data[field.name];
      if (field.required && (value === null || value === undefined)) return false;
      if (value === null || value === undefined) return true;
      const property = schema.schema.properties[field.name];
      const type = property && typeof property === "object" && !Array.isArray(property) ? (property as Record<string, unknown>).type : undefined;
      return type === undefined || type === "string" && typeof value === "string" || type === "number" && typeof value === "number" || type === "integer" && typeof value === "number" && Number.isInteger(value) || type === "boolean" && typeof value === "boolean";
    }) && Object.keys(data).every((field) => schema.fields.some((schemaField) => schemaField.name === field));
  }
  private percent(numerator: number, denominator: number): number { return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(6)); }
  private diagnosticOrder(left: ExtractionDiagnostic, right: ExtractionDiagnostic): number { return `${left.sourcePageUrl ?? ""}|${left.recordIndexWithinPage ?? -1}|${left.field ?? ""}|${left.code}`.localeCompare(`${right.sourcePageUrl ?? ""}|${right.recordIndexWithinPage ?? -1}|${right.field ?? ""}|${right.code}`); }
}
