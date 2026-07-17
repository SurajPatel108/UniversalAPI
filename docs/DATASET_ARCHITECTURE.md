# Dataset-centric discovery and crawl design

## Purpose

Starting in Phase 2, Universal API turns a source into one or more user-selected dataset APIs. This design replaces the former assumption that one source equals one captured webpage. It does not alter Phase 1: source registration remains the entry point and its existing behavior and contracts stay in place.

## Workflow

```text
Source -> DiscoveryResult -> DatasetCandidate(s) -> Discovery Preview
       -> User Selection -> Dataset -> Crawl Plan -> Snapshot Capture
       -> AI Schema Understanding -> AI Extraction Planning
       -> Deterministic Extraction -> API Publication -> Monitoring -> AI Repair
```

The arrow from `DiscoveryPreview` to user selection is a human-control boundary. Deterministic discovery collects evidence; AI classifies it into candidates; only a user approval creates a `Dataset` that can become an API.

## Discovery result specification

A `DiscoveryResult` is a versioned, immutable record of a bounded, deterministic inspection of a source. It must capture:

- Discovery configuration and effective limits: seed URL/configuration, allowed origins and paths, robots policy, redirects, request rate, maximum depth/pages/bytes/duration, rendering policy, and authorization context.
- A hierarchical source map with observed pages/resources, parent/child and navigational relationships, canonical URLs, link evidence, template/page-type hints, and crawl disposition.
- The evidence required for later classification: page relationships, repeated structural patterns, representative URLs/pages, inferred page-type hints, and observed access or quality risks.
- All exclusions and failures, including the policy or limit that caused each decision.

Discovery must be resumable and idempotent. It may be incomplete because a budget was reached; incompleteness is explicit metadata, never hidden as an exhaustive map. Discovery is responsible only for exploration and evidence collection; it does not group pages into datasets or decide crawl scope.

## Dataset candidates and discovery preview

AI analyzes a completed `DiscoveryResult`; it does not fetch pages or explore the source. It groups deterministic discovery evidence into one or more `DatasetCandidate`s. A candidate is a proposed logical dataset, not a selected dataset and not an executable crawl target. It includes its classification, grouping/membership evidence, confidence score, explanation, representative pages, estimated page count, estimated record count when possible, estimated crawl cost/time and complexity, and known risks or access limitations.

A `DiscoveryPreview` is the user-facing architectural artifact generated from those candidates before selection. It presents, for each `DatasetCandidate`, its name, classification, estimated page count, estimated record count when available, estimated crawl cost/time, confidence, representative pages, and known risks or access limitations. Its purpose is informed approval; it has no authority to select a candidate or determine scope.

## Dataset selection and crawl planning

A `Dataset` exists only after a user explicitly approves one or more compatible `DatasetCandidate`s from a `DiscoveryPreview`. Selection records the chosen discovery-result revision, selected candidate(s), user-visible scope, and approval identity/time. A dataset may be composed from one compatible candidate or an explicit, reviewable union; unrelated candidates must not be silently combined. Only a `Dataset`, never a `DatasetCandidate`, may receive a crawl plan.

The system turns a selection into a versioned `CrawlPlan`. A crawl plan is executable deterministic policy, not an AI instruction. It contains:

- Dataset identity and the discovery evidence it derives from.
- Allowed membership rules: origin/path patterns, structural relationships, pagination/continuation rules, canonicalization and deduplication rules, and explicit exclusions.
- Enumerated known members when available, bounded expansion rules when necessary, and a prohibition on unapproved scope expansion.
- Budgets, safety policy, renderer choice, ordering/priority, retry behavior, and partial-completion criteria.
- Expected page types and sampling strata for downstream schema/extraction evaluation.

If refresh discovers content outside the active plan but plausibly related to the dataset, it is recorded as proposed membership drift. It is not crawled into the published dataset or automatically served until review or an explicitly approved bounded policy resolves it.

## Snapshot collection specification

Each crawl-plan execution produces an immutable `SnapshotCollection`. It contains a collection manifest and a page-level outcome for every planned member encountered: captured snapshot, canonical/final URL, content metadata/fingerprint, capture time, membership reason, page-type hint, extraction eligibility, and failure/skip/duplicate disposition.

The manifest identifies the crawl-plan revision, source and dataset, run parameters, completion status, coverage statistics, and integrity summary. A partial collection can support diagnostics or preview when policy allows, but publication criteria must state whether full coverage is required. Snapshots are never overwritten; later runs create new collections.

## AI and deterministic responsibilities

AI has four bounded roles:

1. Analyze deterministic discovery evidence into `DatasetCandidate` classifications and estimates.
2. Infer schema and fields from representative, redacted snapshot samples.
3. Propose a declarative extraction plan for dataset page types and record/field rules.
4. Propose repair candidates when drift or validation failures occur.

Deterministic components are authoritative for scope enforcement, fetching, parsing, extraction-plan execution, normalization, validation, version creation, publication, and rollback. All AI output is structured, confidence-scored, attributable to a model/prompt version, supported by evidence references, and validated before it can affect a published API.

## Publication, monitoring, and repair

`PublishedAPI` exposes records from one dataset using an approved schema, extraction plan, and validated extraction version. It supports stable endpoint identity while binding each response to auditable lineage: source, discovery result, dataset candidate(s), discovery preview, user approval, dataset, crawl plan, snapshot collection, schema, plan, and output version.

Monitoring evaluates the dataset as a collection: crawl completion, membership conformance, page availability, content/template drift, extraction coverage, field/schema quality, duplicate behavior, record freshness, and endpoint SLOs. It distinguishes cosmetic changes from meaningful changes affecting data or extraction.

AI repair receives only necessary redacted evidence—diagnostics, old/new representative snapshots, plan context, and aggregate quality signals—and returns a candidate plan. The candidate is evaluated across historical and current snapshot collections, then follows the normal approval and rollout policy. Repair cannot select a new dataset, bypass deterministic validation, or broaden crawl scope without the applicable user-approved review path.

## Compatibility and evolution

The existing `Source`, `Connector`, `ConnectorRegistry`, snapshot, schema, extraction, cache, job, and versioning concepts remain useful. The evolution is to make their later-phase use dataset-scoped:

| Existing concept | Dataset-centric evolution after Phase 1 |
| --- | --- |
| Source | Registration and connector boundary; one source may yield many `DatasetCandidate`s and, after approval, datasets. |
| DiscoveryResult | Deterministic bounded exploration evidence consumed by AI classification. |
| DatasetCandidate | AI-proposed logical collection displayed for review; it becomes a dataset only after explicit approval. |
| DiscoveryPreview | User-facing candidate summary that supports informed selection without selecting on the user's behalf. |
| Snapshot | Immutable page/resource capture; grouped into a `SnapshotCollection`. |
| Schema | Proposed and evaluated from collection samples, then bound to a dataset. |
| Extraction definition/version | Becomes a dataset-scoped extraction plan/output evaluated across a collection. |
| Refresh | Repeats plan-aware discovery/crawling and produces a new collection, not a replacement single-page snapshot. |
| Endpoint | Publishes one selected dataset with stable identity and versioned lineage. |

This preserves the source-agnostic architecture. Website crawling is the initial implementation; other connectors supply an equivalent bounded discovery/enumeration mechanism while retaining the same dataset lifecycle.
