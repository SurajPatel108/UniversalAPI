/*
Purpose: define the source aggregate, the durable identity and connector configuration of a customer data source.
Responsibilities: describe source kind, location/configuration, ownership, refresh settings, endpoint identity, and lifecycle status.
Connections: repositories persist it; SourceService creates it; a Connector selected by sourceType captures it.
Future: add tenant IDs, access policies, refresh schedules, and source credentials references.
Best practice: validate source configuration and state transitions at the domain boundary; store only credential references, never secrets.
*/

export type SourceStatus = "draft" | "active" | "paused" | "failed";
export type SourceType = "website" | "pdf" | "spreadsheet" | "database" | "notion" | "custom";
export interface Source {
  id: string;
  publicSlug: string;
  sourceType: SourceType;
  url: string;
  status: SourceStatus;
  createdAt: Date;
  updatedAt: Date;
}
