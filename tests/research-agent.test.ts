import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runResearch,
  writerModelSettings,
} from "../src/agent/research-agent.js";
import { openDb } from "../src/store/db.js";
import type { RunEvent } from "../src/types.js";
import {
  calls,
  erroringStreamModel,
  fakeRetrieval,
  hangingModel,
  says,
  scriptedModel,
  streamedModel,
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
  test("emits transient synthesis previews before the validated final report", async () => {
    const events: RunEvent[] = [];

    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: { planner: healthyPlanner(), writer: streamedModel(REPORT) },
      onEvent: (event) => events.push(event),
    });

    const previewIndex = events.findIndex(
      (event) => event.type === "report_preview",
    );
    const endIndex = events.findIndex((event) => event.type === "run_end");
    expect(previewIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeLessThan(endIndex);
    expect(result.report?.report).toContain("42 requests per second");

    const db = openDb(dbPath);
    const storedTypes = db
      .prepare("SELECT type FROM run_events WHERE run_id = ?")
      .all(result.runId) as Array<{ type: string }>;
    db.close();
    expect(storedTypes.map((row) => row.type)).not.toContain("report_preview");
  });

  test("reports a mid-stream provider error as itself, not as a parse failure", async () => {
    const result = await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner: healthyPlanner(),
        writer: erroringStreamModel("Provider returned error"),
      },
    });

    expect(result.report).toBeNull();
    const synthesisWarning = result.warnings.find((w) =>
      w.startsWith("synthesis failed"),
    );
    expect(synthesisWarning).toContain("Provider returned error");
    expect(synthesisWarning).not.toContain("could not parse the response");
  });

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
    expect(result.notes).toContain(
      "Sub-question: what is the documented limit",
    );
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

  test("calls a run that finished with steps to spare complete", async () => {
    const planner = healthyPlanner();
    const writer = scriptedModel([says(JSON.stringify(REPORT))]);

    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxSteps: 5 },
      retrieval: fakeRetrieval(PAGES),
      models: { planner, writer },
    });

    expect(result.usage.steps).toBe(3);
    expect(result.stoppedBy).toBe("complete");
    expect(result.usage.hit).toBeNull();
    expect(result.warnings).toEqual([]);
    // No step was clamped, so every call was free to use tools.
    expect(planner.toolChoices).toEqual(["auto", "auto", "auto"]);
    // And the writer is not told to hedge a report that is not actually thin.
    expect(writer.prompts[0]).not.toContain("stopped early");
  });

  test("spends the last allowed step writing instead of on a doomed tool call", async () => {
    const planner = healthyPlanner();
    const writer = scriptedModel([says(JSON.stringify(REPORT))]);

    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxSteps: 3 },
      retrieval: fakeRetrieval(PAGES),
      models: { planner, writer },
    });

    // Tools are switched off for the final step, so the model cannot spend it
    // fetching something the loop will stop before it can read.
    expect(planner.toolChoices).toEqual(["auto", "auto", "none"]);

    // Reaching that step means it was still calling tools a step earlier, so
    // the run was truncated however politely it ended.
    expect(result.stoppedBy).toBe("max_steps");
    expect(result.warnings.join(" ")).toContain("3-step limit");
    expect(writer.prompts[0]).toContain("stopped early");
  });

  test("calls a run whose tools were turned away cut short, not complete", async () => {
    const writer = scriptedModel([says(JSON.stringify(REPORT))]);
    const planner = scriptedModel([
      // Reads the spec, and in doing so spends 90% of the dollar budget.
      calls(
        "read_pages",
        { urls: ["https://example.test/spec"] },
        { text: "Established: the spec says 42 rps [S1].", costUsd: 0.009 },
      ),
      // Wants to search, is turned away by the reserve, and wraps up politely.
      calls(
        "web_search",
        { query: "rate limit", topic: "general", maxResults: 5 },
        { text: "Blocked from searching further.", costUsd: 0 },
      ),
      says("Concluding with what I have.", 0),
    ]);
    const retrieval = fakeRetrieval(PAGES);
    const events: RunEvent[] = [];

    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxUsd: 0.01 },
      retrieval,
      models: { planner, writer },
      onEvent: (e) => events.push(e),
    });

    // The search never happened, and no limit is technically over its line —
    // the reserve stopped it. finishReason alone would have said "complete".
    expect(retrieval.searches).toEqual([]);
    expect(result.stoppedBy).toBe("max_usd");
    expect(writer.prompts[0]).toContain("stopped early");

    // A refusal is a real event, not something to be inferred from the stop
    // reason after the fact.
    expect(result.warnings.join(" ")).toContain(
      "retrieval was cut short by max_usd",
    );
    expect(events.filter((e) => e.type === "warning")).toHaveLength(1);

    // And nothing opened a tool call it did not close.
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(
      events.filter((e) => e.type === "tool_end").length,
    );
  });

  test("reconciles stoppedBy with the final snapshot when the writer overspends", async () => {
    // Research stays well inside $0.01; the writer's own call blows past it.
    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxUsd: 0.01 },
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(REPORT), 0.02)]),
      },
    });

    // The record used to say "complete" while its own snapshot showed a
    // breached limit. Both now agree.
    expect(result.usage.usd).toBeCloseTo(0.023, 6);
    expect(result.usage.hit).toBe("max_usd");
    expect(result.stoppedBy).toBe("max_usd");
    // The report is still returned — it was paid for, and it is valid.
    expect(result.report?.citations.map((c) => c.id)).toEqual(["S1"]);
  });

  test("never reports complete while a limit sits over its line", async () => {
    const result = await runResearch({
      question: "What is the rate limit?",
      config: { ...testConfig(dbPath), maxSearchCredits: 2 },
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner: healthyPlanner(),
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    expect(result.usage.hit).not.toBeNull();
    expect(result.stoppedBy).not.toBe("complete");
  });

  test("aborts a writer that would run past the wall-clock budget", async () => {
    const result = await runResearch({
      question: "What is the rate limit?",
      // Enough time for the (instant) mock loop, not enough for a writer that
      // never answers.
      config: { ...testConfig(dbPath), maxWallMs: 400 },
      retrieval: fakeRetrieval(PAGES),
      models: { planner: healthyPlanner(), writer: hangingModel() },
    });

    expect(result.report).toBeNull();
    expect(result.warnings.join(" ")).toContain("wall-clock");
    expect(result.stoppedBy).toBe("max_wall_ms");
    // The run still hands back everything it paid for.
    expect(result.notes).toContain("42 rps");
    expect(result.sources.filter((s) => s.read)).toHaveLength(1);
    // And it did not overrun by much — the point of the deadline.
    expect(result.usage.elapsedMs).toBeLessThan(2_000);
  });

  test("does not start a writer when the wall-clock budget is already gone", async () => {
    const writer = scriptedModel([says(JSON.stringify(REPORT))]);
    const planner = scriptedModel([
      calls(
        "read_pages",
        { urls: ["https://example.test/spec"] },
        { text: "Established: the spec says 42 rps [S1]." },
      ),
      says("Concluding."),
    ]);

    const result = await runResearch({
      question: "What is the rate limit?",
      // The fetch itself outlasts the whole budget, so the run arrives at
      // synthesis having already read a page and having no time to write.
      config: { ...testConfig(dbPath), maxWallMs: 200 },
      retrieval: fakeRetrieval(PAGES, 600),
      models: { planner, writer },
    });

    expect(result.sources.filter((s) => s.read)).toHaveLength(1);
    expect(writer.callCount).toBe(0);
    expect(result.report).toBeNull();
    expect(result.warnings.join(" ")).toContain("No time left");
    expect(result.stoppedBy).toBe("max_wall_ms");
    // The evidence it paid for still comes back to the caller.
    expect(result.notes).toContain("42 rps");
  });

  test("shows the planner no id it could cite a snippet by", async () => {
    const planner = healthyPlanner();

    await runResearch({
      question: "What is the rate limit?",
      config: testConfig(dbPath),
      retrieval: fakeRetrieval(PAGES),
      models: {
        planner,
        writer: scriptedModel([says(JSON.stringify(REPORT))]),
      },
    });

    // Step 2's prompt carries the search results. Both pages are in there, and
    // neither has been read, so neither has anything the model could write into
    // a "[S1]" marker.
    const afterSearch = planner.prompts[1]!;
    expect(afterSearch).toContain("https://example.test/spec");
    expect(afterSearch).toContain('"citeAs":null');
    expect(afterSearch).not.toContain('"citeAs":"S');

    // Step 3's prompt carries the read page — which does have an id.
    expect(planner.prompts[2]!).toContain('"citeAs":"S1"');
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

describe("writerModelSettings", () => {
  test("caps the writer's reasoning and keeps usage accounting on", () => {
    const settings = writerModelSettings({
      ...testConfig("/tmp/unused.db"),
      writerReasoningEffort: "low",
    });

    // Usage accounting is what makes the dollar budget real, so it stays.
    expect(settings.usage).toEqual({ include: true });
    expect(settings.reasoning).toEqual({ effort: "low" });
  });

  test('sends no reasoning field at all on "default"', () => {
    const settings = writerModelSettings({
      ...testConfig("/tmp/unused.db"),
      writerReasoningEffort: "default",
    });

    // Absent, not `{ effort: "default" }` — "default" is our word, not the
    // provider's, and sending it would be rejected.
    expect("reasoning" in settings).toBe(false);
    expect(settings.usage).toEqual({ include: true });
  });

  test("pins routing to the configured providers with fallbacks off", () => {
    const settings = writerModelSettings({
      ...testConfig("/tmp/unused.db"),
      writerProviders: ["Together", "Parasail"],
    });

    // Falling back past the list would defeat the point of having one: the
    // fallback is exactly the provider that is not known to return parseable
    // structured output.
    expect(settings.extraBody).toEqual({
      provider: { order: ["Together", "Parasail"], allow_fallbacks: false },
    });
  });

  test("sends no provider block when routing is unpinned", () => {
    const settings = writerModelSettings({
      ...testConfig("/tmp/unused.db"),
      writerProviders: [],
    });

    expect("extraBody" in settings).toBe(false);
  });

  test("passes a retuned effort through unchanged", () => {
    expect(
      writerModelSettings({
        ...testConfig("/tmp/unused.db"),
        writerReasoningEffort: "xhigh",
      }).reasoning,
    ).toEqual({ effort: "xhigh" });
  });
});
