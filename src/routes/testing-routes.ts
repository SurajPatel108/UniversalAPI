/*
Purpose: provide a development-only testing dashboard and runner for the existing pipeline.
Responsibilities: expose a simple HTML UI and a POST endpoint that runs the same services as the production routes.
Connections: registered by the Fastify app in development mode only; it reuses SourceService, DiscoveryService, and SchemaUnderstandingService.
Future: expand the dashboard for richer debugging while keeping it strictly local and non-production.
Best practice: keep this route thin and delegate all orchestration to the existing services rather than duplicating business logic.
*/

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationError } from "../core/errors.js";
import type { SourceService } from "../services/source-service.js";
import type { DiscoveryService } from "../services/discovery-service.js";
import type { SchemaUnderstandingService } from "../services/schema-understanding-service.js";
import type { DatasetClassificationService } from "../ai/dataset-classification-service.js";
import { defaultDiscoveryLimits } from "../models/discovery.js";
import type { DevelopmentPhase4WorkflowResult, DevelopmentPhase4WorkflowService } from "../services/development-phase4-workflow-service.js";

const runPayloadSchema = z.object({
  url: z.string().url(),
  steps: z.object({
    discovery: z.boolean().default(false),
    approval: z.boolean().default(false),
    snapshotCapture: z.boolean().default(false),
    schema: z.boolean().default(false)
  }).default({ discovery: false, approval: false, snapshotCapture: false, schema: false })
});

export interface TestingDashboardRunResult {
  readonly elapsedMs: number;
  readonly sourceId: string | null;
  readonly discoveryResultId: string | null;
  readonly candidateId: string | null;
  readonly datasetId: string | null;
  readonly snapshotCollectionId: string | null;
  readonly schemaId: string | null;
  readonly discoveredDatasets: number;
  readonly pagesCrawled: number;
  readonly snapshotsCaptured: number;
  readonly schemaFields: number;
  readonly provider: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly generatedIds: string[];
  readonly logs: readonly string[];
  readonly acquisitionDiagnostics: readonly { readonly url: string; readonly stage: "Acquisition"; readonly reason: string }[];
  readonly error: string | null;
  readonly phase4: DevelopmentPhase4WorkflowResult | null;
  readonly schemaPreview: {
    readonly fields: Array<{ readonly name: string; readonly type: string; readonly required: boolean; readonly confidence: number; readonly evidence: string }>;
    readonly rationale: string;
    readonly confidence: number;
  } | null;
}

export function registerTestingRoutes(app: FastifyInstance, deps: { sourceService: SourceService; discoveryService: DiscoveryService; schemaService: SchemaUnderstandingService; phase4Workflow: DevelopmentPhase4WorkflowService; classifier: DatasetClassificationService; providerName: string; providerModel: string; tokenUsage?: number | null; environment: { nodeEnv: string } }): void {
  app.get("/testing", async (_request, reply) => {
    if (deps.environment.nodeEnv !== "development") {
      throw new ApplicationError("not_found", "Testing dashboard is only available in development", false);
    }

    return reply.type("text/html").send(String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Universal API Testing Dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
      .card { background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
      label { display: block; margin-bottom: 0.5rem; font-weight: 600; }
      input[type="text"] { width: 100%; max-width: 640px; padding: 0.6rem; border-radius: 8px; border: 1px solid #64748b; background: #020617; color: #f8fafc; }
      .checks { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.75rem; }
      button { background: #2563eb; color: white; border: none; border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; margin-top: 0.75rem; }
      button:disabled { opacity: 0.65; cursor: wait; }
      pre { white-space: pre-wrap; background: #020617; border: 1px solid #334155; padding: 0.9rem; border-radius: 8px; min-height: 180px; }
      .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; }
      .item { background: #020617; border: 1px solid #334155; padding: 0.75rem; border-radius: 8px; }
    </style>
  </head>
  <body>
    <h1>Universal API Testing Dashboard</h1>
    <div class="card">
      <label for="url">Target URL</label>
      <input id="url" name="url" value="https://books.toscrape.com" />
      <div class="checks">
        <label><input type="checkbox" id="discovery" checked /> Discovery</label>
        <label><input type="checkbox" id="approval" checked /> Approval</label>
        <label><input type="checkbox" id="snapshot" checked /> Snapshot Capture</label>
        <label><input type="checkbox" id="schema" checked /> Schema Generation</label>
      </div>
      <button id="run">Run Pipeline</button>
    </div>
    <div class="card">
      <h2>Live Log</h2>
      <pre id="log">Waiting to start…</pre>
    </div>
    <div class="card">
      <h2>Summary</h2>
      <div id="summary" class="summary"></div>
    </div>
    <div class="card">
      <h2>Errors</h2>
      <div id="error-banner">No errors.</div>
    </div>
    <div class="card">
      <h2>Schema Preview</h2>
      <div id="schema-preview"></div>
    </div>
    <div class="card">
      <h2>Phase 4 Extraction</h2>
      <div id="phase4-preview">No extraction plan or evaluation available.</div>
    </div>
    <script>
      const runButton = document.getElementById('run');
      const logEl = document.getElementById('log');
      const summaryEl = document.getElementById('summary');
      const errorEl = document.getElementById('error-banner');
      const schemaPreviewEl = document.getElementById('schema-preview');
      const phase4PreviewEl = document.getElementById('phase4-preview');
      const appendLog = (message) => {
        if (!message) {
          return;
        }
        logEl.textContent = logEl.textContent ? logEl.textContent + '\n' + message : message;
      };
      const setRunningState = (isRunning) => {
        runButton.disabled = isRunning;
        runButton.textContent = isRunning ? 'Running...' : 'Run Pipeline';
      };
      const renderError = (errorMessage, acquisitionDiagnostics, planValidationDiagnostics) => {
        const diagnostics = Array.isArray(acquisitionDiagnostics) ? acquisitionDiagnostics : [];
        const diagnosticText = diagnostics.map((diagnostic) => diagnostic.stage + ' failed for ' + diagnostic.url + ': ' + diagnostic.reason).join('\n');
        const validationDiagnostics = Array.isArray(planValidationDiagnostics) ? planValidationDiagnostics : [];
        const validationText = validationDiagnostics.map((diagnostic) => '[' + diagnostic.validationRuleId + '] ' + diagnostic.explanation + ' Suggested correction: ' + diagnostic.suggestedCorrection).join('\n');
        const combined = [errorMessage, diagnosticText, validationText].filter(Boolean).join('\n');
        if (!combined) {
          errorEl.innerHTML = '<div>No errors.</div>';
          return;
        }
        errorEl.innerHTML = '<div style="color: #fda4af; white-space: pre-wrap;">' + combined + '</div>';
      };
      const renderSummary = (summary) => {
        const items = [
          ['Elapsed', summary.elapsedMs + ' ms'],
          ['Discovered datasets', summary.discoveredDatasets],
          ['Selected dataset', summary.datasetId || 'n/a'],
          ['Pages crawled', summary.pagesCrawled],
          ['Snapshots captured', summary.snapshotsCaptured],
          ['Schema fields', summary.schemaFields],
          ['Provider', summary.provider],
          ['Model', summary.model],
          ['Prompt tokens', summary.promptTokens ?? 'n/a'],
          ['Completion tokens', summary.completionTokens ?? 'n/a'],
          ['Total tokens', summary.totalTokens ?? 'n/a'],
          ['Generated IDs', summary.generatedIds.join(', ') || 'n/a']
        ];
        summaryEl.innerHTML = items.map(([label, value]) => '<div class="item"><strong>' + label + '</strong><div>' + value + '</div></div>').join('');
      };
      const renderSchemaPreview = (preview) => {
        if (!preview) {
          schemaPreviewEl.innerHTML = '<div>No schema preview available.</div>';
          return;
        }
        if (!preview.fields || preview.fields.length === 0) {
          schemaPreviewEl.innerHTML = '<div>' + (preview.rationale || 'No schema preview available.') + '</div>';
          return;
        }
        const rows = preview.fields.map((field) => '<tr><td>' + field.name + '</td><td>' + field.type + '</td><td>' + (field.required ? '✓' : '✗') + '</td><td>' + field.confidence.toFixed(2) + '</td></tr>').join('');
        schemaPreviewEl.innerHTML = '<div style="margin-bottom: 0.75rem;">' + (preview.rationale || '') + '</div><table style="width: 100%; border-collapse: collapse;"><thead><tr><th align="left">Field</th><th align="left">Type</th><th align="left">Required</th><th align="left">Confidence</th></tr></thead><tbody>' + rows + '</tbody></table>';
      };
      const renderPhase4 = (phase4) => {
        if (!phase4) { phase4PreviewEl.innerHTML = '<div>No extraction plan or evaluation available.</div>'; return; }
        const approval = phase4.schemaApproval ? 'AUTO_APPROVED · schema ' + phase4.schemaApproval.schemaVersion + ' · ' + phase4.schemaApproval.createdAt + '<br/>Reason: ' + (phase4.schemaApproval.deterministicGateEvidence || []).join(', ') + '<br/>' + (phase4.approvalDiagnostics || []).join('<br/>') : (phase4.approvalDiagnostics || []).join('<br/>');
        const plan = phase4.plan ? 'Plan: ' + phase4.plan.planId + ' · revision ' + phase4.plan.revision + '<br/>Cache: ' + phase4.plan.generationCacheKey + '<br/>Provider: ' + phase4.plan.provenance.provider + ' / ' + phase4.plan.provenance.model + '<br/>Prompt: ' + phase4.plan.provenance.promptVersion + ' · Sampling: ' + phase4.plan.provenance.samplingVersion + ' · Preprocessing: ' + phase4.plan.provenance.preprocessingVersion : 'Plan not generated.';
        const metrics = phase4.result ? phase4.result.metrics : null;
        const execution = metrics ? 'Snapshots/pages processed: ' + metrics.pagesProcessed + '<br/>Records: ' + metrics.recordsExtracted + ' · Fields: ' + metrics.fieldsExtracted + ' · Duplicates removed: ' + metrics.duplicatesRemoved + '<br/>Coverage: ' + metrics.pageCoveragePercent + '% · Required fields: ' + metrics.requiredFieldCompletenessPercent + '%<br/>Replay fingerprint: ' + phase4.result.replayFingerprint : 'Execution not completed.';
        const evaluation = phase4.evaluation ? 'Evaluation: <strong>' + phase4.evaluation.outcome + '</strong><br/>Duplicate rate: ' + phase4.evaluation.metrics.duplicatePercent + '% · Schema conformance failures: ' + phase4.evaluation.metrics.schemaInvalidRecords + '<br/>Quality metrics: selector failures ' + phase4.evaluation.metrics.selectorFailures + ' · normalization failures ' + phase4.evaluation.metrics.normalizationFailures : 'Evaluation not available.';
        const records = phase4.result ? '<pre>' + JSON.stringify(phase4.result.records, null, 2) + '</pre>' : '';
        const diagnostics = (phase4.diagnostics || []).map((diagnostic) => diagnostic.scope + ' ' + diagnostic.code + ': ' + diagnostic.message).join('<br/>');
        const validationDiagnostics = (phase4.planValidationDiagnostics || []).map((diagnostic) => '<li><strong>[' + diagnostic.validationRuleId + ']</strong> ' + diagnostic.explanation + '<br/><small>Category: ' + diagnostic.category + ' · Severity: ' + diagnostic.severity + (diagnostic.field ? ' · Field: ' + diagnostic.field : '') + (diagnostic.selector ? ' · Selector: ' + diagnostic.selector : '') + (diagnostic.affectedRule ? ' · Rule: ' + diagnostic.affectedRule : '') + (diagnostic.evidenceReference ? ' · Evidence: ' + diagnostic.evidenceReference : '') + '<br/>Suggested correction: ' + diagnostic.suggestedCorrection + '</small></li>').join('');
        const validation = validationDiagnostics ? '<strong>FAIL</strong><ul>' + validationDiagnostics + '</ul>' : 'No extraction-plan validation failures.';
        phase4PreviewEl.innerHTML = '<h3>Schema Approval</h3><div>' + approval + '</div><h3>Extraction Plan</h3><div>' + plan + '</div><h3>Extraction Plan Validation</h3><div>' + validation + '</div><h3>Execution</h3><div>' + execution + '</div><h3>Evaluation</h3><div>' + evaluation + '</div><h3>Diagnostics</h3><div>' + (diagnostics || phase4.error || 'None') + '</div><h3>Record Preview</h3>' + records;
      };
      runButton.addEventListener('click', async () => {
        setRunningState(true);
        logEl.textContent = '';
        appendLog('Starting…');
        renderSummary({ elapsedMs: 0, discoveredDatasets: 0, datasetId: 'n/a', pagesCrawled: 0, snapshotsCaptured: 0, schemaFields: 0, provider: 'n/a', model: 'n/a', promptTokens: 0, completionTokens: 0, totalTokens: 0, generatedIds: [] });
        renderError(null, [], []);
        renderSchemaPreview(null);
        renderPhase4(null);
        try {
          const response = await fetch('/testing/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: document.getElementById('url').value,
              steps: {
                discovery: document.getElementById('discovery').checked,
                approval: document.getElementById('approval').checked,
                snapshotCapture: document.getElementById('snapshot').checked,
                schema: document.getElementById('schema').checked
              }
            })
          });
          const responseText = await response.text();
          let payload = { logs: [] };
          if (responseText) {
            try {
              payload = JSON.parse(responseText);
            } catch (error) {
              payload = { logs: [responseText] };
            }
          }
          if (!response.ok) {
            const detail = responseText ? '\n' + responseText : '';
            appendLog('Request failed (HTTP ' + response.status + ')' + detail);
          }
          const logLines = Array.isArray(payload.logs) ? payload.logs : [];
          logEl.textContent = logLines.join('\n');
          renderSummary(payload);
          renderError(payload.error || payload.phase4?.error || null, payload.acquisitionDiagnostics, payload.phase4?.planValidationDiagnostics);
          renderSchemaPreview(payload.schemaPreview);
          renderPhase4(payload.phase4);
        } catch (error) {
          appendLog(error instanceof Error ? error.message : String(error));
        } finally {
          setRunningState(false);
        }
      });
    </script>
  </body>
</html>`);
  });

  app.post("/testing/run", {
    schema: {
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          steps: {
            type: "object",
            properties: {
              discovery: { type: "boolean" },
              approval: { type: "boolean" },
              snapshotCapture: { type: "boolean" },
              schema: { type: "boolean" }
            }
          }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: { url: string; steps?: { discovery?: boolean; approval?: boolean; snapshotCapture?: boolean; schema?: boolean } } }>, reply: FastifyReply) => {
    if (deps.environment.nodeEnv !== "development") {
      throw new ApplicationError("not_found", "Testing dashboard is only available in development", false);
    }

    const parsed = runPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApplicationError("invalid_request", "Invalid testing request", false);
    }

    const startedAt = Date.now();
    const logs: string[] = [];
    const generatedIds: string[] = [];
    const steps = parsed.data.steps;
    let errorMessage: string | null = null;
    let acquisitionDiagnostics: readonly { readonly url: string; readonly stage: "Acquisition"; readonly reason: string }[] = [];

    try {
      const source = await deps.sourceService.createSource({ sourceType: "website", url: parsed.data.url });
      generatedIds.push(source.id);
      logs.push(`Created source ${source.id}`);

      let discoveryResultId: string | null = null;
      let candidateId: string | null = null;
      let datasetId: string | null = null;
      let snapshotCollectionId: string | null = null;
      let schemaId: string | null = null;
      let discoveredDatasets = 0;
      let pagesCrawled = 0;
      let snapshotsCaptured = 0;
      let schemaFields = 0;
      let phase4: DevelopmentPhase4WorkflowResult | null = null;

      if (steps.discovery) {
        const preview = await deps.discoveryService.discover(source.id, { ...defaultDiscoveryLimits, maxPages: 10, maxDepth: 2, allowedOrigins: [] });
        discoveryResultId = preview.discoveryResultId;
        discoveredDatasets = preview.candidates.length;
        pagesCrawled = preview.candidates.reduce((total, candidate) => total + candidate.estimatedPageCount, 0);
        candidateId = preview.candidates[0]?.candidateId ?? null;
        logs.push(`Discovery completed for ${preview.candidates.length} candidate(s)`);
        acquisitionDiagnostics = await deps.discoveryService.acquisitionDiagnostics(preview.discoveryResultId);
        for (const diagnostic of acquisitionDiagnostics) logs.push(`${diagnostic.stage} failed for ${diagnostic.url}: ${diagnostic.reason}`);
        if (preview.candidates.length === 0 && acquisitionDiagnostics.length > 0) {
          errorMessage = "Discovery could not produce dataset candidates because acquisition failed.";
          logs.push("Dataset approval skipped because prerequisite discovery did not succeed.");
          logs.push("Snapshot capture skipped because prerequisite discovery did not succeed.");
          logs.push("Schema generation skipped because prerequisite discovery did not succeed.");
        }
      }

      if (steps.approval && discoveryResultId && candidateId) {
        const approved = await deps.discoveryService.approveAndCapture({ candidateIds: [candidateId], approvedBy: "testing-dashboard", scope: ["default"], crawlBudget: { maxPages: 5, maxDepth: 1, maxBytesPerPage: 1_000_000, timeoutMs: 10_000, maxRedirects: 5 } });
        datasetId = approved.dataset.id;
        snapshotCollectionId = approved.snapshots.id;
        generatedIds.push(approved.dataset.id, approved.crawlPlan.id, approved.snapshots.id);
        logs.push(`Approval completed for dataset ${approved.dataset.id}`);
      }

      if (steps.snapshotCapture && snapshotCollectionId) {
        snapshotsCaptured = (await deps.discoveryService.preview(discoveryResultId!)).candidates.length;
        logs.push(`Snapshot capture completed for ${snapshotCollectionId}`);
      }

      if (steps.schema && snapshotCollectionId) {
        const schema = await deps.schemaService.analyze(snapshotCollectionId);
        schemaId = schema.id;
        schemaFields = schema.fields.length;
        generatedIds.push(schema.id);
        logs.push(`Schema generation completed with ${schema.fields.length} field(s)`);
        phase4 = await deps.phase4Workflow.run(schema.datasetId, schema.snapshotCollectionId);
        logs.push("Schema Approval completed.");
        phase4.approvalDiagnostics.forEach((diagnostic) => logs.push(`Schema Approval: ${diagnostic}`));
        if (phase4.plan) logs.push(`Extraction Plan generated: ${phase4.plan.planId}`);
        else logs.push("Extraction Plan skipped.");
        if (phase4.planValidationDiagnostics.length > 0) {
          logs.push(`Extraction Plan Validation failed with ${phase4.planValidationDiagnostics.length} error(s).`);
          phase4.planValidationDiagnostics.forEach((diagnostic) => logs.push(`Extraction Plan Validation [${diagnostic.validationRuleId}]: ${diagnostic.explanation} Suggested correction: ${diagnostic.suggestedCorrection}`));
        }
        if (phase4.result) logs.push(`Extraction Execution completed with ${phase4.result.metrics.recordsExtracted} record(s).`);
        else logs.push("Extraction Execution skipped.");
        if (phase4.evaluation) logs.push(`Evaluation completed: ${phase4.evaluation.outcome}.`);
        if (phase4.error) logs.push(`Phase 4: ${phase4.error}`);
      }

      const schemaRunMetadata = deps.schemaService.getLastRunMetadata?.() ?? null;

      return reply.send({
        elapsedMs: Date.now() - startedAt,
        sourceId: source.id,
        discoveryResultId,
        candidateId,
        datasetId,
        snapshotCollectionId,
        schemaId,
        discoveredDatasets,
        pagesCrawled,
        snapshotsCaptured,
        schemaFields,
        provider: deps.providerName,
        model: deps.providerModel,
        promptTokens: schemaRunMetadata?.promptTokens ?? 0,
        completionTokens: schemaRunMetadata?.completionTokens ?? 0,
        totalTokens: schemaRunMetadata?.totalTokens ?? 0,
        generatedIds,
        logs,
        acquisitionDiagnostics,
        error: errorMessage,
        phase4,
        schemaPreview: schemaRunMetadata?.schemaPreview ?? null
      } satisfies TestingDashboardRunResult);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`Pipeline failed: ${errorMessage}`);
      const schemaRunMetadata = deps.schemaService.getLastRunMetadata?.() ?? null;
      return reply.status(500).send({
        elapsedMs: Date.now() - startedAt,
        sourceId: null,
        discoveryResultId: null,
        candidateId: null,
        datasetId: null,
        snapshotCollectionId: null,
        schemaId: null,
        discoveredDatasets: 0,
        pagesCrawled: 0,
        snapshotsCaptured: 0,
        schemaFields: 0,
        provider: deps.providerName,
        model: deps.providerModel,
        promptTokens: schemaRunMetadata?.promptTokens ?? 0,
        completionTokens: schemaRunMetadata?.completionTokens ?? 0,
        totalTokens: schemaRunMetadata?.totalTokens ?? 0,
        generatedIds,
        logs,
        acquisitionDiagnostics: [],
        error: errorMessage,
        phase4: null,
        schemaPreview: schemaRunMetadata?.schemaPreview ?? null
      } satisfies TestingDashboardRunResult);
    }
  });
}
