/*
Purpose: declare persistence operations for sources without selecting an ORM or database.
Responsibilities: create, retrieve, and update Source aggregates with tenant scoping in real implementations.
Connections: SourceService depends on this interface; infrastructure adapters implement it.
Future: add optimistic concurrency and transactional publication methods.
Best practice: keep queries here/its adapter, not in routes or crawler code.
*/

import type { Source } from "../models/source.js";
export interface SourceRepository { create(source: Source): Promise<void>; findById(id: string): Promise<Source | null>; findBySlug(slug: string): Promise<Source | null>; }

