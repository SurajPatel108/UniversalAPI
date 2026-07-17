/*
Purpose: represent an immutable, reproducible capture of an upstream source response.
Responsibilities: retain content location, fetch metadata, content fingerprint, and timestamp.
Connections: crawlers create snapshots; parsers consume them; monitoring compares their fingerprints.
Future: add object-storage keys, response headers, screenshots, and retention policy metadata.
Best practice: avoid storing large bodies in relational rows; use encrypted object storage with lifecycle rules.
*/

export interface SourceSnapshot { id: string; sourceId: string; contentType: string; fingerprint: string; capturedAt: Date; }

