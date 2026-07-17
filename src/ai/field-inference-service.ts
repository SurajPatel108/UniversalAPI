/*
Purpose: have AI identify the meaningful fields and repeated entities available in a source.
Responsibilities: infer candidate field names, types, examples, requiredness, and source evidence before selector planning.
Connections: schema and selector generation consume this output; repair compares it with failed field diagnostics.
Future: multimodal document understanding, domain-specific vocabularies, and cross-refresh field matching.
Best practice: retain evidence references and confidence per field so uncertain inferences can be reviewed or gated.
*/

import type { AiContext, AiProvenance } from "./ai-types.js";

export interface InferredField { readonly name: string; readonly type: string; readonly evidence: string; readonly confidence: number; }
export interface FieldInference { readonly fields: readonly InferredField[]; readonly provenance: AiProvenance; }
export interface FieldInferenceService { infer(context: AiContext): Promise<FieldInference>; }

