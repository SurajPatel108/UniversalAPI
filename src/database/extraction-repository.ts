/* Durable port for immutable Phase 4 artifacts. Publication is intentionally a later-phase concern. */

import type { EvaluationReport, ExtractionPlan, ExtractionResult } from "../models/extraction.js";

export interface ExtractionRepository {
  findPlan(planId: string): Promise<ExtractionPlan | null>;
  findPlanByGenerationCacheKey(generationCacheKey: string): Promise<ExtractionPlan | null>;
  findLatestPlanForDataset(datasetId: string): Promise<ExtractionPlan | null>;
  savePlan(plan: ExtractionPlan): Promise<void>;
  findResult(resultId: string): Promise<ExtractionResult | null>;
  findResultByReplayFingerprint(replayFingerprint: string): Promise<ExtractionResult | null>;
  saveResult(result: ExtractionResult): Promise<void>;
  findEvaluation(evaluationId: string): Promise<EvaluationReport | null>;
  findEvaluationForResult(resultId: string): Promise<EvaluationReport | null>;
  saveEvaluation(report: EvaluationReport): Promise<void>;
}

export class InMemoryExtractionRepository implements ExtractionRepository {
  private readonly plans = new Map<string, ExtractionPlan>();
  private readonly plansByCacheKey = new Map<string, string>();
  private readonly results = new Map<string, ExtractionResult>();
  private readonly resultsByReplayFingerprint = new Map<string, string>();
  private readonly evaluations = new Map<string, EvaluationReport>();

  async findPlan(planId: string): Promise<ExtractionPlan | null> { return this.plans.get(planId) ?? null; }
  async findPlanByGenerationCacheKey(generationCacheKey: string): Promise<ExtractionPlan | null> { const planId = this.plansByCacheKey.get(generationCacheKey); return planId ? this.plans.get(planId) ?? null : null; }
  async findLatestPlanForDataset(datasetId: string): Promise<ExtractionPlan | null> { return [...this.plans.values()].filter((plan) => plan.datasetId === datasetId).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.revision - left.revision)[0] ?? null; }
  async savePlan(plan: ExtractionPlan): Promise<void> { this.assertNew(this.plans, plan.planId, "Extraction plan"); const cached = this.plansByCacheKey.get(plan.generationCacheKey); if (cached && cached !== plan.planId) throw new Error("Extraction plan generation cache key already exists"); this.plans.set(plan.planId, plan); this.plansByCacheKey.set(plan.generationCacheKey, plan.planId); }
  async findResult(resultId: string): Promise<ExtractionResult | null> { return this.results.get(resultId) ?? null; }
  async findResultByReplayFingerprint(replayFingerprint: string): Promise<ExtractionResult | null> { const resultId = this.resultsByReplayFingerprint.get(replayFingerprint); return resultId ? this.results.get(resultId) ?? null : null; }
  async saveResult(result: ExtractionResult): Promise<void> { this.assertNew(this.results, result.resultId, "Extraction result"); const existing = this.resultsByReplayFingerprint.get(result.replayFingerprint); if (existing && existing !== result.resultId) throw new Error("Extraction result replay fingerprint already exists"); this.results.set(result.resultId, result); this.resultsByReplayFingerprint.set(result.replayFingerprint, result.resultId); }
  async findEvaluation(evaluationId: string): Promise<EvaluationReport | null> { return this.evaluations.get(evaluationId) ?? null; }
  async findEvaluationForResult(resultId: string): Promise<EvaluationReport | null> { return [...this.evaluations.values()].find((report) => report.resultId === resultId) ?? null; }
  async saveEvaluation(report: EvaluationReport): Promise<void> { this.assertNew(this.evaluations, report.evaluationId, "Evaluation report"); this.evaluations.set(report.evaluationId, report); }

  private assertNew<T>(items: ReadonlyMap<string, T>, id: string, name: string): void { if (items.has(id)) throw new Error(`${name} is immutable and already exists`); }
}
