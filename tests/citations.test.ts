import { describe, expect, test } from "@jest/globals";

import {
  normalizeQuote,
  quoteAppearsIn,
  validateCitations,
} from "../src/agent/citations.js";
import { SourceRegistry } from "../src/agent/source-registry.js";
import type { ResearchReport, SourceEvidence } from "../src/types.js";

const SPEC_TEXT = [
  "# The Spec",
  "",
  "The documented limit is **42 requests per second**, measured per API key.",
  "Clients that exceed it receive a 429 — see “Rate limiting” below.",
].join("\n");

const BLOG_TEXT =
  "Someone claims the limit is 40 rps, but the post cites no source.";

/** A registry holding two read sources, mirroring what a real run produces. */
function registryWithBoth() {
  const registry = new SourceRegistry();
  registry.register({ url: "https://example.test/spec", title: "The Spec" });
  registry.register({ url: "https://example.test/blog", title: "A Blog" });
  registry.markRead("https://example.test/spec");
  registry.markRead("https://example.test/blog");
  return registry;
}

function evidenceForBoth(): SourceEvidence[] {
  const registry = registryWithBoth();
  return [
    { ref: registry.byId("S1")!, excerpt: SPEC_TEXT },
    { ref: registry.byId("S2")!, excerpt: BLOG_TEXT },
  ];
}

function reportWith(
  citations: Array<{ id: string; quote: string }>,
  body = "The limit is 42 rps [S1].",
): ResearchReport {
  return {
    summary: "The limit is 42 rps.",
    report: body,
    citations: citations.map((c) => ({
      id: c.id,
      url: "https://example.test/whatever",
      title: "whatever the model claimed",
      quote: c.quote,
    })),
    confidence: "high",
    openQuestions: [],
  };
}

describe("normalizeQuote", () => {
  test("folds the artefacts of markdown extraction, not the words", () => {
    expect(normalizeQuote("The  limit\nis 42")).toBe("the limit is 42");
    expect(normalizeQuote("**42 requests**")).toBe("42 requests");
    expect(normalizeQuote("“Rate limiting”")).toBe('"rate limiting"');
    expect(normalizeQuote("a—b")).toBe("a-b");
  });

  test("keeps different claims different", () => {
    expect(normalizeQuote("42 rps")).not.toBe(normalizeQuote("40 rps"));
  });
});

describe("quoteAppearsIn", () => {
  test("accepts a quote that survived markdown emphasis and rewrapping", () => {
    expect(quoteAppearsIn("42 requests per second", SPEC_TEXT)).toBe(true);
    expect(quoteAppearsIn("The documented limit is 42 requests", SPEC_TEXT)).toBe(
      true,
    );
    expect(quoteAppearsIn('see "Rate limiting" below', SPEC_TEXT)).toBe(true);
  });

  test("rejects a quote that is not in the text", () => {
    expect(quoteAppearsIn("40 requests per second", SPEC_TEXT)).toBe(false);
    expect(quoteAppearsIn("", SPEC_TEXT)).toBe(false);
  });

  test("rejects a paraphrase, however close", () => {
    expect(quoteAppearsIn("the limit is 42 requests a second", SPEC_TEXT)).toBe(
      false,
    );
  });
});

describe("validateCitations", () => {
  test("keeps a citation whose quote is really in the source", () => {
    const { report, warnings } = validateCitations(
      reportWith([{ id: "S1", quote: "42 requests per second" }]),
      registryWithBoth(),
      evidenceForBoth(),
    );

    expect(report.citations.map((c) => c.id)).toEqual(["S1"]);
    expect(warnings).toEqual([]);
    // The url and title come from the registry, never from the model.
    expect(report.citations[0]!.url).toBe("https://example.test/spec");
    expect(report.citations[0]!.title).toBe("The Spec");
  });

  test("drops a fabricated quote and says which one", () => {
    const { report, warnings } = validateCitations(
      reportWith([{ id: "S1", quote: "the limit is 9000 rps" }]),
      registryWithBoth(),
      evidenceForBoth(),
    );

    expect(report.citations).toEqual([]);
    expect(warnings[0]).toContain("dropped citation S1");
    expect(warnings[0]).toContain("does not appear in that source's text");
    expect(warnings[0]).toContain("the limit is 9000 rps");
    // The orphaned marker in the body is reported too.
    expect(warnings.join(" ")).toContain("report cites S1");
  });

  /**
   * The exact failure the live OpenRouter run produced: with no page text in
   * front of it the writer quoted the one string it did have — the title.
   */
  test("drops a quote lifted from the title rather than the body", () => {
    const { report, warnings } = validateCitations(
      reportWith([{ id: "S1", quote: "The Spec" }]),
      registryWithBoth(),
      // Body text that does not repeat the title.
      [{ ref: registryWithBoth().byId("S1")!, excerpt: SPEC_TEXT.slice(12) }],
    );

    expect(report.citations).toEqual([]);
    expect(warnings.join(" ")).toContain("dropped citation S1");
  });

  test("drops a citation to a source that was never read", () => {
    const registry = new SourceRegistry();
    registry.register({ url: "https://example.test/spec", title: "The Spec" });
    registry.register({ url: "https://example.test/blog", title: "A Blog" });
    registry.markRead("https://example.test/spec");

    const { report, warnings } = validateCitations(
      reportWith([
        { id: "S1", quote: "42 requests per second" },
        { id: "S2", quote: "the limit is 40 rps" },
      ]),
      registry,
      [{ ref: registry.byId("S1")!, excerpt: SPEC_TEXT }],
    );

    expect(report.citations.map((c) => c.id)).toEqual(["S1"]);
    expect(warnings.join(" ")).toContain(
      "dropped citation S2 — that source was never read",
    );
  });

  test("drops a citation to a read source whose text never reached the writer", () => {
    const { report, warnings } = validateCitations(
      reportWith([{ id: "S2", quote: "the limit is 40 rps" }]),
      registryWithBoth(),
      // S2 was read, but no excerpt was available to hand over.
      [{ ref: registryWithBoth().byId("S1")!, excerpt: SPEC_TEXT }],
    );

    expect(report.citations).toEqual([]);
    expect(warnings.join(" ")).toContain(
      "dropped citation S2 — no text from that source reached the writer",
    );
  });

  test("reports each orphaned marker once, however often it appears", () => {
    const { warnings } = validateCitations(
      reportWith(
        [{ id: "S1", quote: "invented" }],
        "Claim one [S1]. Claim two [S1]. Claim three [S1].",
      ),
      registryWithBoth(),
      evidenceForBoth(),
    );

    expect(warnings.filter((w) => w.includes("report cites S1"))).toHaveLength(
      1,
    );
  });
});
