import { describe, expect, it } from "vitest";
import { Crawl4AiClient, FetchWebsiteAcquisitionEngine, type Crawl4AiTransport } from "../../src/connectors/crawl4ai/crawl4ai-client.js";
import { Crawl4AiAdapterError } from "../../src/connectors/crawl4ai/crawl4ai-response-schema.js";

const options = { timeoutMs: 1_000, maxBytes: 10_000, maxRedirects: 3 };
const requestedUrl = "https://example.test/one";
const success = (result: Record<string, unknown> = {}) => ({ success: true, results: [{ success: true, html: "<h1>One</h1>", url: requestedUrl, ...result }] });
const transport = (response: Response): Crawl4AiTransport => ({ fetch: async () => response });

async function category(promise: Promise<unknown>): Promise<string> {
  try { await promise; throw new Error("Expected an adapter failure"); }
  catch (error) { expect(error).toBeInstanceOf(Crawl4AiAdapterError); return (error as Crawl4AiAdapterError).category; }
}

describe("Crawl4AiClient", () => {
  it("uses the v0.9.2 /crawl envelope and maps a validated result to neutral artifacts", async () => {
    let input = "";
    let init: RequestInit | undefined;
    const client = new Crawl4AiClient("http://crawl4ai.internal/base", "token", {
      fetch: async (requestUrl, request) => {
        input = requestUrl;
        init = request;
        return new Response(JSON.stringify(success({ markdown: { raw_markdown: "# One", fit_markdown: "fit" }, cleaned_html: "One", metadata: { title: "One" }, links: { internal: [{ href: "/two" }] }, screenshot: "aGVsbG8=", redirected_url: "https://example.test/two" })), { status: 200 });
      }
    });

    const result = await client.acquire(requestedUrl, options);
    expect(input).toBe("http://crawl4ai.internal/crawl");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer token", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ urls: [requestedUrl], browser_config: {}, crawler_config: { word_count_threshold: 1, page_timeout: 1_000, screenshot: true, cache_mode: "bypass" } });
    expect(JSON.parse(String(init?.body)).crawler_config).not.toHaveProperty("max_redirects");
    expect(result).toEqual({ rawHtml: "<h1>One</h1>", markdown: "# One", cleanedContent: "One", metadata: { title: "One" }, links: ["/two"], finalUrl: "https://example.test/two", screenshot: "aGVsbG8=" });
  });

  it("uses fit markdown and tolerates missing optional capture artifacts", async () => {
    const response = new Response(JSON.stringify(success({ markdown: { fit_markdown: "fit" } })), { status: 200 });
    const result = await new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(response)).acquire(requestedUrl, options);
    expect(result).toMatchObject({ rawHtml: "<h1>One</h1>", markdown: "fit", links: [], finalUrl: requestedUrl });
    expect(result).not.toHaveProperty("cleanedContent");
    expect(result.metadata).toEqual({});
    expect(result).not.toHaveProperty("screenshot");
  });

  it("ignores a malformed optional screenshot", async () => {
    const result = await new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(new Response(JSON.stringify(success({ screenshot: { invalid: true } })), { status: 200 }))).acquire(requestedUrl, options);
    expect(result.screenshot).toBeUndefined();
  });

  it.each([[401, "AUTH_FAILURE"], [403, "AUTH_FAILURE"], [500, "HTTP_ERROR"]] as const)("classifies HTTP %i safely", async (status, expected) => {
    const result = category(new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(new Response(JSON.stringify({ detail: "safe failure", correlation_id: "req-1" }), { status }))).acquire(requestedUrl, options));
    await expect(result).resolves.toBe(expected);
  });

  it("includes only safe HTTP failure detail in the persisted reason", async () => {
    await expect(new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(new Response(JSON.stringify({ detail: "request rejected", correlation_id: "req-1", token: "never expose" }), { status: 500 }))).acquire(requestedUrl, options)).rejects.toThrow("HTTP 500: request rejected");
  });

  it("classifies network and timeout failures", async () => {
    await expect(category(new Crawl4AiClient("http://crawl4ai.internal", undefined, { fetch: async () => { throw new Error("socket closed"); } }).acquire(requestedUrl, options))).resolves.toBe("NETWORK_ERROR");
    await expect(category(new Crawl4AiClient("http://crawl4ai.internal", undefined, { fetch: async () => { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; } }).acquire(requestedUrl, options))).resolves.toBe("TIMEOUT");
  });

  it("distinguishes invalid JSON from invalid envelopes", async () => {
    await expect(category(new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(new Response("not-json", { status: 200 }))).acquire(requestedUrl, options))).resolves.toBe("JSON_PARSE_ERROR");
    await expect(category(new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(new Response(JSON.stringify({ success: false, results: [] }), { status: 200 }))).acquire(requestedUrl, options))).resolves.toBe("INVALID_RESPONSE");
  });

  it.each([
    [JSON.stringify({ success: true }), "MISSING_RESULTS"],
    [JSON.stringify({ success: true, results: [] }), "INVALID_RESPONSE"],
    [JSON.stringify({ success: true, results: [success().results[0], success().results[0]] }), "INVALID_RESPONSE"],
    [JSON.stringify({ success: true, results: ["invalid"] }), "INVALID_RESPONSE"],
    [JSON.stringify(success({ html: undefined })), "MISSING_HTML"],
    [JSON.stringify(success({ html: "" })), "MISSING_HTML"],
    [JSON.stringify(success({ html: "  \n\t" })), "MISSING_HTML"],
    [JSON.stringify({ success: true, results: [{ success: false, html: "", url: requestedUrl, error_message: "upstream denied" }] }), "RESULT_FAILURE"],
    [JSON.stringify(success({ url: undefined, redirected_url: undefined })), "INVALID_RESPONSE"],
    [JSON.stringify(success({ url: "https://other.test/" })), "INVALID_RESPONSE"]
  ] as const)("rejects invalid v0.9.2 result shape (%s)", async (body, expected) => {
    await expect(category(new Crawl4AiClient("http://crawl4ai.internal", undefined, transport(new Response(body, { status: 200 }))).acquire(requestedUrl, options))).resolves.toBe(expected);
  });

  it("retains direct fetch as an independent non-Crawl4AI engine", async () => {
    const engine = new FetchWebsiteAcquisitionEngine({ fetch: async (input, init) => {
      expect(input).toBe("https://example.test/");
      expect(init?.method).toBe("GET");
      return new Response("<html><head><title>Example</title></head><body><a href='/about'>About</a></body></html>", { status: 200 });
    } });
    const result = await engine.acquire("https://example.test/", options);
    expect(result.links).toContain("https://example.test/about");
  });
});
