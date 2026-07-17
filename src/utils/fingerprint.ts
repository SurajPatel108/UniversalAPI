/*
Purpose: provide deterministic content fingerprints used by versioning and change detection.
Responsibilities: define canonicalization and hashing contracts without deciding monitoring policy.
Connections: crawlers/monitoring create fingerprints; repositories store them for comparison.
Future: semantic DOM fingerprints and field-level change summaries.
Best practice: make canonicalization explicit and test it; hash comparisons alone do not prove meaningful change.
*/

export interface Fingerprint { algorithm: "sha256"; value: string; }

