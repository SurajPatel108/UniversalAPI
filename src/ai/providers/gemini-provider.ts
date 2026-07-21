import type { AIProvider, ProviderUsage, StructuredGenerationRequest } from "./ai-provider.js";
import type { Environment } from "../../config/environment.js";

interface GeminiResponse { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }; }

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

/** Gemini-specific transport is intentionally isolated to this provider implementation. */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private lastUsage: ProviderUsage | null = null;
  constructor(readonly model: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}
  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    console.info("[schema-understanding] Gemini request started");
    const payloadBody = JSON.stringify({ contents: [{ role: "user", parts: [{ text: `${request.prompt}\n\nInput:\n${JSON.stringify(request.input)}` }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 512 } });
    const response = await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payloadBody
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const detail = errorText ? ` ${errorText}` : "";
      console.error("[schema-understanding] Gemini request failed", { status: response.status, detail });
      throw new Error(`Gemini request failed with HTTP ${response.status}${detail}`);
    }
    const payload = await response.json() as GeminiResponse;
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const truncatedText = rawText.length > 2_000 ? `${rawText.slice(0, 2_000)}…` : rawText;
    console.info("[schema-understanding] Gemini raw response", { responsePreview: truncatedText });
    const text = rawText;
    this.lastUsage = {
      promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: payload.usageMetadata?.totalTokenCount ?? 0
    };
    console.info("[schema-understanding] Gemini request completed", this.lastUsage);
    if (!text) throw new Error("Gemini returned no structured content");
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Gemini response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  getLastUsage(): ProviderUsage | null { return this.lastUsage; }
}

export function createConfiguredGeminiProvider(environment: Environment): AIProvider | null {
  if (!environment.geminiApiKey) return null;
  return new GeminiProvider(environment.aiModel?.trim() || DEFAULT_GEMINI_MODEL, environment.geminiApiKey);
}
