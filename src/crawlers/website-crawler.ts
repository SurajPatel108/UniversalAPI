import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { Source } from "../models/source.js";
import type { DiscoveryLimits, DiscoveryResult, DiscoveredPage } from "../models/discovery.js";
import type { SourceSnapshot } from "../models/snapshot.js";
import type { SnapshotCollection, SnapshotCollectionEntry } from "../models/snapshot-collection.js";
import type { CrawlPlan } from "../models/crawl.js";

export interface WebsiteResponse {
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: string;
}

export interface WebsiteHttpClient {
  get(url: string, options: { readonly timeoutMs: number; readonly maxBytes: number }): Promise<WebsiteResponse>;
}

export interface HostSafetyValidator { assertSafe(url: URL): Promise<void>; }

/** Rejects loopback, link-local, multicast, and private IPv4 targets before network I/O. Deployments should also enforce egress policy at the network boundary. */
export class DnsHostSafetyValidator implements HostSafetyValidator {
  async assertSafe(url: URL): Promise<void> {
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) throw new Error("loopback targets are not allowed");
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.some(({ address }) => this.isPrivate(address))) throw new Error("private or reserved network targets are not allowed");
  }
  private isPrivate(address: string): boolean {
    if (address.includes(":")) return address === "::1" || address.toLowerCase().startsWith("fe80:") || address.toLowerCase().startsWith("fc") || address.toLowerCase().startsWith("fd") || address.toLowerCase().startsWith("ff");
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
}

/** Uses native fetch with explicit redirect, DNS/IP, timeout, and body-size controls. */
export class FetchWebsiteHttpClient implements WebsiteHttpClient {
  constructor(private readonly hostSafety: HostSafetyValidator = new DnsHostSafetyValidator(), private readonly maxRedirects = 5) {}
  async get(url: string, options: { readonly timeoutMs: number; readonly maxBytes: number }): Promise<WebsiteResponse> {
    let current = new URL(url);
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      await this.hostSafety.assertSafe(current);
      const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs), headers: { accept: "text/html,application/xhtml+xml" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect response is missing a location header");
        if (redirects === this.maxRedirects) throw new Error("redirect limit exceeded");
        current = new URL(location, current);
        continue;
      }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (declaredSize > options.maxBytes) throw new Error("response exceeds configured content-size limit");
    const body = await response.text();
    if (Buffer.byteLength(body) > options.maxBytes) throw new Error("response exceeds configured content-size limit");
      return { finalUrl: response.url, contentType: response.headers.get("content-type"), body };
    }
    throw new Error("redirect limit exceeded");
  }
}

export const defaultDiscoveryLimits: DiscoveryLimits = {
  maxPages: 100,
  maxDepth: 3,
  maxBytesPerPage: 1_000_000,
  timeoutMs: 10_000,
  maxRedirects: 5,
  allowedOrigins: []
};

export class WebsiteCrawler {
  constructor(private readonly client: WebsiteHttpClient = new FetchWebsiteHttpClient(), private readonly now: () => Date = () => new Date()) {}

  async discover(source: Source, limits: DiscoveryLimits): Promise<DiscoveryResult> {
    const seed = this.canonicalize(source.url);
    const allowedOrigins = new Set((limits.allowedOrigins.length ? limits.allowedOrigins : [new URL(seed).origin]).map((origin) => new URL(origin).origin));
    const queue: Array<{ url: string; depth: number; parentUrl: string | null }> = [{ url: seed, depth: 0, parentUrl: null }];
    const seen = new Set<string>();
    const pages: DiscoveredPage[] = [];
    let completed = true;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const canonicalUrl = this.canonicalize(current.url);
      if (seen.has(canonicalUrl)) { pages.push({ url: current.url, canonicalUrl, depth: current.depth, parentUrl: current.parentUrl, links: [], title: null, contentType: null, disposition: "duplicate" }); continue; }
      if (!this.isAllowed(canonicalUrl, allowedOrigins)) { pages.push({ url: current.url, canonicalUrl, depth: current.depth, parentUrl: current.parentUrl, links: [], title: null, contentType: null, disposition: "out_of_scope", reason: "URL is outside allowed origins or uses an unsafe protocol" }); continue; }
      if (seen.size >= limits.maxPages) { completed = false; pages.push({ url: current.url, canonicalUrl, depth: current.depth, parentUrl: current.parentUrl, links: [], title: null, contentType: null, disposition: "limit_reached", reason: "maximum page budget reached" }); continue; }
      seen.add(canonicalUrl);
      try {
        const response = await this.client.get(canonicalUrl, { timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytesPerPage });
        const finalUrl = this.canonicalize(response.finalUrl);
        if (!this.isAllowed(finalUrl, allowedOrigins)) throw new Error("redirected outside allowed origins");
        const links = this.extractLinks(response.body, finalUrl).filter((link) => this.isAllowed(link, allowedOrigins));
        pages.push({ url: current.url, canonicalUrl: finalUrl, depth: current.depth, parentUrl: current.parentUrl, links, title: this.extractTitle(response.body), contentType: response.contentType, disposition: "captured" });
        if (current.depth < limits.maxDepth) links.forEach((link) => queue.push({ url: link, depth: current.depth + 1, parentUrl: finalUrl }));
      } catch (error) {
        pages.push({ url: current.url, canonicalUrl, depth: current.depth, parentUrl: current.parentUrl, links: [], title: null, contentType: null, disposition: "failed", reason: error instanceof Error ? error.message : "request failed" });
      }
    }
    return { id: randomUUID(), sourceId: source.id, seedUrl: seed, limits: { ...limits, allowedOrigins: [...allowedOrigins] }, pages, completed, createdAt: this.now() };
  }

  async capturePlan(source: Source, plan: CrawlPlan): Promise<SnapshotCollection> {
    const entries: SnapshotCollectionEntry[] = [];
    for (const url of plan.urls) {
      try {
        const response = await this.client.get(url, { timeoutMs: plan.limits.timeoutMs, maxBytes: plan.limits.maxBytesPerPage });
        entries.push({ url, outcome: "captured", content: response.body, snapshot: { id: randomUUID(), sourceId: source.id, contentType: response.contentType ?? "text/html", fingerprint: createHash("sha256").update(response.body).digest("hex"), capturedAt: this.now() } });
      } catch (error) {
        entries.push({ url, outcome: "failed", error: error instanceof Error ? error.message : "request failed" });
      }
    }
    return { id: randomUUID(), sourceId: source.id, datasetId: plan.datasetId, crawlPlanId: plan.id, entries, completed: entries.every((entry) => entry.outcome === "captured"), createdAt: this.now() };
  }

  private canonicalize(raw: string): string { const url = new URL(raw); url.hash = ""; return url.toString(); }
  private isAllowed(raw: string, origins: ReadonlySet<string>): boolean { try { const url = new URL(raw); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && origins.has(url.origin); } catch { return false; } }
  private extractTitle(html: string): string | null { return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].replace(/\s+/g, " ").trim() || null; }
  private extractLinks(html: string, base: string): string[] {
    const links: string[] = []; const pattern = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    for (let match = pattern.exec(html); match; match = pattern.exec(html)) { try { links.push(this.canonicalize(new URL(match[1]!, base).toString())); } catch { /* ignore malformed href */ } }
    return [...new Set(links)];
  }
}
