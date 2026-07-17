/*
Purpose: use AI to generate a declarative, deterministic extraction plan for the inferred schema and source structure.
Responsibilities: propose selectors/query rules, record boundaries, transformation hints, and evidence for each field.
Connections: planner combines schema/field inference with this service; WebsiteExtractor later executes the validated plan without an LLM call.
Future: source-specific query languages for PDFs, spreadsheets, SQL, and Notion; competing-plan evaluation.
Best practice: generated selectors are data, not arbitrary code, and must be tested against the captured snapshot before publication.
*/

import type { AiContext, AiProvenance } from "./ai-types.js";
import type { FieldInference } from "./field-inference-service.js";

export interface SelectorProposal { readonly plan: unknown; readonly provenance: AiProvenance; }
export interface SelectorGenerationService { generate(context: AiContext, fields: FieldInference): Promise<SelectorProposal>; }

