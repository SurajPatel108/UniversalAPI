/*
Purpose: declare the website-specific acquisition adapter used by the generic website Connector.
Responsibilities: safely fetch a URL and produce a SourceSnapshot plus HTML for the connector to return.
Connections: a WebsiteConnector wraps this port; RefreshSourceWorker otherwise depends only on Connector.
Future: robots policy, SSRF defenses, browser rendering, retries, and request budgets.
Best practice: enforce network allow/deny rules, timeouts, redirect limits, and size caps before parsing.
*/

import type { Source } from "../models/source.js";
import type { SourceSnapshot } from "../models/snapshot.js";
export interface CrawledWebsite { snapshot: SourceSnapshot; html: string; finalUrl: string; }
export interface WebsiteCrawler { crawl(source: Source): Promise<CrawledWebsite>; }
