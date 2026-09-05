import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runResearch } from "../src/agent/research-agent.js";
import { openDb } from "../src/store/db.js";
import type { RunEvent } from "../src/types.js";
import {
  calls,
  fakeRetrieval,
  says,
  scriptedModel,
  testConfig,
  type FakePage,
} from "./helpers/mock.js";

const PAGES: FakePage[] = [
  {
    url: "https://example.test/spec",
    title: "The Spec",
    text: "The limit is 42 requests per second, as of March 2024.",
  },
  {
    url: "https://example.test/blog",
    title: "A Blog",
    text: "Someone claims the limit is 40 rps, but cites no source.",
  },
];

const REPORT = {
  summary: "The limit is 42 rps.",
  report: "The documented limit is 42 requests per second [S1].",
  citations: [
    {
      id: "S1",
      url: "https://example.test/spec",
      title: "The Spec",
      quote: "The limit is 42 requests per second",
    },
  ],
  confidence: "high",
  openQuestions: [],
};

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sonde-test-"));
  dbPath = join(dir, "test.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The three steps a healthy run takes: search, read, then write notes. */
function healthyPlanner() {
  return scriptedModel([
    calls("web_search", {
      query: "rate limit",
      topic: "general",
      maxResults: 5,
    }),
    calls("read_pages", { urls: ["https://example.test/spec"] }),
    says("Sub-question: what is the limit? Established: 42 rps [S1]."),
  ]);
}

describe("runResearch (offline)", () => {
  test("searches, reads, and synthesises a cited report", async () => {
    const retrieval = fakeRetrieval(PAGES);
    const events: RunEvent[] = [];

    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval,
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
      onEvent: (e) => events.push(e),
    });

    expect(result.stoppedBy).toBe("complete");
    expect(result.report?.summary).toBe("The limit is 42 rps.");
    expect(result.report?.citations).toHaveLength(1);
    expect(result.warnings).toEqual([]);

    // Only the page that was actually fetched is citable.
    expect(result.sources.filter((s) => s.read).map((s) => s.url)).toEqual([
      "https://example.test/spec",
    ]);

    // Budget accounting saw both phases: 3 planner steps + 1 synthesis call.
    expect(result.usage.steps).toBe(3);
    expect(result.usage.usd).toBeCloseTo(0.004, 6);
    expect(result.usage.searchCredits).toBe(3); // 2 search + 1 extract

    expect(retrieval.searches).toEqual(["rate limit"]);
    expect(events.map((e) => e.type)).toContain("run_end");
  });

  test("keeps the notes it already paid for when the loop throws", async () => {
    const planner = scriptedModel([
      calls("web_search", {
        query: "rate limit",
        topic: "general",
        maxResults: 5,
      }),
      calls(
        "read_pages",
        { urls: ["https://example.test/spec"] },
        { text: "Established so far: the spec says 42 rps [S1]." },
      ),
      new Error("429 rate limited by upstream provider"),
    ]);

    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxSteps: 8 },
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner,
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    expect(result.stoppedBy).toBe("error");
    // The point of the fix: the run still produces a report from partial notes.
    expect(result.notes).toContain("42 rps");
    expect(result.report?.summary).toBe("The limit is 42 rps.");
    expect(result.warnings.join(" ")).toContain(
      "synthesising from partial notes",
    );
  });

  test("produces no report when nothing was ever read", async () => {
    const planner = scriptedModel([says("I could not find anything.")]);

    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner,
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    expect(result.report).toBeNull();
    expect(result.warnings.join(" ")).toContain("nothing to cite");
  });

  test("drops a citation that points at a source the loop never read", async () => {
    const invented = {
      ...REPORT,
      report: "The limit is 42 rps [S1], and rising [S2].",
      citations: [
        ...REPORT.citations,
        {
          id: "S2",
          url: "https://example.test/blog",
          title: "A Blog",
          quote: "invented",
        },
      ],
    };

    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(invented))]),
      },
    });

    expect(result.report?.citations.map((c) => c.id)).toEqual(["S1"]);
    expect(result.warnings.join(" ")).toContain("dropped citation S2");
  });

  test("hands the writer the actual page text, not just titles and urls", async () => {
    const writer = scriptedModel([says(JSON.stringify(REPORT))]);

    await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: { planner: healthyPlanner(), writer },
    });

    const prompt = writer.prompts[0]!;
    // The body of the page that was read — without it, "quote your source" is
    // an instruction the writer can only satisfy by inventing something.
    expect(prompt).toContain(PAGES[0]!.text);
    // And the researcher's own notes, so the writer knows what was established.
    expect(prompt).toContain("Established: 42 rps");
    // The page that was never read stays out of the writer's reach entirely.
    expect(prompt).not.toContain(PAGES[1]!.text);
  });

  test("drops a citation whose quote is not in the page that was read", async () => {
    const fabricated = {
      ...REPORT,
      report: "The limit is 42 rps [S1].",
      citations: [
        {
          id: "S1",
          url: "https://example.test/spec",
          title: "The Spec",
          // Plausible, attributed to a page that really was read — and absent
          // from that page. This is the shape of the failure a live run hit.
          quote: "throughput doubled year over year",
        },
      ],
    };

    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(fabricated))]),
      },
    });

    expect(result.report?.citations).toEqual([]);
    expect(result.warnings.join(" ")).toContain(
      "does not appear in that source's text",
    );
    expect(result.warnings.join(" ")).toContain("report cites S1");
  });

  test("keeps a citation quoting the page across markdown emphasis", async () => {
    const emphasised: FakePage[] = [
      {
        url: "https://example.test/spec",
        title: "The Spec",
        text: "The limit is **42 requests per second**, as of March 2024.",
      },
    ];

    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(emphasised),
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    expect(result.report?.citations.map((c) => c.id)).toEqual(["S1"]);
    expect(result.warnings).toEqual([]);
  });

  test("keeps every step's findings when the loop is cut off by max_steps", async () => {
    const planner = scriptedModel([
      calls(
        "web_search",
        { query: "rate limit", topic: "general", maxResults: 5 },
        { text: "Sub-question: what is the documented limit?" },
      ),
      calls(
        "read_pages",
        { urls: ["https://example.test/spec"] },
        { text: "Established: the spec says 42 rps [S1]." },
      ),
      calls(
        "read_pages",
        { urls: ["https://example.test/blog"] },
        { text: "One more page to check before I conclude." },
      ),
    ]);
    const writer = scriptedModel([says(JSON.stringify(REPORT))]);

    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxSteps: 3 },
      retrieval: fakeRetrieval(PAGES),
      models: { planner, writer },
    });

    expect(result.stoppedBy).toBe("max_steps");

    // The regression: the run used to keep only the last step's text, throwing
    // away the finding in step 2 — the one thing the report needed.
    expect(result.notes).toContain("Sub-question: what is the documented limit");
    expect(result.notes).toContain("Established: the spec says 42 rps");
    expect(result.notes).toContain("One more page to check");
    expect(writer.prompts[0]).toContain("Established: the spec says 42 rps");

    // And the report still comes out cited rather than empty.
    expect(result.report?.citations.map((c) => c.id)).toEqual(["S1"]);
  });

  test("does not pay for a page on the final step that nobody will read", async () => {
    const retrieval = fakeRetrieval(PAGES);
    const planner = scriptedModel([
      calls("web_search", {
        query: "rate limit",
        topic: "general",
        maxResults: 5,
      }),
      calls(
        "read_pages",
        { urls: ["https://example.test/spec"] },
        { text: "Established: the spec says 42 rps [S1]." },
      ),
      calls("read_pages", { urls: ["https://example.test/blog"] }),
    ]);

    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxSteps: 3 },
      retrieval,
      models: {
        planner,
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    // The last step's fetch never happened, so the blog never became citable.
    expect(retrieval.fetches).toEqual([["https://example.test/spec"]]);
    expect(result.sources.filter((s) => s.read).map((s) => s.id)).toEqual([
      "S1",
    ]);
  });

  test("records the run and its sources in sqlite", async () => {
    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    const db = openDb(dbPath);
    const run = db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(result.runId) as Record<string, unknown>;
    const sources = db
      .prepare(
        "SELECT sid, was_read FROM sources WHERE run_id = ? ORDER BY sid",
      )
      .all(result.runId) as Array<Record<string, unknown>>;
    db.close();

    expect(run["stopped_by"]).toBe("complete");
    expect(run["report_json"]).toContain("42 rps");
    expect(sources).toHaveLength(2);
    expect(sources.filter((s) => s["was_read"] === 1)).toHaveLength(1);
  });
});
