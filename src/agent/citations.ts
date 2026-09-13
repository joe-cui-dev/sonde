import type { Citation, ResearchReport, SourceEvidence } from "../types.js";
import type { SourceRegistry } from "./source-registry.js";

/**
* Folds away what survives a round trip through markdown extraction and a
* model — whitespace runs, typographic quotes and dashes, emphasis markers —
* and nothing more. Anything beyond that is a real difference between what the
* page says and what the report claims it says.
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
* The mechanical half of "cite your sources", which is why a verbatim quote is
* asked for per citation: one survives only if its source was read AND its
* quote is in that source's text. The result holds exactly one validated
* citation per marker used across both visible fields. Unused and duplicate
* entries are repairable and dropped; a marker with no validated citation
* invalidates the report, since its claim cannot be removed mechanically.
*/
export function validateCitations(
  report: ResearchReport,
  registry: SourceRegistry,
  evidence: SourceEvidence[],
): { report: ResearchReport; warnings: string[]; valid: boolean } {
  const warnings: string[] = [];
  const excerpts = new Map(evidence.map((e) => [e.ref.id, e.excerpt]));

  const kept: Citation[] = [];
  const keptIds = new Set<string>();
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

    if (keptIds.has(citation.id)) {
      warnings.push(
        `dropped duplicate citation ${citation.id} — list each cited source once`,
      );
      continue;
    }

    keptIds.add(citation.id);
    kept.push({ ...citation, url: ref.url, title: ref.title });
  }

  // Both fields are user-visible claims, so both are under the citation
  // contract. Repeated markers are one reference: the schema asks for one
  // entry per source id, not per occurrence.
  const content = `${report.summary}\n${report.report}`;
  const markerIds = new Set(
    (content.match(/\[S\d+\]/g) ?? []).map((marker) => marker.slice(1, -1)),
  );

  let valid = true;
  for (const id of markerIds) {
    if (keptIds.has(id)) continue;
    valid = false;
    warnings.push(
      `report content cites ${id}, which is not in the validated citation list`,
    );
  }

  const used = kept.filter((citation) => markerIds.has(citation.id));
  for (const citation of kept) {
    if (markerIds.has(citation.id)) continue;
    warnings.push(
      `dropped unused citation ${citation.id} — no marker refers to it`,
    );
  }

  return { report: { ...report, citations: used }, warnings, valid };
}

function preview(quote: string, max = 60): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > max ? `"${flat.slice(0, max)}…"` : `"${flat}"`;
}
