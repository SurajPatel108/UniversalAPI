import type { CrawlPlan } from "../models/crawl.js";
import type { Dataset } from "../models/dataset.js";
import type { DatasetCandidate, DiscoveryResult } from "../models/discovery.js";
import type { SnapshotCollection } from "../models/snapshot-collection.js";

export interface DiscoveryRepository {
  saveResult(result: DiscoveryResult): Promise<void>;
  findResult(id: string): Promise<DiscoveryResult | null>;
  saveCandidates(candidates: readonly DatasetCandidate[]): Promise<void>;
  findCandidates(discoveryResultId: string): Promise<readonly DatasetCandidate[]>;
  findCandidate(id: string): Promise<DatasetCandidate | null>;
  saveDataset(dataset: Dataset): Promise<void>;
  findDataset(id: string): Promise<Dataset | null>;
  saveCrawlPlan(plan: CrawlPlan): Promise<void>;
  saveSnapshotCollection(collection: SnapshotCollection): Promise<void>;
  findSnapshotCollection(id: string): Promise<SnapshotCollection | null>;
}

export class InMemoryDiscoveryRepository implements DiscoveryRepository {
  private readonly results = new Map<string, DiscoveryResult>();
  private readonly candidates = new Map<string, DatasetCandidate>();
  private readonly datasets = new Map<string, Dataset>();
  private readonly plans = new Map<string, CrawlPlan>();
  private readonly collections = new Map<string, SnapshotCollection>();

  async saveResult(result: DiscoveryResult): Promise<void> { this.results.set(result.id, result); }
  async findResult(id: string): Promise<DiscoveryResult | null> { return this.results.get(id) ?? null; }
  async saveCandidates(candidates: readonly DatasetCandidate[]): Promise<void> { candidates.forEach((candidate) => this.candidates.set(candidate.id, candidate)); }
  async findCandidates(discoveryResultId: string): Promise<readonly DatasetCandidate[]> { return [...this.candidates.values()].filter((candidate) => candidate.discoveryResultId === discoveryResultId); }
  async findCandidate(id: string): Promise<DatasetCandidate | null> { return this.candidates.get(id) ?? null; }
  async saveDataset(dataset: Dataset): Promise<void> { this.datasets.set(dataset.id, dataset); }
  async findDataset(id: string): Promise<Dataset | null> { return this.datasets.get(id) ?? null; }
  async saveCrawlPlan(plan: CrawlPlan): Promise<void> { this.plans.set(plan.id, plan); }
  async saveSnapshotCollection(collection: SnapshotCollection): Promise<void> { this.collections.set(collection.id, collection); }
  async findSnapshotCollection(id: string): Promise<SnapshotCollection | null> { return this.collections.get(id) ?? null; }
}
