/*
Purpose: model configured extraction rules and immutable results from a refresh.
Responsibilities: separate editable definitions from published output versions and diagnostics.
Connections: extractors produce candidates; normalizers validate them; repositories retain versions.
Future: add JSON Schema, selector strategies, provenance, and approval/audit fields.
Best practice: never mutate published versions; create a new version for every successful refresh.
*/

export interface ExtractionDefinition { id: string; sourceId: string; schema: unknown; revision: number; }
export interface ExtractionVersion { id: string; sourceId: string; definitionRevision: number; data: unknown; createdAt: Date; }

