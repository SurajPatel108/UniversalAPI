/*
Purpose: declare persistence operations for sources without selecting an ORM or database.
Responsibilities: create, retrieve, and update Source aggregates with tenant scoping in real implementations.
Connections: SourceService depends on this interface; infrastructure adapters implement it.
Future: add optimistic concurrency and transactional publication methods.
Best practice: keep queries here/its adapter, not in routes or crawler code.
*/

import type { Source } from "../models/source.js";

export interface SourceRepository {
  create(source: Source): Promise<void>;
  findById(id: string): Promise<Source | null>;
  findBySlug(slug: string): Promise<Source | null>;
}

export class InMemorySourceRepository implements SourceRepository {
  private readonly sourcesById = new Map<string, Source>();
  private readonly sourcesBySlug = new Map<string, Source>();

  async create(source: Source): Promise<void> {
    this.sourcesById.set(source.id, source);
    this.sourcesBySlug.set(source.publicSlug, source);
  }

  async findById(id: string): Promise<Source | null> {
    return this.sourcesById.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<Source | null> {
    return this.sourcesBySlug.get(slug) ?? null;
  }
}

