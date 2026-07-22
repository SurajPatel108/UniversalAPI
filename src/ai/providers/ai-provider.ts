export interface StructuredGenerationRequest {
  readonly operation: "dataset_schema" | "extraction_plan";
  readonly prompt: string;
  readonly input: unknown;
}

export interface ProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Provider-neutral boundary. Providers return JSON data only; domain services validate and persist it. */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured(request: StructuredGenerationRequest): Promise<unknown>;
  getLastUsage?(): ProviderUsage | null;
}
