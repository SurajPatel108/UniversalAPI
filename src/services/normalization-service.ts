import type { ExtractionFieldRule } from "../models/extraction.js";

export interface NormalizationResult { readonly value: unknown; readonly actions: readonly string[]; readonly error?: string; readonly defaultApplied: boolean; }

/** Pure, ordered normalization pipeline. It has no provider, network, clock, or mutable state. */
export class NormalizationService {
  normalize(raw: string | null, rule: ExtractionFieldRule, schemaProperty: unknown, pageUrl: string): NormalizationResult {
    const actions: string[] = [];
    if (raw === null || raw === "") return this.nullOrDefault(rule, actions);
    let value = raw.normalize("NFKC"); actions.push("unicode");
    value = value.trim(); actions.push("trim");
    value = value.replace(/\s+/g, " "); actions.push("whitespace");
    const property = this.record(schemaProperty);
    const transforms = new Set(rule.transforms);
    try {
      let normalized: unknown = value;
      if (transforms.has("to_number") || (property.type === "number" || property.type === "integer") && !transforms.has("to_currency")) { normalized = this.number(value); actions.push("number"); }
      if (transforms.has("to_boolean") || property.type === "boolean") { normalized = this.boolean(String(normalized)); actions.push("boolean"); }
      if (transforms.has("to_currency")) { normalized = this.currency(String(normalized)); actions.push("currency"); }
      if (transforms.has("to_date")) { normalized = this.date(String(normalized)); actions.push("date"); }
      if (transforms.has("canonical_url") || property.format === "uri") { normalized = new URL(String(normalized), pageUrl).toString(); actions.push("url"); }
      if (Array.isArray(property.enum)) { normalized = this.enumValue(String(normalized), property.enum); actions.push("enum"); }
      if (property.type === "string" && transforms.has("to_string")) { normalized = String(normalized); actions.push("type"); }
      return { value: normalized, actions, defaultApplied: false };
    } catch (error) {
      return { value: null, actions, error: error instanceof Error ? error.message : "Normalization failed", defaultApplied: false };
    }
  }

  private nullOrDefault(rule: ExtractionFieldRule, actions: string[]): NormalizationResult { if (rule.defaultValue !== undefined) { actions.push("default"); return { value: rule.defaultValue, actions, defaultApplied: true }; } actions.push("null"); return { value: null, actions, defaultApplied: false }; }
  private number(value: string): number { const normalized = value.replace(/,/g, ""); if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) throw new Error("Invalid number"); const result = Number(normalized); if (!Number.isFinite(result)) throw new Error("Invalid number"); return result; }
  private boolean(value: string): boolean { const normalized = value.toLowerCase(); if (["true", "1", "yes"].includes(normalized)) return true; if (["false", "0", "no"].includes(normalized)) return false; throw new Error("Invalid boolean"); }
  private currency(value: string): number { return this.number(value.replace(/[^0-9.+-]/g, "")); }
  private date(value: string): string { if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error("Invalid ISO date"); return value; }
  private enumValue(value: string, values: readonly unknown[]): unknown { const found = values.find((candidate) => typeof candidate === "string" && candidate.toLocaleLowerCase() === value.toLocaleLowerCase()); if (found === undefined) throw new Error("Value is outside enum"); return found; }
  private record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
}
