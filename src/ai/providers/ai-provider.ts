export type StructuredJsonSchema = Readonly<Record<string, unknown>>;

export interface StructuredGenerationRequest {
  readonly operation: "dataset_schema" | "extraction_plan";
  readonly prompt: string;
  readonly input: unknown;
  /** Optional provider-neutral response contract for structured-output capable providers. */
  readonly responseSchema?: StructuredJsonSchema;
  /** Immutable prompt/input contract version retained in provider diagnostics. */
  readonly promptVersion?: string;
  /** Optional provider-neutral cap for this individual structured generation request. */
  readonly maxOutputTokens?: number;
}

export interface ProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type AIProviderFailureType =
  | "http_error"
  | "network_error"
  | "invalid_envelope"
  | "empty_response"
  | "truncated_response"
  | "invalid_json"
  | "provider_exception";

/**
 * Transient diagnostics for a failed structured-generation attempt. Raw output
 * is intentionally not a durable artifact and must be exposed only in a
 * development-only boundary.
 */
export interface AIProviderFailureDiagnostic {
  readonly operation: StructuredGenerationRequest["operation"];
  readonly provider: string;
  readonly model: string;
  readonly failureType: AIProviderFailureType;
  readonly parserError: string | null;
  readonly responseLength: number;
  readonly promptVersion: string | null;
  readonly rawResponse: string | null;
  readonly finishReason: string | null;
  readonly usage: ProviderUsage | null;
}

/** Provider-neutral error that keeps vendor failures diagnosable without changing domain artifacts. */
export class AIProviderError extends Error {
  constructor(readonly diagnostic: AIProviderFailureDiagnostic, message: string, readonly retryable = false) {
    super(message);
    this.name = "AIProviderError";
  }
}

/** Provider-neutral boundary. Providers return JSON data only; domain services validate and persist it. */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured(request: StructuredGenerationRequest): Promise<unknown>;
  getLastUsage?(): ProviderUsage | null;
}
