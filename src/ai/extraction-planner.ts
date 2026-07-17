/*
Purpose: orchestrate AI-first creation or revision of an extraction definition.
Responsibilities: sequence field inference, schema generation, selector generation, and deterministic proposal validation.
Connections: RefreshSourceWorker calls it for initial setup and meaningful source change; it delegates to narrowly scoped AI services.
Future: policy-aware model routing, plan comparison, user feedback incorporation, and evaluation scoring.
Best practice: centralize AI orchestration here so prompts, budgets, provenance, and guardrails remain consistent across connectors.
*/

export class ExtractionPlanner { /* Compose AI proposal services and validation policy in a later implementation phase. */ }

