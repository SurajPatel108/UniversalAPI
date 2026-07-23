import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { ApplicationError } from "../core/errors.js";
import type { CrawlPlan } from "../models/crawl.js";
import type { DiscoveryLimits, DiscoveryResult, DiscoveredPage } from "../models/discovery.js";
import type { Source } from "../models/source.js";
import type { SnapshotCollection, SnapshotCollectionEntry } from "../models/snapshot-collection.js";
import type { CapturedSource, DatasetDiscoveryConnector } from "./connector.js";
import { Crawl4AiClient, FetchWebsiteAcquisitionEngine, type WebsiteAcquisitionEngine, UnavailableWebsiteAcquisitionEngine } from "./crawl4ai/crawl4ai-client.js";

export { type WebsiteAcquisitionEngine } from "./crawl4ai/crawl4ai-client.js";

/** Website connector owns deterministic scope enforcement and maps its internal acquisition engine to neutral artifacts. */
export class WebsiteConnector implements DatasetDiscoveryConnector {
  readonly sourceType = "website" as const;
  readonly capabilities = { supportsIncrementalSync: false, supportsStructuredMetadata: true, requiresCredentialReference: false, supportsBoundedDiscovery: true };
  constructor(private readonly engine: WebsiteAcquisitionEngine = new UnavailableWebsiteAcquisitionEngine(), private readonly now: () => Date = () => new Date()) {}
  async validate(source: Source): Promise<void> { if (source.sourceType !== "website") throw new ApplicationError("invalid_source", "WebsiteConnector only supports website sources"); const url = new URL(source.url); if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApplicationError("invalid_url", "Website sources must use HTTP or HTTPS"); }
  async discover(source: Source, limits: DiscoveryLimits): Promise<DiscoveryResult> {
    await this.validate(source);
    const seed = this.canonicalize(source.url); const origins = this.origins(seed, limits); const queue: Array<{ url: string; depth: number; parentUrl: string | null }> = [{ url: seed, depth: 0, parentUrl: null }]; const seen = new Set<string>(); const pages: DiscoveredPage[] = []; let completed = true;
    while (queue.length) {
      const current = queue.shift()!; const canonicalUrl = this.canonicalize(current.url);
      if (seen.has(canonicalUrl)) { pages.push(this.page(current, canonicalUrl, [], null, null, "duplicate")); continue; }
      if (!this.allowed(canonicalUrl, origins)) { pages.push(this.page(current, canonicalUrl, [], null, null, "out_of_scope", "URL is outside allowed origins or uses an unsafe protocol")); continue; }
      if (seen.size >= limits.maxPages) { completed = false; pages.push(this.page(current, canonicalUrl, [], null, null, "limit_reached", "maximum page budget reached")); continue; }
      seen.add(canonicalUrl);
      try {
        const artifacts = await this.engine.acquire(canonicalUrl, this.engineOptions(limits)); const finalUrl = this.canonicalize(artifacts.finalUrl);
        if (!this.allowed(finalUrl, origins)) throw new ApplicationError("acquisition_failed", "Crawl result redirected outside allowed origins");
        const links = artifacts.links.map((link) => this.resolve(link, finalUrl)).filter((link): link is string => Boolean(link) && this.allowed(link!, origins));
        pages.push(this.page(current, finalUrl, [...new Set(links)], this.title(artifacts.rawHtml), "text/html", "captured", undefined, this.structure(artifacts.rawHtml)));
        if (current.depth < limits.maxDepth) links.forEach((url) => queue.push({ url, depth: current.depth + 1, parentUrl: finalUrl }));
      } catch (error) { pages.push(this.page(current, canonicalUrl, [], null, null, "failed", error instanceof Error ? error.message : "acquisition failed")); }
    }
    return { id: randomUUID(), sourceId: source.id, seedUrl: seed, limits: { ...limits, allowedOrigins: [...origins] }, pages, completed, createdAt: this.now() };
  }
  async capturePlan(source: Source, plan: CrawlPlan): Promise<SnapshotCollection> {
    await this.validate(source); const origins = this.origins(source.url, plan.limits); const entries: SnapshotCollectionEntry[] = [];
    for (const url of plan.urls) {
      if (!this.allowed(url, origins)) { entries.push({ url, outcome: "out_of_scope", error: "URL is outside allowed origins" }); continue; }
      try { const artifacts = await this.engine.acquire(url, this.engineOptions(plan.limits)); const content = artifacts.rawHtml; entries.push({ url, outcome: "captured", content, artifacts, snapshot: { id: randomUUID(), sourceId: source.id, contentType: "text/html", fingerprint: createHash("sha256").update(content).digest("hex"), capturedAt: this.now() } }); }
      catch (error) { entries.push({ url, outcome: "failed", error: error instanceof Error ? error.message : "acquisition failed" }); }
    }
    return { id: randomUUID(), sourceId: source.id, datasetId: plan.datasetId, crawlPlanId: plan.id, entries, completed: entries.every((entry) => entry.outcome === "captured"), createdAt: this.now() };
  }
  async capture(source: Source): Promise<CapturedSource> {
    await this.validate(source); const artifacts = await this.engine.acquire(this.canonicalize(source.url), { maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 5 }); const content = artifacts.rawHtml;
    return { snapshot: { id: randomUUID(), sourceId: source.id, contentType: "text/html", fingerprint: createHash("sha256").update(content).digest("hex"), capturedAt: this.now() }, content, artifacts };
  }
  private origins(seed: string, limits: DiscoveryLimits): Set<string> { return new Set((limits.allowedOrigins.length ? limits.allowedOrigins : [new URL(seed).origin]).map((origin) => new URL(origin).origin)); }
  private allowed(raw: string, origins: ReadonlySet<string>): boolean { try { const url = new URL(raw); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && origins.has(url.origin); } catch { return false; } }
  private resolve(raw: string, base: string): string | null { try { return this.canonicalize(new URL(raw, base).toString()); } catch { return null; } }
  private canonicalize(raw: string): string { const url = new URL(raw); url.hash = ""; return url.toString(); }
  private title(html: string): string | null { return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].replace(/\s+/g, " ").trim() || null; }
  /** Compact, deterministic DOM observations for ranking. Raw content remains in snapshots. */
  private structure(html: string): DiscoveredPage["structure"] {
    const $ = cheerio.load(html);
    const root = $("main").first().length > 0 ? $("main").first() : $("body").first();
    const primary = root.find("*").filter((_index, element) => !this.isChrome($, element));
    const mainLinks = primary.filter("a[href]");
    const mainRecordCandidates = primary.filter("article, [itemtype], [class*=product], [class*=listing], [class*=record]").length;
    const mainUniqueLinkCount = new Set(mainLinks.toArray().map((element) => $(element).attr("href")).filter((href): href is string => Boolean(href))).size;
    const mainAttributeCount = primary.toArray().reduce((count, element) => count + Object.keys(element.attribs ?? {}).filter((name) => ["href", "src", "title", "alt", "datetime", "content", "itemprop", "data-id"].includes(name)).length, 0);
    const repeatedSiblingGroups = primary.toArray().filter((element) => {
      const children = $(element).children().toArray().filter((child) => !this.isChrome($, child));
      if (children.length < 3) return false;
      const identities = children.map((child) => `${(child as { tagName?: string }).tagName ?? "node"}.${($(child).attr("class") ?? "").split(/\s+/).filter(Boolean).sort().join(".")}`);
      return new Set(identities).size < children.length;
    }).length;
    const navigationLinkCount = $("body").find("a[href]").toArray().filter((element) => this.isChrome($, element)).length;
    const paginationLinkCount = mainLinks.toArray().filter((element) => /(?:[?&](?:page|p)=\d+|\bpage[-_/]?\d+\b)/i.test($(element).attr("href") ?? "")).length;
    const mainHeading = primary.filter("h1, h2").first().text().replace(/\s+/g, " ").trim() || null;
    return { mainRecordCandidates, mainLinkCount: mainLinks.length, mainUniqueLinkCount, mainAttributeCount, repeatedSiblingGroups, navigationLinkCount, paginationLinkCount, mainHeading };
  }
  private isChrome($: cheerio.CheerioAPI, element: unknown): boolean {
    return $(element as never).parents().addBack().toArray().some((ancestor) => {
      const tag = (ancestor as { tagName?: string }).tagName?.toLowerCase();
      if (tag === "nav" || tag === "aside" || tag === "header" || tag === "footer") return true;
      const node = $(ancestor);
      const role = node.attr("role");
      if (role === "navigation" || role === "banner" || role === "contentinfo") return true;
      return /(?:nav|menu|sidebar|side_categories|breadcrumb|header|footer)/i.test(`${node.attr("class") ?? ""} ${node.attr("id") ?? ""}`);
    });
  }
  private engineOptions(limits: DiscoveryLimits) { return { maxBytes: limits.maxBytesPerPage, timeoutMs: limits.timeoutMs, maxRedirects: limits.maxRedirects }; }
  private page(current: { url: string; depth: number; parentUrl: string | null }, canonicalUrl: string, links: readonly string[], title: string | null, contentType: string | null, disposition: DiscoveredPage["disposition"], reason?: string, structure?: DiscoveredPage["structure"]): DiscoveredPage { return { url: current.url, canonicalUrl, depth: current.depth, parentUrl: current.parentUrl, links, title, contentType, disposition, ...(reason ? { reason } : {}), ...(structure ? { structure } : {}) }; }
}

export function createWebsiteConnector(baseUrl?: string, token?: string): WebsiteConnector {
  if (baseUrl) return new WebsiteConnector(new Crawl4AiClient(baseUrl, token));
  return new WebsiteConnector(new FetchWebsiteAcquisitionEngine());
}
