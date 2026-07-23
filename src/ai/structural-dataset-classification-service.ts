import { randomUUID } from "node:crypto";
import type { DatasetCandidate, DiscoveredPage, DiscoveryResult } from "../models/discovery.js";
import type { DatasetClassificationService } from "./dataset-classification-service.js";

interface PageSignals {
  readonly page: DiscoveredPage;
  readonly uniqueRecordTargets: number;
  readonly navigationTargets: number;
  readonly recordDensity: number;
  readonly fieldRichness: number;
  readonly repeatedStructure: number;
  readonly paginationSignals: number;
  readonly score: number;
}

/**
 * Safe local fallback for deployments without a configured model. It ranks
 * deterministic discovery evidence and never selects a dataset for the user.
 */
export class StructuralDatasetClassificationService implements DatasetClassificationService {
  async classify(result: DiscoveryResult): Promise<readonly DatasetCandidate[]> {
    const captured = result.pages.filter((page) => page.disposition === "captured");
    if (captured.length === 0) return [];

    const references = this.referenceCounts(captured);
    const signals = captured
      .map((page) => this.signals(page, references))
      .sort((left, right) => right.score - left.score || left.page.canonicalUrl.localeCompare(right.page.canonicalUrl));
    const collectionPages = signals.filter((signal) => signal.uniqueRecordTargets >= 2 && signal.recordDensity >= 0.2);
    const candidates: DatasetCandidate[] = [];

    if (collectionPages.length > 0) candidates.push(this.collectionCandidate(result, collectionPages));

    const navigationPages = captured
      .filter((page) => (references.get(page.canonicalUrl) ?? 0) >= 2 || (page.structure?.navigationLinkCount ?? 0) > (page.structure?.mainRecordCandidates ?? 0))
      .sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
    if (navigationPages.length > 0) candidates.push(this.navigationCandidate(result, navigationPages, references));

    if (candidates.length === 0) candidates.push(this.fallbackCandidate(result, signals));
    return candidates;
  }

  private referenceCounts(pages: readonly DiscoveredPage[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const page of pages) for (const target of new Set(page.links)) counts.set(target, (counts.get(target) ?? 0) + 1);
    return counts;
  }

  private signals(page: DiscoveredPage, references: ReadonlyMap<string, number>): PageSignals {
    const links = [...new Set(page.links)];
    const inferredUniqueTargets = links.filter((target) => (references.get(target) ?? 0) <= 1).length;
    const uniqueRecordTargets = page.structure?.mainRecordCandidates ?? inferredUniqueTargets;
    const navigationTargets = page.structure?.navigationLinkCount ?? links.filter((target) => (references.get(target) ?? 0) >= 2).length;
    const denominator = page.structure?.mainUniqueLinkCount || page.structure?.mainLinkCount || links.length;
    const recordDensity = denominator === 0 ? 0 : uniqueRecordTargets / denominator;
    const fieldRichness = page.structure?.mainAttributeCount ?? 0;
    const repeatedStructure = page.structure?.repeatedSiblingGroups ?? 0;
    const paginationSignals = page.structure?.paginationLinkCount ?? links.filter((target) => /(?:[?&](?:page|p)=\d+|\bpage[-_/]?\d+\b)/i.test(target)).length;
    const score = uniqueRecordTargets * 5 + recordDensity * 20 + fieldRichness * 0.25 + repeatedStructure * 4 + paginationSignals * 4 - navigationTargets * 3;
    return { page, uniqueRecordTargets, navigationTargets, recordDensity, fieldRichness, repeatedStructure, paginationSignals, score };
  }

  private collectionCandidate(result: DiscoveryResult, pages: readonly PageSignals[]): DatasetCandidate {
    const membershipUrls = pages.map((signal) => signal.page.canonicalUrl).sort((left, right) => left.localeCompare(right));
    const records = pages.reduce((total, signal) => total + signal.uniqueRecordTargets, 0);
    const pagination = pages.reduce((total, signal) => total + signal.paginationSignals, 0);
    const density = pages.reduce((total, signal) => total + signal.recordDensity, 0) / pages.length;
    const confidence = this.confidence(pages[0]!.score, density, pagination);
    return {
      id: randomUUID(), sourceId: result.sourceId, discoveryResultId: result.id,
      name: pages[0]!.page.structure?.mainHeading?.trim() || pages[0]!.page.title?.trim() || "Structured collection",
      classification: "listings", membershipUrls, representativeUrls: membershipUrls.slice(0, 3),
      estimatedPageCount: membershipUrls.length, estimatedRecordCount: records || null, estimatedCrawlSeconds: membershipUrls.length,
      confidence,
      explanation: `Ranked as the primary structured collection: ${records} record signals, ${(density * 100).toFixed(0)}% record density, ${pages.reduce((total, page) => total + page.fieldRichness, 0)} stable attribute signals, and ${pagination} pagination signal(s).`,
      knownRisks: result.completed ? [] : ["Discovery reached a configured limit"],
      provenance: { model: "structural-fallback", promptVersion: "structural-ranking-v2", confidence }, createdAt: new Date()
    };
  }

  private navigationCandidate(result: DiscoveryResult, pages: readonly DiscoveredPage[], references: ReadonlyMap<string, number>): DatasetCandidate {
    const membershipUrls = pages.map((page) => page.canonicalUrl);
    const averageReferences = pages.reduce((total, page) => total + (references.get(page.canonicalUrl) ?? 0), 0) / pages.length;
    const confidence = Number(Math.max(0.05, Math.min(0.45, 0.1 + averageReferences / 20)).toFixed(3));
    return {
      id: randomUUID(), sourceId: result.sourceId, discoveryResultId: result.id, name: "Repeated navigation directory", classification: "categories",
      membershipUrls, representativeUrls: membershipUrls.slice(0, 3), estimatedPageCount: membershipUrls.length,
      estimatedRecordCount: membershipUrls.length, estimatedCrawlSeconds: membershipUrls.length, confidence,
      explanation: "Lower-ranked because repeated links and structural signals indicate navigation rather than unique records.",
      knownRisks: ["High navigation-likelihood; review before selecting"],
      provenance: { model: "structural-fallback", promptVersion: "structural-ranking-v2", confidence }, createdAt: new Date()
    };
  }

  private fallbackCandidate(result: DiscoveryResult, signals: readonly PageSignals[]): DatasetCandidate {
    const membershipUrls = signals.map((signal) => signal.page.canonicalUrl);
    const confidence = 0.2;
    return {
      id: randomUUID(), sourceId: result.sourceId, discoveryResultId: result.id,
      name: signals[0]?.page.title?.trim() || new URL(result.seedUrl).hostname, classification: "unknown",
      membershipUrls, representativeUrls: membershipUrls.slice(0, 3), estimatedPageCount: membershipUrls.length,
      estimatedRecordCount: null, estimatedCrawlSeconds: membershipUrls.length, confidence,
      explanation: "No sufficiently dense structured collection was observed.",
      knownRisks: result.completed ? ["No strong collection structure observed"] : ["Discovery reached a configured limit", "No strong collection structure observed"],
      provenance: { model: "structural-fallback", promptVersion: "structural-ranking-v2", confidence }, createdAt: new Date()
    };
  }

  private confidence(score: number, density: number, pagination: number): number {
    return Number(Math.max(0.3, Math.min(0.95, 0.35 + score / 150 + density / 3 + Math.min(pagination, 5) / 50)).toFixed(3));
  }
}
