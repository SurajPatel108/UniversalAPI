/*
Purpose: define durable storage for definitions, snapshots, and extraction versions.
Responsibilities: persist immutable artifacts and atomically choose the current published version.
Connections: refresh orchestration writes through this port; endpoint delivery reads through it.
Future: migrations, retention, audit history, and transaction implementations.
Best practice: use explicit transactions when a version publication changes several records.
*/

import type { ExtractionDefinition, ExtractionVersion } from "../models/extraction.js";
export interface ExtractionRepository { findDefinition(sourceId: string): Promise<ExtractionDefinition | null>; saveVersion(version: ExtractionVersion): Promise<void>; findPublishedVersion(sourceId: string): Promise<ExtractionVersion | null>; }

