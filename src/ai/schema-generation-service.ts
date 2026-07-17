/*
Purpose: make AI responsible for proposing the public data schema from a captured source and user intent.
Responsibilities: infer entities, fields, types, descriptions, cardinality, and a confidence-scored JSON Schema proposal.
Connections: AI extraction planning invokes it first; its proposal becomes an ExtractionDefinition only after validation/approval policy.
Future: examples-based prompting, schema evolution comparison, tenant vocabulary, and evaluation datasets.
Best practice: require structured output and validate it against a strict meta-schema before downstream use.
*/

import type { AiContext, AiProvenance } from "./ai-types.js";

export interface SchemaProposal { readonly schema: unknown; readonly rationale: string; readonly provenance: AiProvenance; }
export interface SchemaGenerationService { generate(context: AiContext): Promise<SchemaProposal>; }

