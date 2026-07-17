import { randomUUID } from "node:crypto";
import type { DatasetCandidate, DiscoveryResult } from "../models/discovery.js";
import type { DatasetClassificationService } from "./dataset-classification-service.js";

/** Safe local fallback for deployments without a configured model. A provider-backed classifier can replace it through buildApp options. */
export class StructuralDatasetClassificationService implements DatasetClassificationService {
  async classify(result: DiscoveryResult): Promise<readonly DatasetCandidate[]> {
    const pages = result.pages.filter((page) => page.disposition === "captured");
    if (pages.length === 0) return [];
    const seed = new URL(result.seedUrl);
    const name = pages[0]?.title || seed.hostname;
    return [{ id: randomUUID(), sourceId: result.sourceId, discoveryResultId: result.id, name, classification: "unknown", membershipUrls: pages.map((page) => page.canonicalUrl), representativeUrls: pages.slice(0, 3).map((page) => page.canonicalUrl), estimatedPageCount: pages.length, estimatedRecordCount: null, estimatedCrawlSeconds: pages.length, confidence: 0.2, explanation: "Fallback structural grouping; configure an AI classifier for semantic dataset classification.", knownRisks: result.completed ? ["AI classifier is not configured"] : ["Discovery reached a configured limit", "AI classifier is not configured"], provenance: { model: "structural-fallback", promptVersion: "none", confidence: 0.2 }, createdAt: new Date() }];
  }
}
