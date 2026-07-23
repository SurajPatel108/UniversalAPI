import { describe, expect, it, vi } from "vitest";
import { AIProviderError } from "../../src/ai/providers/ai-provider.js";
import { GeminiProvider } from "../../src/ai/providers/gemini-provider.js";

const request = {
  operation: "dataset_schema" as const,
  prompt: "Return a schema proposal.",
  promptVersion: "schema-v3",
  responseSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  input: { semanticPageContent: ["Catalog item"] }
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function candidate(text: string, finishReason = "STOP"): unknown {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12, totalTokenCount: 22 } };
}

describe("GeminiProvider", () => {
  it("sends the provider-neutral response schema and parses a valid structured response", async () => {
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      capturedInit = init;
      return response(candidate('{"value":"ok"}'));
    };
    const provider = new GeminiProvider("gemini-test", "secret", fetcher);

    await expect(provider.generateStructured(request)).resolves.toEqual({ value: "ok" });

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", maxOutputTokens: 2048, responseJsonSchema: request.responseSchema });
    expect(provider.getLastUsage()).toEqual({ promptTokens: 10, completionTokens: 12, totalTokens: 22 });
  });

  it("accepts only complete outer Markdown fences around JSON", async () => {
    const fetcher = vi.fn(async () => response(candidate('```json\n{"value":"fenced"}\n```')));
    const provider = new GeminiProvider("gemini-test", "secret", fetcher as typeof fetch);

    await expect(provider.generateStructured(request)).resolves.toEqual({ value: "fenced" });
  });

  it("uses the extraction-plan response schema, fence parser, and both bounded output budgets", async () => {
    const capturedInits: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      capturedInits.push(init ?? {});
      return response(candidate('```json\n{"pageTypes":[]}\n```'));
    };
    const provider = new GeminiProvider("gemini-test", "secret", fetcher);

    await expect(provider.generateStructured({ ...request, operation: "extraction_plan" as const, maxOutputTokens: 2_048 })).resolves.toEqual({ pageTypes: [] });
    await expect(provider.generateStructured({ ...request, operation: "extraction_plan" as const, maxOutputTokens: 4_096 })).resolves.toEqual({ pageTypes: [] });

    const generationConfigs = capturedInits.map((init) => JSON.parse(String(init.body)).generationConfig);
    expect(generationConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({ maxOutputTokens: 2_048, responseJsonSchema: request.responseSchema }),
      expect.objectContaining({ maxOutputTokens: 4_096, responseJsonSchema: request.responseSchema })
    ]));
  });

  it("reports malformed JSON without repairing it", async () => {
    const raw = '{"value": nope}';
    const provider = new GeminiProvider("gemini-test", "secret", vi.fn(async () => response(candidate(raw))) as typeof fetch);

    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      name: "AIProviderError",
      diagnostic: { failureType: "invalid_json", parserError: expect.any(String), responseLength: raw.length, rawResponse: raw, promptVersion: "schema-v3" }
    });
  });

  it("reports token-limited output before attempting JSON parsing", async () => {
    const raw = '{"value":"partial';
    const provider = new GeminiProvider("gemini-test", "secret", vi.fn(async () => response(candidate(raw, "MAX_TOKENS"))) as typeof fetch);

    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      name: "AIProviderError",
      diagnostic: { failureType: "truncated_response", finishReason: "MAX_TOKENS", rawResponse: raw }
    });
  });

  it("classifies incomplete JSON as truncated even without a MAX_TOKENS finish reason", async () => {
    const raw = '{"value":"unterminated';
    const provider = new GeminiProvider("gemini-test", "secret", vi.fn(async () => response(candidate(raw))) as typeof fetch);

    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      diagnostic: { failureType: "truncated_response", finishReason: "STOP", rawResponse: raw }
    });
  });

  it("reports empty and invalid provider envelopes structurally", async () => {
    const empty = new GeminiProvider("gemini-test", "secret", vi.fn(async () => response(candidate(""))) as typeof fetch);
    const envelope = new GeminiProvider("gemini-test", "secret", vi.fn(async () => response({ usageMetadata: {} })) as typeof fetch);

    await expect(empty.generateStructured(request)).rejects.toMatchObject({ diagnostic: { failureType: "empty_response", responseLength: 0 } });
    await expect(envelope.generateStructured(request)).rejects.toMatchObject({ diagnostic: { failureType: "invalid_envelope" } });
  });

  it("reports HTTP and transport exceptions with diagnostics", async () => {
    const http = new GeminiProvider("gemini-test", "secret", vi.fn(async () => response({ error: "denied" }, 429)) as typeof fetch);
    const network = new GeminiProvider("gemini-test", "secret", vi.fn(async () => { throw new Error("socket closed"); }) as typeof fetch);

    await expect(http.generateStructured(request)).rejects.toMatchObject({ diagnostic: { failureType: "http_error", rawResponse: expect.stringContaining("denied") } });
    await expect(network.generateStructured(request)).rejects.toMatchObject({ diagnostic: { failureType: "network_error", parserError: "socket closed", rawResponse: null } });
  });
});
