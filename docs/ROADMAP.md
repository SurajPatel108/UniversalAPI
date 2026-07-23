# Build roadmap

Each phase produces a deployable vertical slice, tests, metrics, and an explicit rollback path before proceeding. Phase 1 is complete and remains unchanged. Beginning in Phase 2, a source can contain multiple logical datasets; the platform discovers them, the user selects the intended dataset or datasets, and all later work operates over snapshot collections rather than a single webpage.

## Phase 1 — foundation, source registration, and connector contract

Add Fastify, environment validation, structured logging, migrations, authentication/tenancy, and `POST/GET /v1/sources`. Persist source type, connector configuration, ownership, refresh policy, and lifecycle status. Define `Connector`, `ConnectorRegistry`, secret references, and capability metadata now so every later source fits the same contract.

## Phase 2 — website discovery, AI dataset classification, selection, and bounded crawling

Evolve the website Connector into a safe, bounded discovery and crawl capability without changing Phase 1 source registration. Use Crawl4AI as a private, configured website-acquisition engine behind that connector; map its output to neutral snapshots and never expose its types outside the connector. Starting from the provided URL, apply DNS/IP safety checks, robots policy, redirect limits, timeouts, rate limits, content-size limits, origin/scope rules, and configurable page, depth, duration, and rendering budgets.

Deterministic discovery explores navigation menus, category and index pages, internal links, sitemaps when authorized, and other structural pages within those limits. It persists an auditable hierarchical site map and a `DiscoveryResult` containing collected pages, navigation structure, metadata, and membership evidence. AI analyzes that deterministic result to produce proposed logical `DatasetCandidate`s—such as products, listings, documentation, articles, categories, collections, and directories. Each candidate includes its membership evidence, URL-pattern and navigation rules, representative pages, estimated page count, estimated record count when possible, crawl cost/time and complexity, access constraints, confidence, and explanation. AI does not explore pages, determine crawl scope, or select candidates.

Expose a `DiscoveryPreview` as the reviewable, user-facing summary of `DatasetCandidate`s before selection. It presents candidate name, classification, estimated page count, estimated record count when possible, estimated crawl cost/time, confidence, representative pages, and known risks or access limitations. The user explicitly approves one or more candidates, optionally adjusts permitted scope/budget, and each approval creates a `Dataset`; the system then creates a versioned `CrawlPlan` for that dataset. Deterministic crawling captures an immutable `SnapshotCollection`: one content snapshot and crawl outcome for every planned dataset page, including skipped, failed, duplicate, and out-of-scope decisions. Ship discovery/crawl telemetry, fixtures, resumability, idempotency, and clear partial-crawl status. This is the first dataset-centric implementation of the source-agnostic connector boundary.

## Phase 3 — AI schema and field understanding across datasets

Implement provider-neutral FieldInferenceService and SchemaGenerationService adapters that analyze representative, deterministically selected samples from a SnapshotCollection, never the entire dataset. Sampling must be stratified across page types, navigation depth, and record variation while operating within configurable AI budgets for maximum pages, bytes, input tokens, output tokens, and execution time. If the configured AI budget would be exceeded, the request must fail rather than silently expanding AI usage.

Before invoking AI, deterministically preprocess every sampled snapshot by removing non-semantic content such as scripts, stylesheets, navigation chrome, advertisements, tracking elements, comments, and other irrelevant markup, producing a reduced semantic representation suitable for inference. AI receives only these reduced representations together with deterministic metadata and evidence references, never raw crawls or live websites.

The services identify record boundaries, fields, optionality, type variation, relationships, pagination or collection semantics, and dataset-level consistency. AI is responsible only for semantic understanding of the sampled dataset; it never crawls pages, requests additional content, expands crawl scope, generates extraction code, performs normalization, or executes business logic.

Require structured JSON output conforming to validated schemas, including confidence scores, evidence references, representative examples, detected relationships, sample-selection rationale, model identifier, prompt version, and provider metadata. Reject free-form natural language responses that do not satisfy the required output schema.

Persist a versioned Schema proposal associated with the dataset and snapshot-collection revision, together with immutable AI provenance including provider, model version, prompt version, preprocessing version, sampling strategy, confidence scores, and evaluation metadata. Cache AI analyses by snapshot fingerprint, preprocessing version, sampling strategy, prompt version, and model version so identical inputs reuse existing results instead of invoking the provider again.

Build a redacted multi-page fixture corpus and offline evaluation harness before using proposals in customer flows. Deterministic validation verifies sample coverage, schema validity, evidence completeness, confidence thresholds, and output consistency before any proposal may be accepted. Confidence-based policy determines whether proposals are automatically accepted, require manual review, or are rejected. AI is introduced here solely as the semantic understanding layer, while deterministic systems remain responsible for sampling, preprocessing, validation, caching, execution, and all downstream behavior.

## Phase 4 — AI-generated dataset extraction plans with deterministic execution

Implement a provider-neutral ExtractionPlanGenerationService responsible for producing versioned, declarative extraction plans from an approved Schema and representative samples from a SnapshotCollection. AI operates only on deterministic inputs produced by previous phases and never accesses live websites, performs crawling, executes extraction, or expands dataset scope.

Before invoking AI, deterministically prepare representative snapshots using the approved sampling strategy established during schema generation. Inputs consist only of preprocessed semantic representations, validated schema proposals, dataset metadata, page classifications, representative examples, evidence references, and deterministic crawl metadata. Raw crawls, live websites, connector implementations, and execution logic are never provided directly to the model.

The model produces a structured, versioned ExtractionPlan conforming to a strictly validated JSON schema. The plan is entirely declarative and contains no executable code, JavaScript, XPath scripts, Python, regular-expression programs beyond approved declarative primitives, or arbitrary expressions. AI proposes extraction intent only; deterministic systems remain responsible for execution.

The ExtractionPlan must describe every deterministic behavior required to extract the dataset, including:

dataset identity and schema version
supported page types
record discovery strategy
collection boundaries
field extraction definitions
nested record relationships
pagination behavior
normalization rules
validation rules
duplicate-handling policy
missing-field policy
confidence scores
evidence references
representative examples
AI provenance
prompt version
provider and model metadata

Record discovery defines how individual records are identified within each supported page type using declarative selectors and structural rules. Field definitions specify deterministic extraction primitives such as element selection, text extraction, attribute extraction, HTML extraction where explicitly permitted, optional transformations, required-field behavior, default values, and normalization requirements. Relationships between parent and child records are explicitly represented so nested collections may be extracted without ambiguity.

Normalization is completely deterministic. It includes operations such as whitespace normalization, currency parsing, numeric conversion, boolean normalization, date parsing, enumeration mapping, URL canonicalization, text cleanup, null handling, duplicate elimination, and other approved transformations. AI proposes these rules, but deterministic components execute every transformation.

The ExtractionPlan also specifies deterministic validation requirements including required-field constraints, schema conformance, uniqueness requirements, cardinality expectations, record completeness thresholds, field-level confidence thresholds, collection-level coverage expectations, and page-type consistency requirements.

After generation, deterministic validation verifies that the proposed ExtractionPlan satisfies the required JSON schema, references only approved declarative extraction primitives, contains complete evidence references, supports every discovered page type, references only approved schema fields, and contains no executable content or unsupported operations. Invalid plans are rejected before execution.

Approved plans are executed by a deterministic Extraction Engine against every applicable snapshot within the SnapshotCollection. The engine performs static DOM parsing and applies the declarative ExtractionPlan without invoking AI during execution. Every page is processed identically using deterministic parsing rules to ensure reproducibility, consistency, and repeatability across executions.

Execution produces a versioned ExtractionResult containing structured records, extraction diagnostics, normalization statistics, validation results, coverage metrics, duplicate statistics, skipped pages, failed pages, unsupported pages, field-level success rates, collection-level completeness, execution timing, and deterministic execution metadata.

Following execution, an Evaluation Service performs deterministic quality analysis across the entire dataset. Evaluation verifies schema conformance, field completeness, extraction coverage, duplicate rates, normalization success, page-type consistency, representative edge cases, record quality, and aggregate dataset integrity. Evaluation generates reproducible quality metrics independent of the AI provider.

Quality policies determine whether an ExtractionPlan is automatically accepted, requires human review, or is rejected. Approval decisions are based on deterministic quality thresholds rather than model confidence alone. Human reviewers may inspect generated plans, evaluation reports, representative extracted records, diagnostics, and evidence before approving publication. Manual edits remain supported but are not the primary architectural path.

Persist immutable versions of the ExtractionPlan, ExtractionResult, EvaluationReport, and approval decision together with complete lineage including dataset identity, schema version, SnapshotCollection revision, preprocessing version, sampling strategy, prompt version, provider, model version, execution engine version, evaluation version, timestamps, diagnostics, and audit metadata. Every published dataset must remain fully traceable from API responses back to the exact snapshots, schema proposal, extraction plan, and evaluation that produced it.

Cache generated ExtractionPlans using deterministic cache keys derived from snapshot fingerprints, preprocessing version, schema version, prompt version, provider, and model version so identical inputs reuse previously validated plans without additional AI invocations.

Develop a comprehensive offline evaluation harness before production deployment. Maintain a redacted fixture corpus spanning diverse websites, layouts, pagination styles, nested collections, edge cases, and malformed pages. Every ExtractionPlan implementation must pass deterministic regression tests, quality thresholds, and reproducibility checks before customer-facing use.

AI is introduced in this phase solely as a semantic planner that proposes declarative extraction strategies. Deterministic systems remain authoritative for execution, normalization, validation, quality evaluation, caching, approval, persistence, auditing, and every downstream behavior. No AI model executes extraction logic, bypasses validation, expands dataset scope, modifies crawl plans, or directly produces customer-visible API responses.

## Phase 5 — dataset API publication

Add stable public API slugs, endpoint authorization, dataset/plan version selection, pagination, filtering, response envelopes, OpenAPI docs, and dataset-level quotas. A published API binds a selected dataset to an approved schema and extraction-plan version, and serves records extracted from its validated snapshot collection. Endpoint URLs must remain stable while an underlying published version changes. Publication must make lineage from response records to dataset, plan, and snapshots auditable.

## Phase 6 — dataset refresh, cache, and recrawl workflow

Introduce Redis, a durable job queue, idempotency keys, retries/backoff, dead-letter handling, and manual refresh. Refresh begins with bounded rediscovery or plan-aware recrawling, reconciles dataset membership against the approved crawl plan, then captures a new snapshot collection before extraction. Define incremental recrawl eligibility, additions/removals, tombstones, partial-refresh policy, and when changed discovery requires user review rather than automatic expansion of scope.

Cache only validated published dataset versions and define invalidation after publication. Load-test concurrent reads, discovery, crawling, refreshes, and partial-failure recovery.

## Phase 7 — dataset monitoring, change detection, and AI-driven replanning

Schedule dataset refreshes and monitor crawl-plan conformance, membership drift, page availability, snapshot fingerprints, extraction coverage, schema conformance, record freshness, and output quality across the collection. Classify meaningful structural/data changes separately from cosmetic page changes; alert owners and expose dataset health, lineage, and history.

On meaningful drift, run AI replanning against representative changed and unchanged samples, then deterministically evaluate the candidate plan across the dataset before promotion. Add SLOs for API freshness, crawl completeness, extraction success/coverage, plan quality, latency, and AI cost.

## Phase 8 — AI repair, evaluation, and controlled dataset publication

Implement `RepairService` as a first-class dataset replanning path that receives redacted diagnostics, failed/changed page samples, prior plan evidence, and coverage statistics. It proposes a revised `ExtractionPlan` and, when warranted, a schema or crawl-plan review request; it cannot silently expand the user's selected dataset. Evaluate candidate repairs against historical snapshot collections, current representative fixtures, and live canaries, with per-page and aggregate thresholds.

Apply confidence/risk thresholds, retain one-click rollback, and automate publication only for explicitly approved low-risk policies. Never let a model bypass deterministic gates, user dataset selection, or the audit trail.

## Phase 9 — additional sources and dataset discovery adapters

Implement PDF, spreadsheet, database, Notion, and internal-dashboard Connectors behind the common source, deterministic discovery, dataset-candidate, dataset, crawl-plan, snapshot-collection, and publication contracts. Where an adapter cannot crawl URLs, define its bounded enumeration equivalent—for example sheets/ranges, tables, folders, collections, or query partitions. Add connector-specific deterministic executors where needed, credentials-vault integration, security reviews, and capability discovery.

Reuse the same AI understanding, planning, evaluation, monitoring, repair, and publication controls rather than creating source-specific product paths.
