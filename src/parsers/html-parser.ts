/*
Purpose: convert raw website HTML into a parser-neutral document representation.
Responsibilities: handle encoding/markup normalization and provide safe document traversal to extractors.
Connections: consumes crawler output; passes ParsedDocument to extractor implementations.
Future: Cheerio/DOM adapter, structured-data extraction, and rendered-page support.
Best practice: parser APIs should be deterministic and should not perform network calls.
*/

export interface ParsedDocument { select(selector: string): readonly ParsedNode[]; }
export interface ParsedNode { text(): string; attribute(name: string): string | null; }
export interface HtmlParser { parse(html: string): ParsedDocument; }

