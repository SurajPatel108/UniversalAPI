/*
Purpose: define immutable, dataset-scoped extraction planning, execution, and evaluation artifacts.
Responsibilities: retain enough declarative policy and provenance to replay deterministic execution without AI.
Connections: Phase 4 planning persists ExtractionPlans; future deterministic executors create results and evaluations.
Best practice: never mutate any artifact or reuse an identifier for changed behavior.
*/

export type ExtractionValueSource = "text" | "attribute" | "html";
export type ExtractionTransform = "unicode_normalize" | "trim" | "collapse_whitespace" | "to_string" | "to_number" | "to_boolean" | "to_date" | "to_currency" | "canonical_url" | "enum_normalize";
export type ExtractionNormalizer = "unicode" | "whitespace" | "type" | "enum" | "url" | "date" | "number" | "currency" | "null_default";
export type EvaluationOutcome = "PASS" | "REVIEW" | "FAIL";

/** Immutable composition-time policy snapshot. A policy change requires a new plan revision. */
export interface ExecutionPolicy {
  readonly allowHtmlExtraction: boolean;
  readonly allowMissingFields: boolean;
  readonly allowDuplicateRecords: boolean;
  readonly allowPartialCollections: boolean;
  readonly allowedNormalizers: readonly ExtractionNormalizer[];
  readonly allowedTransforms: readonly ExtractionTransform[];
  readonly maximumExtractionErrors: number;
  readonly maximumNestedDepth: number;
  readonly maximumCollectionSize: number;
}

export interface ExtractionFieldRule {
  readonly ruleId: string;
  readonly field: string;
  readonly selector: string;
  readonly source: ExtractionValueSource;
  readonly attribute?: string;
  readonly transforms: readonly ExtractionTransform[];
  readonly defaultValue?: unknown;
  readonly required: boolean;
  readonly evidenceReference: string;
}

export interface NestedExtractionRule {
  readonly field: string;
  readonly selector: string;
  readonly fields: readonly ExtractionFieldRule[];
}

export interface ExtractionPageTypeRule {
  readonly pageType: string;
  readonly classificationEvidence: readonly string[];
  readonly collectionSelector?: string;
  readonly recordSelector: string;
  readonly fields: readonly ExtractionFieldRule[];
  readonly nested: readonly NestedExtractionRule[];
}

export interface ExtractionPlanProvenance {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly preprocessingVersion: string;
  readonly samplingVersion: string;
  readonly confidence: number;
}

/** A fully declarative, immutable plan. No executable code or expressions are represented here. */
export interface ExtractionPlan {
  readonly planId: string;
  readonly datasetId: string;
  readonly snapshotCollectionId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly revision: number;
  readonly contentFingerprint: string;
  readonly generationCacheKey: string;
  readonly pageTypes: readonly ExtractionPageTypeRule[];
  readonly pagination: { readonly strategy: "none" | "snapshot_pages"; readonly evidenceReference: string };
  readonly duplicatePolicy: { readonly strategy: "allow" | "deduplicate" | "reject"; readonly keyFields: readonly string[] };
  readonly missingFieldPolicy: "allow" | "reject_record" | "use_default";
  readonly executionPolicy: ExecutionPolicy;
  readonly examples: readonly { readonly snapshotId: string; readonly recordIndex: number; readonly evidenceReference: string }[];
  readonly provenance: ExtractionPlanProvenance;
  readonly createdAt: Date;
}

export interface ExtractionFieldProvenance {
  readonly snapshotId: string;
  readonly sourcePageUrl: string;
  readonly planRevision: number;
  readonly selector: string;
  readonly extractionRuleId: string;
  readonly evidenceReference: string;
  readonly recordIndexWithinPage: number;
}

export interface ExtractedRecord {
  readonly data: Readonly<Record<string, unknown>>;
  readonly snapshotId: string;
  readonly sourcePageUrl: string;
  readonly planRevision: number;
  readonly pageType: string;
  readonly recordIndexWithinPage: number;
  readonly fields: Readonly<Record<string, ExtractionFieldProvenance>>;
}

export interface ExtractionDiagnostic {
  readonly scope: "page" | "record" | "field";
  readonly status: "info" | "warning" | "error";
  readonly snapshotId?: string;
  readonly sourcePageUrl?: string;
  readonly recordIndexWithinPage?: number;
  readonly field?: string;
  readonly pageType?: string;
  readonly selector?: string;
  readonly extractionRuleId?: string;
  readonly normalizationActions?: readonly string[];
  readonly code: string;
  readonly message: string;
}

export interface ExtractionMetrics {
  readonly pagesProcessed: number;
  readonly pagesSucceeded: number;
  readonly pagesFailed: number;
  readonly recordsExtracted: number;
  readonly recordsRejected: number;
  readonly fieldsExtracted: number;
  readonly missingRequiredFields: number;
  readonly duplicatesRemoved: number;
  readonly selectorFailures: number;
  readonly normalizationFailures: number;
  readonly executionDurationMs: number;
  readonly snapshotCoveragePercent: number;
  readonly pageCoveragePercent: number;
  readonly requiredFieldCompletenessPercent: number;
  readonly duplicatePercent: number;
  readonly schemaInvalidRecords: number;
}

export interface ExtractionResult {
  readonly resultId: string;
  readonly planId: string;
  readonly datasetId: string;
  readonly snapshotCollectionId: string;
  readonly schemaVersion: string;
  readonly planRevision: number;
  readonly replayFingerprint: string;
  readonly records: readonly ExtractedRecord[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
  readonly metrics: ExtractionMetrics;
  readonly createdAt: Date;
}

/** Deterministic explanation for an evaluation outcome; it never contains model output. */
export interface EvaluationReason {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly recommendation: string;
}

export interface EvaluationReport {
  readonly evaluationId: string;
  readonly resultId: string;
  readonly planId: string;
  readonly datasetId: string;
  readonly snapshotCollectionId: string;
  readonly schemaVersion: string;
  readonly planRevision: number;
  readonly replayFingerprint: string;
  readonly outcome: EvaluationOutcome;
  readonly metrics: ExtractionMetrics;
  readonly reasons: readonly EvaluationReason[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
  readonly evaluatedAt: Date;
}

/** Compatibility aliases for dormant pre-Phase-4 ports. */
export type ExtractionDefinition = ExtractionPlan;
export type ExtractionVersion = ExtractionResult;
