/*
Purpose: define provider-neutral AI inputs, outputs, provenance, and confidence for the extraction intelligence layer.
Responsibilities: constrain model calls to captured/authorized context and make every proposal auditable and evaluable.
Connections: all AI services use these contracts; extraction definitions and version diagnostics retain resulting provenance.
Future: token budgets, prompt-template versions, safety classifications, and model-provider routing.
Best practice: AI output is a typed proposal, never executable code or an unvalidated direct publication.
*/

import type { SourceSnapshot } from "../models/snapshot.js";

export interface AiContext { readonly snapshot: SourceSnapshot; readonly content: string | Uint8Array; readonly requestedOutcome?: string; }
export interface AiProvenance { readonly model: string; readonly promptVersion: string; readonly confidence: number; }

