/*
Purpose: let AI diagnose a degraded refresh and propose a replacement schema or extraction plan as a normal pipeline capability.
Responsibilities: evaluate failure diagnostics against the latest snapshot and return a confidence-scored, testable revision.
Connections: monitoring/RefreshSourceWorker invoke it after validation failure; planner and approval policy evaluate its proposal.
Future: automated canaries, historical replay, human review queues, and controlled auto-publication by risk tier.
Best practice: repair can propose changes but must pass deterministic validation, evaluation, audit, and rollback rules before serving users.
*/

import type { AiContext, AiProvenance } from "./ai-types.js";

export interface RepairProposal { readonly revisedDefinition: unknown; readonly diagnosis: string; readonly provenance: AiProvenance; }
export interface RepairService { repair(context: AiContext, diagnostics: unknown): Promise<RepairProposal>; }

