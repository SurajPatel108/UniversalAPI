import * as cheerio from "cheerio";

/** Static, network-free Cheerio parser used exclusively by deterministic extraction. */
export class CheerioExtractionParser {
  parse(html: string) { return cheerio.load(html, { xmlMode: false }); }
}
