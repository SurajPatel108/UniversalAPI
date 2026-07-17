# Architecture overview

## Core design rules

- Depend on interfaces in `models` and `database`/`cache`/`jobs` ports, never vendor SDKs in services.
- Keep HTTP, worker, and scheduled entry points thin; application services contain use-case orchestration.
- Treat AI-generated schemas and extraction plans as versioned, reproducible artifacts with source snapshots, model/prompt provenance, evaluation, and diagnostics.
- Make source adapters additive: every website, PDF, spreadsheet, database, Notion, or future adapter implements the generic `Connector` contract instead of changing the pipeline.
- Make AI the primary planner for source understanding, but make deterministic execution and policy the authority for publication.
- Make operations idempotent. A retried refresh must not create conflicting versions or endpoints.

## Bounded modules

| Module | Owns | Must not own |
| --- | --- | --- |
| API/routes | HTTP validation, status mapping | crawling or persistence queries |
| Services | use-case orchestration | framework handlers or vendor SDK calls |
| Connectors | source-specific validation and snapshot capture | AI prompt policy or public API shaping |
| AI | schema/field/selector inference and repair proposals | direct publication or arbitrary code execution |
| Crawlers | source retrieval and snapshot metadata | selector interpretation |
| Parsers | raw content to navigable document | business-field extraction |
| Extractors | document to candidate records | delivery formatting |
| Normalizers | canonical JSON and schema checks | remote fetching |
| Database/cache/jobs | infrastructure adapter contracts | domain policy |
| Workers | job execution and retries | HTTP response formatting |

## Data ownership

`Source` is the configured input, connector type, and public endpoint identity. A `Connector` returns a neutral `SourceSnapshot` and captured content. The AI planner turns that capture into a confidence-scored schema, inferred fields, and an `ExtractionDefinition`. `ExtractionVersion` is immutable output from deterministic execution of a validated definition. Cache entries are disposable projections of a version. Store durable truth in PostgreSQL; never use cache as the only record.

## Extension path

Add a source by implementing `Connector` for its `SourceType` and registering it in `ConnectorRegistry`. The connector validates configuration and captures content; the AI layer works from the neutral capture. Connector-specific deterministic executors can be added only where the common parser/extractor is insufficient. Schema generation, field inference, selector generation, and repair live in `src/ai` behind provider-neutral interfaces. All proposals require deterministic validation, evaluation, audit, and approval policy before publication.

## AI-first control loop

1. A Connector captures authorized source content and immutable metadata.
2. `FieldInferenceService` identifies candidate records and fields; `SchemaGenerationService` proposes the public contract.
3. `SelectorGenerationService` produces a declarative plan for deterministic extraction.
4. The system executes the plan against the capture, validates normalized output and quality thresholds, then versions it if policy permits.
5. On drift or failure, `RepairService` proposes a revision; the same evaluation and rollback gate applies.

AI never receives unneeded credentials, directly executes generated code, or silently mutates a published endpoint. Prompt/model provenance and evidence are retained with every proposal.
