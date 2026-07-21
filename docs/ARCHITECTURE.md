# Architecture overview

## Core design rules

- Depend on interfaces in `models` and `database`/`cache`/`jobs` ports, never vendor SDKs in services.
- Keep HTTP, worker, and scheduled entry points thin; application services contain use-case orchestration.
- Treat discovery results, dataset candidates, crawl plans, schemas, and extraction plans as versioned, reproducible artifacts with source snapshots, model/prompt provenance, evaluation, and diagnostics.
- Treat `DatasetCandidate` as an automatically proposed logical collection and `Dataset` as the explicitly user-approved collection. `Dataset` is the unit of extraction, publication, monitoring, and repair; it never exists until its candidate selection is approved.
- Make source adapters additive: every website, PDF, spreadsheet, database, Notion, or future adapter implements the generic `Connector` contract instead of changing the pipeline.
- Make AI the primary planner for source and dataset understanding, but make deterministic execution and policy the authority for crawling, extraction, and publication.
- Make operations idempotent. A retried discovery, crawl, or refresh must not create conflicting artifact versions or endpoints.
- Bound discovery and crawling by connector policy and user-approved scope. Never expand a dataset's publication scope merely because AI found related content.

## Dataset-centric lifecycle

```text
Source
  -> Discovery
  -> Discovery Result
  -> Dataset Candidate(s)
  -> Discovery Preview
  -> user Dataset Selection
  -> Dataset
  -> versioned Crawl Plan
  -> Snapshot Collection
  -> AI Schema Understanding
  -> AI Extraction Planning
  -> Deterministic Extraction and Validation
  -> Published API
  -> Monitoring
  -> AI Repair
```

Deterministic discovery creates evidence; AI turns that evidence into choices, but neither creates a `Dataset`. A `DiscoveryPreview` presents `DatasetCandidate`s for explicit user selection. Each approved selection creates a `Dataset` with its own crawl scope, immutable snapshots, schema and extraction-plan lineage, quality evidence, and publication lifecycle. A single source can therefore support multiple independently published APIs without conflating their data or monitoring state.

## Bounded modules

| Module | Owns | Must not own |
| --- | --- | --- |
| API/routes | HTTP validation, status mapping, source registration, dataset review/selection, API delivery | crawling or persistence queries |
| Services | use-case orchestration and approval transitions | framework handlers or vendor SDK calls |
| Connectors | source-specific validation, bounded discovery, crawl capture, and capability reporting | AI prompt policy or public API shaping |
| Discovery | deterministic site/source map, collected pages/metadata, navigation structure, and membership evidence | AI classification, user intent selection, or public API shaping |
| Dataset classification | AI grouping of discovery evidence into `DatasetCandidate`s with confidence, explanations, and estimates | source exploration, crawl-scope determination, user selection, or public API shaping |
| Discovery preview | user-facing summary of `DatasetCandidate`s before selection | crawl execution, automatic selection, or public API shaping |
| Crawl planning | selected-scope expansion into a versioned, bounded crawl plan | AI extraction decisions or direct publication |
| AI | dataset/schema/field/plan inference and repair proposals | direct user selection, publication, or arbitrary code execution |
| Crawlers | planned retrieval and per-page snapshot metadata | selector interpretation or scope expansion outside a plan |
| Parsers | raw content to navigable documents | business-field extraction |
| Extractors | documents to extracted record candidates | delivery formatting |
| Normalizers | canonical JSON and schema checks | remote fetching |
| Database/cache/jobs | infrastructure adapter contracts | domain policy |
| Workers | job execution, resumability, and retries | HTTP response formatting |

## Domain artifacts and ownership

| Artifact | Purpose | Key invariants |
| --- | --- | --- |
| `Source` | Configured input, connector type, ownership, and lifecycle boundary | Phase 1 registration contract remains intact; it is not itself an API dataset. |
| `DiscoveryResult` | Immutable output of one bounded, deterministic exploration of a source | Records limits, site/source map, collected pages/metadata, observed links, navigation evidence, exclusions, and costs. |
| `DatasetCandidate` | AI-produced proposed logical dataset derived from a `DiscoveryResult` | Contains grouping/membership evidence, classification, confidence, explanation, representative pages, estimates, and known risks; it is not crawlable or publishable. |
| `DiscoveryPreview` | User-facing architectural summary of `DatasetCandidate`s before approval | Presents candidate name, classification, estimated pages/records/crawl cost or time, confidence, representative pages, and known risks/access limitations. It never selects a candidate. |
| `Dataset` | Explicitly user-approved logical collection created from one or more compatible `DatasetCandidate`s | Has a stable identity, approval state, selected scope, and membership semantics; only this artifact may receive a crawl plan or be published independently. |
| `CrawlPlan` | Versioned deterministic enumeration and capture policy for one dataset | Includes scope rules, seed/known URLs, pagination strategy, budgets, exclusions, and provenance. It cannot silently widen selected scope. |
| `SnapshotCollection` | Immutable, addressable set of snapshots and crawl outcomes from a crawl-plan run | Preserves page-level content, metadata, ordering/membership, failures, skips, and completeness status. |
| `Schema` | Versioned public data contract proposed from dataset samples | References the dataset and snapshot-collection revision, sample rationale, evidence, and evaluation. |
| `ExtractionPlan` | Versioned declarative instructions for deterministic extraction across the collection | Specifies page/record/field rules, normalization, and expected coverage; AI proposes it, deterministic code executes it. |
| `PublishedAPI` | Stable externally served binding for a dataset | References approved schema, extraction-plan, and validated output versions; preserves rollback and record lineage. |

`ExtractionVersion` remains immutable deterministic output, but it is dataset-scoped: it records results and quality evidence across a snapshot collection rather than treating one capture as the complete source of truth. Cache entries are disposable projections of a published dataset version. Store durable truth in PostgreSQL; never use cache as the only record.

## Discovery and selection boundary

For websites, deterministic discovery begins at the configured URL and is limited by policy: allowed origins/path scope, robots requirements, redirect policy, depth, pages, bytes, elapsed time, request rate, rendering allowance, and authentication constraints. It explores structural signals such as navigation, breadcrumbs, category/index pages, internal links, pagination, and authorized sitemaps. It collects pages, navigation structure, metadata, and membership evidence, and records why each URL was included, excluded, deduplicated, or left unvisited. AI does not perform this exploration.

AI analyzes the deterministic `DiscoveryResult` to group its evidence into `DatasetCandidate`s and estimate their size, page types, extraction complexity, and risk. Every candidate includes confidence and an explanation; AI never determines crawl scope or makes an implicit product decision. The resulting `DiscoveryPreview` presents each candidate's name, classification, estimated page count, estimated record count when available, estimated crawl cost/time, confidence, representative pages, and known risks/access limitations. The user selects one or more candidates and approves scope; only then does the system create a `Dataset` and activate its crawl plan. Changes that would materially expand membership during refresh return to review unless an explicit, bounded policy already authorizes the change.

## Collection-level planning and validation

Schema understanding uses representative samples selected across page types, paths, templates, pagination positions, and observed variation. Sampling is reproducible and its rationale is stored. Extraction planning then produces declarative instructions capable of processing every applicable snapshot in the collection, including known page-type variants.

Deterministic execution records per-snapshot results and validates aggregate properties: crawl completeness, expected membership, record coverage, duplicate rate, field/schema conformance, type stability, required-field completeness, and outlier/error rates. A candidate may be previewed, but it can be published only when deterministic policy evaluates the collection-level evidence as acceptable. Human review remains available at dataset selection, schema/plan approval, and publication/rollback decisions.

## Extension path

For websites, `WebsiteConnector` uses a configured Crawl4AI sidecar as a private acquisition implementation. Crawl4AI output is mapped to neutral connector artifacts (HTML, markdown, cleaned content, metadata, links, and optional screenshots) before it reaches domain services. The connector remains responsible for deterministic scope and budget enforcement; Crawl4AI types and wire formats never escape the connector.

Add a source by implementing `Connector` for its `SourceType` and registering it in `ConnectorRegistry`. The connector validates configuration and supports the source's bounded discovery/enumeration and snapshot capture semantics. For non-web sources, discovery maps to their native collection structure: sheets/ranges, tables, folders, documents, query partitions, or other enumerable units. The generic pipeline still produces the same dataset artifacts.

Connector-specific deterministic executors can be added only where the common parser/extractor is insufficient. Schema generation, field inference, selector generation, and repair live in `src/ai` behind provider-neutral interfaces. All proposals require deterministic validation, evaluation, audit, and approval policy before publication.

## AI-first control loop

1. A Connector safely and deterministically discovers authorized source structure within a bounded budget, collecting pages, navigation, metadata, and evidence in a `DiscoveryResult`.
2. AI analyzes that result to produce confidence-scored `DatasetCandidate`s with explanations and estimates; it does not crawl or determine scope.
3. A `DiscoveryPreview` presents candidates for user review. The user explicitly selects candidate scope, creating a `Dataset`.
4. The system versions a `CrawlPlan`, captures a `SnapshotCollection`, and records coverage and failures.
5. `FieldInferenceService` and `SchemaGenerationService` analyze representative collection samples and propose a dataset schema.
6. `SelectorGenerationService` proposes a declarative dataset `ExtractionPlan`.
7. Deterministic parsers, extractors, normalizers, and validators execute the plan across the collection and version evaluated output if policy permits.
8. A `PublishedAPI` serves an approved dataset version. Monitoring detects membership, content, structural, and quality drift.
9. `RepairService` proposes a revised plan from redacted diagnostics and samples; the same selection, evaluation, approval, and rollback gates apply.

AI never receives unneeded credentials, performs source exploration, determines crawl scope, directly executes generated code, silently selects a dataset, silently broadens crawl scope, or mutates a published endpoint. Prompt/model provenance and evidence are retained with every proposal.
