/*
Purpose: describe the durable command that requests one source refresh.
Responsibilities: carry only serializable identifiers needed by a worker and support idempotency.
Connections: SourceService enqueues it; RefreshSourceWorker consumes it through a queue adapter.
Future: add trace context, attempt metadata, priority, and scheduled-run provenance.
Best practice: jobs are commands, not serialized service objects or raw webpage content.
*/

export interface RefreshSourceJob { sourceId: string; requestedAt: string; idempotencyKey: string; }

