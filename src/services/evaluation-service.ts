import type { DatasetSchema } from "../models/schema.js";
import type { EvaluationReason, EvaluationReport, ExtractionDiagnostic, ExtractionPlan, ExtractionResult } from "../models/extraction.js";

export interface EvaluationInput { readonly plan: ExtractionPlan; readonly schema: DatasetSchema; readonly result: ExtractionResult; readonly validPlan: boolean; readonly validSchema: boolean; }

/** Assigns deterministic quality outcomes from completed execution output; it never parses snapshots. */
export class EvaluationService {
  evaluate(input: EvaluationInput): EvaluationReport {
    const { metrics } = input.result;
    const reasons = this.reasons(input);
    const outcome = !input.validPlan || !input.validSchema || metrics.recordsExtracted === 0 || metrics.schemaInvalidRecords > 0 || this.unrecoverable(input.result.diagnostics)
      ? "FAIL"
      : metrics.pageCoveragePercent >= 90 && metrics.requiredFieldCompletenessPercent >= 90 && metrics.duplicatePercent <= 5
        ? "PASS"
        : "REVIEW";
    const replayFingerprint = `${input.result.replayFingerprint}:evaluation:v1`;
    return {
      evaluationId: replayFingerprint,
      resultId: input.result.resultId,
      planId: input.plan.planId,
      datasetId: input.plan.datasetId,
      snapshotCollectionId: input.plan.snapshotCollectionId,
      schemaVersion: input.plan.schemaVersion,
      planRevision: input.plan.revision,
      replayFingerprint,
      outcome,
      metrics,
      reasons,
      diagnostics: input.result.diagnostics,
      evaluatedAt: input.plan.createdAt
    };
  }

  private reasons(input: EvaluationInput): readonly EvaluationReason[] {
    const { metrics } = input.result;
    const reasons: EvaluationReason[] = [];
    if (!input.validPlan) reasons.push({ code: "INVALID_PLAN", severity: "error", message: "The extraction plan did not pass deterministic validation.", recommendation: "Generate a plan that satisfies all deterministic selector, evidence, and policy checks." });
    if (!input.validSchema) reasons.push({ code: "INVALID_SCHEMA", severity: "error", message: "The schema did not pass deterministic validation.", recommendation: "Correct the schema fields and evidence before generating an extraction plan." });
    if (metrics.recordsExtracted === 0) reasons.push({ code: "ZERO_VALID_RECORDS", severity: "error", message: "No valid records were extracted.", recommendation: "Use record and field selectors grounded in primary-content evidence." });
    if (this.unrecoverable(input.result.diagnostics)) reasons.push({ code: "UNRECOVERABLE_EXECUTION_FAILURE", severity: "error", message: "An unrecoverable parser or execution failure prevented complete extraction.", recommendation: "Review the page diagnostics and correct the deterministic plan or source fixture." });
    if (metrics.schemaInvalidRecords > 0) reasons.push({ code: "SCHEMA_INVALID_RECORDS", severity: "error", message: `${metrics.schemaInvalidRecords} extracted record(s) failed schema conformance.`, recommendation: "Require selectors and normalization rules that produce the approved schema types." });
    if (metrics.duplicatePercent > 5) reasons.push({ code: "DUPLICATE_RATE_EXCEEDED", severity: "warning", message: `Duplicate rate exceeded the 5% threshold (${metrics.duplicatePercent}%).`, recommendation: "Limit planning to the dataset root and avoid repeated navigation or page chrome structures." });
    if (metrics.pageCoveragePercent < 90) reasons.push({ code: "PAGE_COVERAGE_LOW", severity: "warning", message: `Page coverage is below the 90% threshold (${metrics.pageCoveragePercent}%).`, recommendation: "Use selectors that cover each applicable primary-content page type." });
    if (metrics.requiredFieldCompletenessPercent < 90) reasons.push({ code: "REQUIRED_FIELD_COMPLETENESS_LOW", severity: "warning", message: `Required-field completeness is below the 90% threshold (${metrics.requiredFieldCompletenessPercent}%).`, recommendation: "Use field selectors observed in representative records and keep missing-field policy explicit." });
    if (metrics.selectorFailures > 0) reasons.push({ code: "SELECTOR_FAILURES", severity: "warning", message: `${metrics.selectorFailures} selector failure(s) occurred.`, recommendation: "Review selector lineage and replace selectors that do not match primary-content samples." });
    if (metrics.normalizationFailures > 0) reasons.push({ code: "NORMALIZATION_FAILURES", severity: "warning", message: `${metrics.normalizationFailures} normalization failure(s) occurred.`, recommendation: "Use supported deterministic transforms aligned with observed source values." });
    return reasons;
  }

  private unrecoverable(diagnostics: readonly ExtractionDiagnostic[]): boolean { return diagnostics.some((diagnostic) => diagnostic.code === "PARSER_FAILURE" || diagnostic.code === "UNRECOVERABLE_EXECUTION_FAILURE"); }
}
