import type { DatasetClassificationService } from "../ai/dataset-classification-service.js";
import type { WebsiteCrawler } from "../crawlers/website-crawler.js";
import { ApplicationError } from "../core/errors.js";
import { generateUuid } from "../core/uuid.js";
import type { DiscoveryRepository } from "../database/discovery-repository.js";
import type { SourceRepository } from "../database/source-repository.js";
import type { CrawlPlan } from "../models/crawl.js";
import type { Dataset } from "../models/dataset.js";
import type { DiscoveryLimits, DiscoveryPreview, DiscoveryResult } from "../models/discovery.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";

export class DiscoveryService {
  constructor(private readonly sources: SourceRepository, private readonly repository: DiscoveryRepository, private readonly crawler: WebsiteCrawler, private readonly classifier: DatasetClassificationService) {}

  async discover(sourceId: string, limits: DiscoveryLimits): Promise<DiscoveryPreview> {
    const source = await this.requireWebsite(sourceId);
    const result = await this.crawler.discover(source, limits);
    await this.repository.saveResult(result);
    const candidates = await this.classifier.classify(result);
    if (candidates.some((candidate) => candidate.sourceId !== sourceId || candidate.discoveryResultId !== result.id)) throw new ApplicationError("invalid_candidate", "Classifier returned candidates for another source or discovery result");
    await this.repository.saveCandidates(candidates);
    return this.buildPreview(result, candidates);
  }

  async preview(discoveryResultId: string): Promise<DiscoveryPreview> {
    const result = await this.requireResult(discoveryResultId);
    return this.buildPreview(result, await this.repository.findCandidates(discoveryResultId));
  }

  async approveAndCapture(input: { readonly candidateIds: readonly string[]; readonly approvedBy: string; readonly scope?: readonly string[]; readonly crawlBudget?: Partial<Pick<DiscoveryLimits, "maxPages" | "maxDepth" | "maxBytesPerPage" | "timeoutMs" | "maxRedirects">> }): Promise<{ readonly dataset: Dataset; readonly crawlPlan: CrawlPlan; readonly snapshots: SnapshotCollection }> {
    if (input.candidateIds.length === 0) throw new ApplicationError("invalid_request", "At least one dataset candidate must be selected");
    const candidates = await Promise.all(input.candidateIds.map((id) => this.repository.findCandidate(id)));
    if (candidates.some((candidate) => !candidate)) throw new ApplicationError("not_found", "Dataset candidate not found");
    const selected = candidates as NonNullable<(typeof candidates)[number]>[];
    const resultId = selected[0]!.discoveryResultId;
    if (selected.some((candidate) => candidate.discoveryResultId !== resultId)) throw new ApplicationError("invalid_request", "Selected candidates must belong to one discovery result");
    const result = await this.requireResult(resultId);
    const source = await this.requireWebsite(result.sourceId);
    const allowed = new Set(selected.flatMap((candidate) => candidate.membershipUrls));
    const scope = input.scope?.length ? input.scope : [...allowed];
    if (scope.some((url) => !allowed.has(url))) throw new ApplicationError("invalid_request", "Selected scope includes URLs outside approved candidate membership");
    const limits = { ...result.limits, ...input.crawlBudget };
    if (limits.maxPages < scope.length) throw new ApplicationError("invalid_request", "Crawl page budget must cover every selected URL");
    if (limits.maxPages > result.limits.maxPages || limits.maxDepth > result.limits.maxDepth || limits.maxBytesPerPage > result.limits.maxBytesPerPage || limits.timeoutMs > result.limits.timeoutMs || limits.maxRedirects > result.limits.maxRedirects) throw new ApplicationError("invalid_request", "Crawl-budget overrides may only reduce approved discovery limits");
    const now = new Date();
    const dataset: Dataset = { id: generateUuid(), sourceId: source.id, discoveryResultId: result.id, candidateIds: selected.map((candidate) => candidate.id), name: selected.map((candidate) => candidate.name).join(" + "), selectedScope: scope, approvedBy: input.approvedBy, approvedAt: now, createdAt: now };
    const plan: CrawlPlan = { id: generateUuid(), datasetId: dataset.id, revision: 1, urls: scope, limits, createdAt: now };
    await this.repository.saveDataset(dataset);
    await this.repository.saveCrawlPlan(plan);
    const snapshots = await this.crawler.capturePlan(source, plan);
    await this.repository.saveSnapshotCollection(snapshots);
    return { dataset, crawlPlan: plan, snapshots };
  }

  private async requireWebsite(sourceId: string) { const source = await this.sources.findById(sourceId); if (!source) throw new ApplicationError("not_found", "Source not found"); if (source.sourceType !== "website") throw new ApplicationError("unsupported_source", "Phase 2 discovery supports website sources only"); return source; }
  private async requireResult(id: string): Promise<DiscoveryResult> { const result = await this.repository.findResult(id); if (!result) throw new ApplicationError("not_found", "Discovery result not found"); return result; }
  private buildPreview(result: DiscoveryResult, candidates: readonly import("../models/discovery.js").DatasetCandidate[]): DiscoveryPreview { return { discoveryResultId: result.id, candidates: candidates.map(({ id, name, classification, estimatedPageCount, estimatedRecordCount, estimatedCrawlSeconds, confidence, representativeUrls, knownRisks }) => ({ candidateId: id, name, classification, estimatedPageCount, estimatedRecordCount, estimatedCrawlSeconds, confidence, representativeUrls, knownRisks })), createdAt: new Date() }; }
}
