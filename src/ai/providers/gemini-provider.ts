import {
  AIProviderError,
  type AIProvider,
  type AIProviderFailureDiagnostic,
  type ProviderUsage,
  type StructuredGenerationRequest
} from "./ai-provider.js";
import type { Environment } from "../../config/environment.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    finishMessage?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const SCHEMA_GENERATION_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_MAX_OUTPUT_TOKENS = 512;

/** Gemini-specific transport is intentionally isolated to this provider implementation. */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private lastUsage: ProviderUsage | null = null;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly developmentDiagnostics = false
  ) {}

  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    this.lastUsage = null;
    console.info("[ai-provider] Gemini request started", { operation: request.operation, model: this.model });

    const generationConfig = {
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: request.maxOutputTokens ?? (request.operation === "dataset_schema" ? SCHEMA_GENERATION_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS),
      ...(request.responseSchema ? { responseJsonSchema: request.responseSchema } : {})
    };
    const payloadBody = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${request.prompt}\n\nInput:\n${JSON.stringify(request.input)}` }] }],
      generationConfig
    });

    let response: Response;
    try {
      response = await this.fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payloadBody
        }
      );
    } catch (error) {
      throw this.failure(request, "network_error", error instanceof Error ? error.message : "Gemini network request failed", null, null, false);
    }

    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      throw this.failure(request, "http_error", `Gemini request failed with HTTP ${response.status}`, responseText, null, response.status >= 500);
    }

    let payload: GeminiResponse;
    try {
      payload = JSON.parse(responseText) as GeminiResponse;
    } catch (error) {
      throw this.failure(request, "invalid_envelope", error instanceof Error ? error.message : "Gemini response envelope was not JSON", responseText, null, false);
    }

    this.lastUsage = {
      promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: payload.usageMetadata?.totalTokenCount ?? 0
    };
    console.info("[ai-provider] Gemini request completed", { operation: request.operation, model: this.model, ...this.lastUsage });

    const candidate = payload.candidates?.[0];
    if (!candidate) {
      throw this.failure(request, "invalid_envelope", "Gemini response did not contain a candidate", responseText, null, false);
    }

    const rawText = candidate.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const finishReason = candidate.finishReason ?? null;
    if (finishReason === "MAX_TOKENS") {
      throw this.failure(request, "truncated_response", candidate.finishMessage ?? "Gemini stopped at the output-token limit", rawText, finishReason, false);
    }
    if (!rawText.trim()) {
      throw this.failure(request, "empty_response", candidate.finishMessage ?? "Gemini returned no structured content", rawText, finishReason, false);
    }

    try {
      return JSON.parse(unwrapOuterMarkdownFence(rawText));
    } catch (error) {
      const parserError = error instanceof Error ? error.message : "Gemini response was not valid JSON";
      throw this.failure(request, isIncompleteJsonError(parserError) ? "truncated_response" : "invalid_json", parserError, rawText, finishReason, false);
    }
  }

  getLastUsage(): ProviderUsage | null {
    return this.lastUsage;
  }

  private failure(
    request: StructuredGenerationRequest,
    failureType: AIProviderFailureDiagnostic["failureType"],
    parserError: string,
    rawResponse: string | null,
    finishReason: string | null,
    retryable: boolean
  ): AIProviderError {
    const diagnostic: AIProviderFailureDiagnostic = {
      operation: request.operation,
      provider: this.name,
      model: this.model,
      failureType,
      parserError,
      responseLength: rawResponse?.length ?? 0,
      promptVersion: request.promptVersion ?? null,
      rawResponse,
      finishReason,
      usage: this.lastUsage
    };
    if (this.developmentDiagnostics) {
      console.error("[ai-provider] Gemini structured generation failed", diagnostic);
    }
    return new AIProviderError(diagnostic, `Gemini structured generation failed: ${failureType}`, retryable);
  }
}

/** Removes only a complete outer Markdown fence; malformed content remains untouched for deterministic diagnostics. */
function unwrapOuterMarkdownFence(value: string): string {
  const match = /^\s*```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*\s*$/i.exec(value);
  return match ? match[1] : value;
}

function isIncompleteJsonError(message: string): boolean {
  return /unexpected end of json input|unterminated string/i.test(message);
}

export function createConfiguredGeminiProvider(environment: Environment): AIProvider | null {
  if (!environment.geminiApiKey) return null;
  return new GeminiProvider(
    environment.aiModel?.trim() || DEFAULT_GEMINI_MODEL,
    environment.geminiApiKey,
    fetch,
    environment.nodeEnv === "development"
  );
}
