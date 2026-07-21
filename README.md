# Universal API

Universal API turns changing information sources into stable, production-ready dataset APIs. Starting in Phase 2, deterministic discovery safely collects source structure and evidence, AI classifies that evidence into `DatasetCandidate`s, and a `DiscoveryPreview` presents candidates for explicit user approval before a `Dataset` is crawled. AI is the primary intelligence engine for classification, schemas, and extraction plans; deterministic execution, validation, versioning, and policy controls make those proposals safe to serve through stable REST endpoints.

This repository is intentionally a **blueprint**, not a crawler implementation. It establishes component boundaries, contracts, and delivery order so the product can grow from websites to PDFs, spreadsheets, databases, and internal tools without a rewrite.

## Architecture

`src/api` owns transport concerns only. It delegates to application services in `src/services`, which coordinate domain contracts from `src/models` and infrastructure ports. `src/connectors` is the common boundary for websites, PDFs, spreadsheets, databases, Notion, and future sources. The website connector uses Crawl4AI only as a private, configured acquisition engine; no other module depends on its types or wire format. Starting in Phase 2, connectors support bounded discovery and planned collection capture. `src/ai` plans dataset schemas and extraction definitions; `src/parsers`, `src/extractors`, and `src/normalizers` execute and verify them deterministically across snapshot collections. `src/database`, `src/cache`, and `src/jobs` are adapters/ports; `src/workers` runs asynchronous work.

```text
HTTP route -> SourceService -> discovery job -> Worker
                                      |            |
                         Source repository   Connector -> DiscoveryResult
                                      |                          |
                                  database  AI -> DatasetCandidate(s)
                                                                 |
                                                   DiscoveryPreview -> user approval
                                                                 |
                                                          Dataset -> CrawlPlan
                                                                 |
                                                        SnapshotCollection
                                                                 |
                                    AI schema understanding + extraction planning
                                                                 |
                                  deterministic parse/extract/normalize/validate
                                                                 |
                                      dataset version + cache -> generated API endpoint
```

The API layer must not import concrete database, browser, or queue libraries. Composition happens once in `src/core/container.ts`; production adapters can be replaced by test fakes through their interfaces.

## Request lifecycle

1. `POST /v1/sources` validates a website URL (or future connector configuration) and creates a source record. This completed Phase 1 behavior remains unchanged.
2. Beginning in Phase 2, a worker resolves the generic Connector and safely performs a bounded discovery crawl rather than treating the source as one page.
3. The system stores a hierarchical, deterministic `DiscoveryResult` containing collected pages, navigation structure, metadata, and evidence.
4. AI analyzes that result into confidence-scored `DatasetCandidate`s; it does not explore pages, determine scope, or make the product decision.
5. A `DiscoveryPreview` presents candidates and their estimates for review. The user explicitly approves candidates, creating the dataset or datasets to become APIs.
6. A versioned `CrawlPlan` captures every selected dataset page into an immutable `SnapshotCollection`.
7. AI analyzes representative collection samples to propose a schema and declarative extraction plan; its provenance and confidence are retained.
8. Deterministic components execute and validate the plan across the collection, then persist a dataset version and write a cache entry when policy permits.
9. A generated endpoint resolves a published dataset by stable public slug and returns its approved version.
10. Scheduled monitoring repeats plan-aware discovery/crawling; AI repair produces a candidate plan when collection-level validation or change detection indicates degradation.

## Suggested stack

Use Node.js + TypeScript, Fastify for HTTP, PostgreSQL with Prisma/Drizzle for durable state, Redis for cache and queues, BullMQ or Temporal for jobs, an LLM provider behind the `src/ai` interfaces, Playwright for JavaScript-rendered pages, Cheerio for static HTML, OpenTelemetry for observability, and Vitest/Testcontainers for tests. Select concrete tools behind the ports already present here.

## Development phases

The detailed, buildable sequence is in [docs/ROADMAP.md](docs/ROADMAP.md), and the dataset lifecycle is specified in [docs/DATASET_ARCHITECTURE.md](docs/DATASET_ARCHITECTURE.md). Phase 1 remains source registration. From Phase 2 onward, discovery and user dataset selection precede crawl, AI planning, deterministic evaluation, and endpoint publication. No AI proposal is published until it passes validation, audit, and rollback policy.

## Getting started

Copy `.env.example` to `.env`, install the declared development dependencies, then run `npm run typecheck`. The server file is deliberately a composition placeholder; introduce a web framework only when Phase 1 is implemented. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before adding a feature.

## Repository map

- `src/` — production boundaries and contracts
- `src/connectors/` — generic source acquisition contracts and future source adapters
- `src/ai/` — provider-neutral AI planning and repair contracts
- `tests/` — unit, integration, contract, and fixture tests
- `docs/` — system design and phased delivery plan
