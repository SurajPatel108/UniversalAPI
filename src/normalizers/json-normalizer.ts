/*
Purpose: establish the canonical JSON boundary that public API consumers receive.
Responsibilities: coerce safe primitive values, validate the configured schema, and attach diagnostics.
Connections: receives extractor candidates; produces data persisted as an ExtractionVersion and cached for delivery.
Future: JSON Schema engine, date/currency normalization, data-quality scores, and field provenance.
Best practice: reject ambiguous or invalid data explicitly; never silently change a published API contract.
*/

import type { ExtractionDefinition } from "../models/extraction.js";
export interface JsonNormalizer { normalize(candidate: unknown, definition: ExtractionDefinition): Promise<unknown>; }

