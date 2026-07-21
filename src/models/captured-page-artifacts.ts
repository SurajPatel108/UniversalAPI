/** Acquisition-engine-neutral artifacts associated with an immutable website capture. */
export interface CapturedPageArtifacts {
  readonly rawHtml: string;
  readonly markdown?: string;
  readonly cleanedContent?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly links: readonly string[];
  readonly finalUrl: string;
  readonly screenshot?: string;
}
