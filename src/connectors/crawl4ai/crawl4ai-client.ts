import { ApplicationError } from "../../core/errors.js";
import type { CapturedPageArtifacts } from "../../models/captured-page-artifacts.js";
import { Crawl4AiAdapterError, validateAndMapCrawl4AiResponse } from "./crawl4ai-response-schema.js";

export interface WebsiteAcquisitionEngine {
  acquire(
    url: string,
    options: {
      readonly timeoutMs: number;
      readonly maxBytes: number;
      readonly maxRedirects: number;
    }
  ): Promise<CapturedPageArtifacts>;
}

export interface Crawl4AiTransport {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

/** Private Crawl4AI REST adapter. Its wire contract and names do not escape this directory. */
export class Crawl4AiClient implements WebsiteAcquisitionEngine {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly transport: Crawl4AiTransport = { fetch }
  ) {}

  async acquire(
    url: string,
    options: {
      readonly timeoutMs: number;
      readonly maxBytes: number;
      readonly maxRedirects: number;
    }
  ): Promise<CapturedPageArtifacts> {
    let response: Response;

    const requestUrl = new URL("/crawl", this.baseUrl).toString();

    const headers = {
      "content-type": "application/json",
      ...(this.token
        ? { authorization: `Bearer ${this.token}` }
        : {})
    };

    const requestBody = {
      urls: [url],
      browser_config: {},
      crawler_config: {
        word_count_threshold: 1,
        page_timeout: options.timeoutMs,
        screenshot: true,
        cache_mode: "bypass"
      }
    };

    try {
      response = await this.transport.fetch(requestUrl, {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers,
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      throw this.transportError(error);
    }

    if (!response.ok) throw await this.httpError(response);

    const payload = await this.json(response);

    let artifacts: CapturedPageArtifacts;

    try {
      artifacts = validateAndMapCrawl4AiResponse(payload, url);
    } catch (error) {
      if (error instanceof Crawl4AiAdapterError) this.debug(error);
      throw error;
    }

    if (Buffer.byteLength(artifacts.rawHtml) > options.maxBytes) {
      throw new Crawl4AiAdapterError(
        "MISSING_HTML",
        "Crawl4AI response exceeds configured content-size limit",
        false,
        {
          htmlBytes: Buffer.byteLength(artifacts.rawHtml),
          maxBytes: options.maxBytes
        }
      );
    }

    return artifacts;
  }

  private async json(response: Response): Promise<unknown> {
    const body = await response.text();

    try {
      return JSON.parse(body);
    } catch {
      throw new Crawl4AiAdapterError(
        "JSON_PARSE_ERROR",
        "Crawl4AI returned invalid JSON",
        false,
        {
          status: response.status,
          bodyLength: body.length
        }
      );
    }
  }

  private async httpError(response: Response): Promise<Crawl4AiAdapterError> {
    const text = await response.text();
    const details = safeServerDetails(text);

    const category =
      response.status === 401 || response.status === 403
        ? "AUTH_FAILURE"
        : "HTTP_ERROR";

    const suffix = details.detail
      ? `: ${details.detail}`
      : details.correlationId
        ? ` (correlation ID: ${details.correlationId})`
        : "";

    return new Crawl4AiAdapterError(
      category,
      `Crawl4AI request failed with HTTP ${response.status}${suffix}`,
      response.status >= 500,
      {
        status: response.status,
        ...details
      }
    );
  }

  private transportError(error: unknown): Crawl4AiAdapterError {
    const name = error instanceof Error ? error.name : "";

    if (name === "AbortError" || name === "TimeoutError") {
      return new Crawl4AiAdapterError(
        "TIMEOUT",
        "Crawl4AI request timed out",
        true,
        {
          errorName: name
        }
      );
    }

    return new Crawl4AiAdapterError(
      "NETWORK_ERROR",
      "Crawl4AI network request failed",
      true,
      {
        errorName: name || typeof error
      }
    );
  }

  private debug(error: Crawl4AiAdapterError): void {
    console.debug("Crawl4AI response validation failed", {
      category: error.category,
      ...error.diagnostic
    });
  }
}

function safeServerDetails(
  body: string
): { detail?: string; correlationId?: string } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;

    const safe = (value: unknown): string | undefined =>
      typeof value === "string"
        ? value.replace(/[\r\n\t]/g, " ").trim().slice(0, 240) || undefined
        : undefined;

    return {
      detail: safe(parsed.detail),
      correlationId: safe(parsed.correlation_id)
    };
  } catch {
    return {};
  }
}

export class FetchWebsiteAcquisitionEngine
  implements WebsiteAcquisitionEngine
{
  constructor(
    private readonly transport: Crawl4AiTransport = { fetch }
  ) {}

  async acquire(
    url: string,
    options: {
      readonly timeoutMs: number;
      readonly maxBytes: number;
      readonly maxRedirects: number;
    }
  ): Promise<CapturedPageArtifacts> {
    const response = await this.transport.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs)
    });

    if (!response.ok) {
      throw new ApplicationError(
        "acquisition_failed",
        `Direct fetch failed with HTTP ${response.status}`,
        response.status >= 500
      );
    }

    const rawHtml = await response.text();

    if (!rawHtml) {
      throw new ApplicationError(
        "acquisition_failed",
        "Direct fetch returned empty HTML"
      );
    }

    if (Buffer.byteLength(rawHtml) > options.maxBytes) {
      throw new ApplicationError(
        "acquisition_failed",
        "Direct fetch response exceeds configured content-size limit"
      );
    }

    const links = this.extractLinks(rawHtml, url);

    return {
      rawHtml,
      markdown: rawHtml,
      cleanedContent: rawHtml,
      metadata: {
        title: this.extractTitle(rawHtml)
      },
      links,
      finalUrl: response.url || url,
      screenshot: undefined
    };
  }

  private extractTitle(html: string): string | null {
    return (
      /<title[^>]*>([\s\S]*?)<\/title>/i
        .exec(html)?.[1]
        .replace(/\s+/g, " ")
        .trim() || null
    );
  }

  private extractLinks(html: string, baseUrl: string): string[] {
    return Array.from(
      html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)
    )
      .map((match) => this.resolve(match[1], baseUrl))
      .filter((href): href is string => Boolean(href));
  }

  private resolve(raw: string, baseUrl: string): string | null {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return null;
    }
  }
}

export class UnavailableWebsiteAcquisitionEngine
  implements WebsiteAcquisitionEngine
{
  async acquire(): Promise<CapturedPageArtifacts> {
    throw new ApplicationError(
      "acquisition_unavailable",
      "Crawl4AI is not configured; set CRAWL4AI_BASE_URL to enable website acquisition"
    );
  }
}
