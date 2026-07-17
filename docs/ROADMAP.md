# Build roadmap

Each phase produces a deployable vertical slice, tests, metrics, and an explicit rollback path before proceeding.

## Phase 1 — foundation, source registration, and connector contract

Add Fastify, environment validation, structured logging, migrations, authentication/tenancy, and `POST/GET /v1/sources`. Persist source type, connector configuration, ownership, refresh policy, and lifecycle status. Define `Connector`, `ConnectorRegistry`, secret references, and capability metadata now so every later source fits the same contract.

## Phase 2 — safe website connector and source snapshots

Implement the website Connector using DNS/IP safety checks, robots policy, redirect limits, timeouts, rate limits, content-size limits, and HTML snapshot storage. Begin with static HTTP; add a separately budgeted browser renderer only for opt-in dynamic sites. Emit capture telemetry and fixtures for failures. This is the first implementation of the source-agnostic connector boundary.

## Phase 3 — AI-first schema and field understanding

Implement provider-neutral `FieldInferenceService` and `SchemaGenerationService` adapters. Require structured, confidence-scored output and persist model/prompt provenance, evidence, and evaluation inputs. Build a redacted fixture corpus and offline evaluation harness before using proposals in customer flows. AI is introduced here as the normal mechanism for understanding every source.

## Phase 4 — AI-generated extraction plans with deterministic execution

Implement `SelectorGenerationService`, declarative extraction definitions, static DOM parsing, preview, normalization, and quality validation. The model proposes a plan; parser/extractor code executes it deterministically against the snapshot. Persist immutable versions with snapshots, AI provenance, diagnostics, and approval outcome. Support human edits and review, but do not make manual selectors the architectural default.

## Phase 5 — endpoint publication

Add stable public slugs, endpoint authorization, version selection, pagination, filtering, response envelopes, OpenAPI docs, and source-level quotas. Endpoint URLs must remain stable while an underlying version changes.

## Phase 6 — cache and refresh workflow

Introduce Redis, a durable job queue, idempotency keys, retries/backoff, dead-letter handling, and manual refresh. Cache only validated published versions and define invalidation after publication. Load-test concurrent reads and refreshes.

## Phase 7 — monitoring, change detection, and AI-driven replanning

Schedule refreshes, fingerprint snapshots and extraction output, classify meaningful vs cosmetic changes, alert owners, and expose health/history. On meaningful drift, run AI replanning and deterministic evaluation before promotion. Add SLOs for endpoint freshness, success rate, plan quality, latency, and AI cost.

## Phase 8 — AI repair, evaluation, and controlled publication

Implement `RepairService` as a first-class replanning path that receives redacted diagnostics and proposes a revised definition. Evaluate it against historical fixtures and live canaries, apply confidence/risk thresholds, retain one-click rollback, and automate publication only for explicitly approved low-risk policies. Never let a model bypass the deterministic gate or audit trail.

## Phase 9 — additional sources

Implement PDF, spreadsheet, database, Notion, and internal-dashboard Connectors behind the common snapshot/pipeline contracts. Add connector-specific deterministic executors where needed, credentials-vault integration, security reviews, and capability discovery. Reuse the same AI planner, evaluation loop, and publication controls rather than creating separate product paths.
