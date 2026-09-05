import type { Citation, ResearchReport, SourceEvidence } from "../types.js";
import type { SourceRegistry } from "./source-registry.js";

/**
 * Folds away the differences that survive a round trip through markdown
 * extraction and a language model, without folding away meaning: whitespace
 * runs, typographic quotes and dashes, and markdown emphasis markers. Anything
 * beyond that is a real difference between what the page says and what the
 * report claims it says.
 */
export function normalizeQuote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Whether a quote really appears in the text the model was shown. */
export function quoteAppearsIn(quote: string, sourceText: string): boolean {
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return false;
  return normalizeQuote(sourceText).includes(needle);
}

/**
 * The mechanical half of "cite your sources". The writer is asked for a verbatim
 * quote per citation precisely so this check is possible: a citation survives
 * only if its source was actually read AND its quote is actually in that
 * source's text. Everything else is dropped and reported, because a citation
 * that cannot be checked is worth less than no citation at all.
 */
export function validateCitations(
  report: ResearchReport,
  registry: SourceRegistry,
  evidence: SourceEvidence[],
): { report: ResearchReport; warnings: string[] } {
  const warnings: string[] = [];
  const excerpts = new Map(evidence.map((e) => [e.ref.id, e.excerpt]));

  const kept: Citation[] = [];
  for (const citation of report.citations) {
    const ref = registry.byId(citation.id);
    if (!ref || !ref.read) {
      warnings.push(
        `dropped citation ${citation.id} — that source was never read`,
      );
      continue;
    }

    const excerpt = excerpts.get(citation.id);
    if (excerpt === undefined) {
      warnings.push(
        `dropped citation ${citation.id} — no text from that source reached the writer`,
      );
      continue;
    }

    if (!quoteAppearsIn(citation.quote, excerpt)) {
      warnings.push(
        `dropped citation ${citation.id} — its quote does not appear in that source's text: ${preview(citation.quote)}`,
      );
      continue;
    }

    kept.push({ ...citation, url: ref.url, title: ref.title });
  }

  const validIds = new Set(kept.map((c) => c.id));
  const reported = new Set<string>();
  for (const marker of report.report.match(/\[S\d+\]/g) ?? []) {
    const bare = marker.slice(1, -1);
    if (validIds.has(bare) || reported.has(bare)) continue;
    reported.add(bare);
    warnings.push(
      `report cites ${bare}, which is not in the validated citation list`,
    );
  }

  return { report: { ...report, citations: kept }, warnings };
}

function preview(quote: string, max = 60): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > max ? `"${flat.slice(0, max)}…"` : `"${flat}"`;
}
