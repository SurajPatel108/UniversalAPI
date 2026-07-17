/*
Purpose: transform a parsed website document into candidate records using an extraction definition.
Responsibilities: apply selectors/rules and record field-level provenance and diagnostics.
Connections: refresh worker supplies parser output; normalizer validates the resulting candidates.
Future: list discovery, JSON-LD support, multiple strategies, and AI-proposed rule evaluation.
Best practice: extraction must be deterministic for a given document and definition revision.
*/

import type { ExtractionDefinition } from "../models/extraction.js";
import type { ParsedDocument } from "../parsers/html-parser.js";
export interface WebsiteExtractor { extract(document: ParsedDocument, definition: ExtractionDefinition): Promise<unknown>; }

