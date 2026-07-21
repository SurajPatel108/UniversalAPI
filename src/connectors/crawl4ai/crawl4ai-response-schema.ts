import { ApplicationError } from "../../core/errors.js";
import type { CapturedPageArtifacts } from "../../models/captured-page-artifacts.js";

/** Error categories for the private Crawl4AI HTTP adapter. */
export type Crawl4AiErrorCategory = "HTTP_ERROR" | "AUTH_FAILURE" | "NETWORK_ERROR" | "TIMEOUT" | "JSON_PARSE_ERROR" | "INVALID_RESPONSE" | "MISSING_RESULTS" | "RESULT_FAILURE" | "MISSING_HTML";

/**
 * A safe, deterministic adapter error. `diagnostic` is intentionally private
 * adapter context and must never be sent through application API responses.
 */
export class Crawl4AiAdapterError extends ApplicationError {
  constructor(readonly category: Crawl4AiErrorCategory, message: string, retryable = false, readonly diagnostic?: Record<string, unknown>) {
    super("acquisition_failed", message, retryable);
    this.name = "Crawl4AiAdapterError";
  }
}

type RecordValue = Record<string, unknown>;

/**
 * Validates the Crawl4AI v0.9.2 `/crawl` envelope before converting it to the
 * connector-neutral capture artifact. Crawl4AI field names remain private here.
 */
export function validateAndMapCrawl4AiResponse(payload: unknown, requestedUrl: string): CapturedPageArtifacts {
  const envelope = object(payload, "INVALID_RESPONSE", "Crawl4AI returned an invalid response envelope", { payloadType: typeOf(payload) });
  if (envelope.success !== true) throw invalid("INVALID_RESPONSE", "Crawl4AI response did not confirm success", envelope);
  if (!("results" in envelope)) throw invalid("MISSING_RESULTS", "Crawl4AI response did not include crawl results", envelope);
  if (!Array.isArray(envelope.results)) throw invalid("INVALID_RESPONSE", "Crawl4AI response contained invalid crawl results", envelope);
  if (envelope.results.length !== 1) throw invalid("INVALID_RESPONSE", "Crawl4AI returned an unexpected number of crawl results", envelope, { resultCount: envelope.results.length });

  const result = object(envelope.results[0], "INVALID_RESPONSE", "Crawl4AI returned an invalid crawl result", { envelopeKeys: Object.keys(envelope) });
  if (result.success !== true) {
    const serverMessage = safeText(result.error_message);
    throw invalid("RESULT_FAILURE", serverMessage ? `Crawl4AI crawl failed: ${serverMessage}` : "Crawl4AI crawl failed", result);
  }

  const rawHtml = typeof result.html === "string" ? result.html : undefined;
  if (!rawHtml || rawHtml.trim().length === 0) throw invalid("MISSING_HTML", "Crawl4AI response did not include non-empty HTML", result);

  const responseUrl = optionalUrl(result.url);
  const redirectedUrl = optionalUrl(result.redirected_url);
  if (!responseUrl && !redirectedUrl) throw invalid("INVALID_RESPONSE", "Crawl4AI response did not include a returned URL", result);
  if ((responseUrl && !sameCanonicalUrl(responseUrl, requestedUrl)) || (!responseUrl && redirectedUrl && !sameCanonicalUrl(redirectedUrl, requestedUrl))) {
    throw invalid("INVALID_RESPONSE", "Crawl4AI returned a URL that does not match the requested URL", result, { requestedUrlPresent: true, responseUrlPresent: Boolean(responseUrl), redirectedUrlPresent: Boolean(redirectedUrl) });
  }

  const markdown = markdownText(result.markdown) ?? optionalText(result.fit_markdown);
  return {
    rawHtml,
    ...(markdown ? { markdown } : {}),
    ...(optionalText(result.cleaned_html) ? { cleanedContent: optionalText(result.cleaned_html)! } : {}),
    metadata: recordOrUndefined(result.metadata) ?? {},
    ...(links(result.links).length > 0 ? { links: links(result.links) } : { links: [] }),
    finalUrl: redirectedUrl ?? responseUrl!,
    ...(validScreenshot(result.screenshot) ? { screenshot: result.screenshot } : {})
  };
}

function object(value: unknown, category: Crawl4AiErrorCategory, message: string, diagnostic: Record<string, unknown>): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Crawl4AiAdapterError(category, message, false, diagnostic);
  return value as RecordValue;
}

function invalid(category: Crawl4AiErrorCategory, message: string, value: RecordValue, additional: Record<string, unknown> = {}): Crawl4AiAdapterError {
  return new Crawl4AiAdapterError(category, message, false, { responseKeys: Object.keys(value), ...additional });
}

function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function safeText(value: unknown): string | undefined { return typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim().slice(0, 240) || undefined : undefined; }
function recordOrUndefined(value: unknown): RecordValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function optionalUrl(value: unknown): string | undefined { return typeof value === "string" && validUrl(value) ? value : undefined; }
function validUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }
function sameCanonicalUrl(left: string, right: string): boolean { try { const a = new URL(left); const b = new URL(right); a.hash = ""; b.hash = ""; return a.toString() === b.toString(); } catch { return false; } }
function markdownText(value: unknown): string | undefined { const markdown = recordOrUndefined(value); return optionalText(markdown?.raw_markdown) ?? optionalText(markdown?.fit_markdown); }
function links(value: unknown): string[] {
  const link = (item: unknown): string | undefined => typeof item === "string" ? item : optionalText(recordOrUndefined(item)?.href);
  if (Array.isArray(value)) return value.flatMap((item) => link(item) ? [link(item)!] : []);
  const groups = recordOrUndefined(value);
  return groups ? Object.values(groups).flatMap((items) => Array.isArray(items) ? items.flatMap((item) => link(item) ? [link(item)!] : []) : []) : [];
}
function validScreenshot(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const encoded = value.startsWith("data:image/") ? value.slice(value.indexOf(",") + 1) : value;
  return encoded.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded);
}
function typeOf(value: unknown): string { return Array.isArray(value) ? "array" : value === null ? "null" : typeof value; }
