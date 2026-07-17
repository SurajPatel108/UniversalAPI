# Universal API

Universal API will turn changing information sources into stable, production-ready APIs. AI is the primary intelligence engine: from a captured source and user intent, it proposes the data schema, infers fields, and generates a declarative extraction plan. Deterministic execution, validation, versioning, and policy controls make those AI proposals safe to serve through stable REST endpoints.

This repository is intentionally a **blueprint**, not a crawler implementation. It establishes component boundaries, contracts, and delivery order so the product can grow from websites to PDFs, spreadsheets, databases, and internal tools without a rewrite.

## Architecture

`src/api` owns transport concerns only. It delegates to application services in `src/services`, which coordinate domain contracts from `src/models` and infrastructure ports. `src/connectors` is the common boundary for websites, PDFs, spreadsheets, databases, Notion, and future sources. `src/ai` plans schemas and extraction definitions; `src/parsers`, `src/extractors`, and `src/normalizers` execute and verify them deterministically. `src/database`, `src/cache`, and `src/jobs` are adapters/ports; `src/workers` runs asynchronous work.

```text
HTTP route -> SourceService -> RefreshSourceJob -> Worker
                                      |              |
                         Source repository     Connector -> Snapshot
                                      |                         |
                                  database      AI planner -> schema + fields + extraction plan
                                                               |
                                              deterministic parse/extract/normalize/validate
                                                               |
                                                        version + cache -> generated endpoint
```

The API layer must not import concrete database, browser, or queue libraries. Composition happens once in `src/core/container.ts`; production adapters can be replaced by test fakes through their interfaces.

## Request lifecycle

1. `POST /v1/sources` validates a website URL (or future connector configuration) and creates a source record.
2. The service enqueues a refresh job rather than crawling in the request path.
3. A worker resolves the source's generic Connector and captures an immutable source snapshot.
4. The AI planner infers fields, proposes a schema, and generates a declarative extraction plan; its provenance and confidence are retained.
5. Deterministic components execute and validate that plan against the snapshot, then persist a version and write a cache entry.
6. A generated endpoint resolves the source by public slug and returns the newest cached version.
7. Scheduled monitoring repeats the flow; AI repair produces a new candidate plan when validation or change detection indicates degradation.

## Suggested stack

Use Node.js + TypeScript, Fastify for HTTP, PostgreSQL with Prisma/Drizzle for durable state, Redis for cache and queues, BullMQ or Temporal for jobs, an LLM provider behind the `src/ai` interfaces, Playwright for JavaScript-rendered pages, Cheerio for static HTML, OpenTelemetry for observability, and Vitest/Testcontainers for tests. Select concrete tools behind the ports already present here.

## Development phases

The detailed, buildable sequence is in [docs/ROADMAP.md](docs/ROADMAP.md). Start with source registration and connector capture, then build AI planning with deterministic evaluation before endpoint publication. AI drives understanding and plan generation from the beginning, while no AI proposal is published until it passes validation, audit, and rollback policy.

## Getting started

Copy `.env.example` to `.env`, install the declared development dependencies, then run `npm run typecheck`. The server file is deliberately a composition placeholder; introduce a web framework only when Phase 1 is implemented. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before adding a feature.

## Repository map

- `src/` — production boundaries and contracts
- `src/connectors/` — generic source acquisition contracts and future source adapters
- `src/ai/` — provider-neutral AI planning and repair contracts
- `tests/` — unit, integration, contract, and fixture tests
- `docs/` — system design and phased delivery plan
