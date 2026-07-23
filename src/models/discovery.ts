import type { AiProvenance } from "../ai/ai-types.js";

export interface DiscoveryLimits {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxBytesPerPage: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedOrigins: readonly string[];
}

export const defaultDiscoveryLimits: DiscoveryLimits = { maxPages: 100, maxDepth: 3, maxBytesPerPage: 1_000_000, timeoutMs: 10_000, maxRedirects: 5, allowedOrigins: [] };

export type DiscoveryDisposition = "captured" | "duplicate" | "out_of_scope" | "failed" | "limit_reached";

/**
 * Optional deterministic page signals retained by discovery for structural
 * classification. They are observations, not a user-selected dataset scope.
 */
export interface DiscoveredPageStructure {
  readonly mainRecordCandidates: number;
  readonly mainLinkCount: number;
  readonly mainUniqueLinkCount: number;
  readonly mainAttributeCount: number;
  readonly repeatedSiblingGroups: number;
  readonly navigationLinkCount: number;
  readonly paginationLinkCount: number;
  readonly mainHeading: string | null;
}

export interface DiscoveredPage {
  readonly url: string;
  readonly canonicalUrl: string;
  readonly depth: number;
  readonly parentUrl: string | null;
  readonly links: readonly string[];
  readonly title: string | null;
  readonly contentType: string | null;
  readonly disposition: DiscoveryDisposition;
  readonly structure?: DiscoveredPageStructure;
  readonly reason?: string;
}

export interface DiscoveryResult {
  readonly id: string;
  readonly sourceId: string;
  readonly seedUrl: string;
  readonly limits: DiscoveryLimits;
  readonly pages: readonly DiscoveredPage[];
  readonly completed: boolean;
  readonly createdAt: Date;
}

export interface DatasetCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly discoveryResultId: string;
  readonly name: string;
  readonly classification: "products" | "listings" | "documentation" | "articles" | "categories" | "collections" | "directories" | "unknown";
  readonly membershipUrls: readonly string[];
  readonly representativeUrls: readonly string[];
  readonly estimatedPageCount: number;
  readonly estimatedRecordCount: number | null;
  readonly estimatedCrawlSeconds: number;
  readonly confidence: number;
  readonly explanation: string;
  readonly knownRisks: readonly string[];
  readonly provenance: AiProvenance;
  readonly createdAt: Date;
}

export interface DiscoveryPreviewItem {
  readonly candidateId: string;
  readonly name: string;
  readonly classification: DatasetCandidate["classification"];
  readonly estimatedPageCount: number;
  readonly estimatedRecordCount: number | null;
  readonly estimatedCrawlSeconds: number;
  readonly confidence: number;
  readonly representativeUrls: readonly string[];
  readonly knownRisks: readonly string[];
}

export interface DiscoveryPreview {
  readonly discoveryResultId: string;
  readonly candidates: readonly DiscoveryPreviewItem[];
  readonly createdAt: Date;
}
