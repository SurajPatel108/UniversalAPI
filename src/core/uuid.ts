/*
Purpose: provide a stable UUID generator for domain entities.
Responsibilities: create RFC 4122-compliant IDs for sources and other aggregates.
Connections: SourceService uses it when creating new Source records.
Future: swap this implementation for a library or a database-generated ID once persistence lands.
Best practice: keep the generator small and deterministic in behavior.
*/

import { randomUUID } from "node:crypto";

export function generateUuid(): string {
  return randomUUID();
}
