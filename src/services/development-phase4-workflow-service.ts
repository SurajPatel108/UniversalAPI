import type { EvaluationReport, ExtractionDiagnostic, ExtractionPlan, ExtractionResult } from "../models/extraction.js";
import type { SchemaApprovalDecision } from "../models/schema-approval.js";
import { ExtractionExecutionService } from "./extraction-execution-service.js";
import { ExtractionPlanGenerationService, type ExtractionPlanValidationDiagnostic } from "./extraction-plan-generation-service.js";
import { SchemaApprovalService } from "./schema-approval-service.js";

interface SchemaApprovalWorkflowPort { autoApproveLatestForDevelopment(datasetId: string, snapshotCollectionId: string): ReturnType<SchemaApprovalService["autoApproveLatestForDevelopment"]>; }
interface PlanGenerationWorkflowPort {
  generate(schemaId: string): ReturnType<ExtractionPlanGenerationService["generate"]>;
  getLastValidationDiagnostics?(): readonly ExtractionPlanValidationDiagnostic[];
}
interface ExecutionWorkflowPort { execute(planId: string): ReturnType<ExtractionExecutionService["execute"]>; }

export interface DevelopmentPhase4WorkflowResult {
  readonly schemaApproval: SchemaApprovalDecision | null;
  readonly approvalDiagnostics: readonly string[];
  readonly plan: ExtractionPlan | null;
  readonly result: ExtractionResult | null;
  readonly evaluation: EvaluationReport | null;
  readonly diagnostics: readonly ExtractionDiagnostic[];
  readonly planValidationDiagnostics: readonly ExtractionPlanValidationDiagnostic[];
  readonly error: string | null;
}

/** Development-only orchestration: delegates approval, planning, execution, and evaluation to their services. */
export class DevelopmentPhase4WorkflowService {
  constructor(private readonly approvals: SchemaApprovalWorkflowPort, private readonly plans: PlanGenerationWorkflowPort, private readonly execution: ExecutionWorkflowPort) {}

  async run(datasetId: string, snapshotCollectionId: string): Promise<DevelopmentPhase4WorkflowResult> {
    const approval = await this.approvals.autoApproveLatestForDevelopment(datasetId, snapshotCollectionId);
    if (!approval.schema || !approval.decision) return { schemaApproval: null, approvalDiagnostics: approval.diagnostics, plan: null, result: null, evaluation: null, diagnostics: [], planValidationDiagnostics: [], error: "Schema approval did not pass deterministic validation." };
    let plan: ExtractionPlan;
    try { plan = await this.plans.generate(approval.schema.id); }
    catch (error) { return { schemaApproval: approval.decision, approvalDiagnostics: approval.diagnostics, plan: null, result: null, evaluation: null, diagnostics: [], planValidationDiagnostics: this.plans.getLastValidationDiagnostics?.() ?? [], error: error instanceof Error ? error.message : "Extraction plan generation failed." }; }
    try {
      const executed = await this.execution.execute(plan.planId);
      return { schemaApproval: approval.decision, approvalDiagnostics: approval.diagnostics, plan, result: executed.result, evaluation: executed.evaluation, diagnostics: executed.result.diagnostics, planValidationDiagnostics: [], error: null };
    } catch (error) {
      return { schemaApproval: approval.decision, approvalDiagnostics: approval.diagnostics, plan, result: null, evaluation: null, diagnostics: [], planValidationDiagnostics: [], error: error instanceof Error ? error.message : "Extraction execution failed." };
    }
  }
}
