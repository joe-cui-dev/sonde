import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allocateChars, createTools } from "../src/tools/index.js";
import { SourceRegistry } from "../src/agent/source-registry.js";
import { BudgetTracker } from "../src/budget/budget.js";
import { PageCache } from "../src/store/cache.js";
import { openDb, type Db } from "../src/store/db.js";
import { fakeRetrieval, type FakePage } from "./helpers/mock.js";

const LIMITS = {
  maxSteps: 8,
  maxUsd: 1,
  maxTokens: 400_000,
  maxSearchCredits: 60,
  maxWallMs: 300_000,
};

describe("allocateChars", () => {
  test("gives every page a share instead of starving the last ones", () => {
    // Five pages that each want more than a fifth of the budget.
    const given = allocateChars([8000, 8000, 8000, 8000, 8000], 24_000, 8_000);
    expect(given).toEqual([4800, 4800, 4800, 4800, 4800]);
    expect(given.every((n) => n > 0)).toBe(true);
    expect(given.reduce((a, b) => a + b, 0)).toBe(24_000);
  });

  test("hands what short pages did not need back to the long ones", () => {
    const given = allocateChars([100, 100, 20_000], 24_000, 8_000);
    expect(given).toEqual([100, 100, 8_000]);
  });

  test("never exceeds the per-page cap or the call budget", () => {
    const given = allocateChars([50_000, 50_000], 24_000, 8_000);
    expect(given).toEqual([8_000, 8_000]);
  });

  test("handles the empty case", () => {
    expect(allocateChars([], 24_000, 8_000)).toEqual([]);
  });
});

describe("read_pages", () => {
  let dir: string;
  let db: Db;

  const bigPages: FakePage[] = Array.from({ length: 5 }, (_, i) => ({
    url: `https://example.test/p${i}`,
    title: `Page ${i}`,
    text: "x".repeat(20_000),
  }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sonde-tools-"));
    db = openDb(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function context(pages: FakePage[], limits = LIMITS) {
    const registry = new SourceRegistry();
    const retrieval = fakeRetrieval(pages);
    const budget = new BudgetTracker(limits);
    return {
      registry,
      retrieval,
      budget,
      ctx: {
        retrieval,
        registry,
        cache: new PageCache(db, 3_600_000),
        budget,
        emit: () => {},
        onSource: () => {},
        onRefusal: () => {},
      },
    };
  }

  test("marks a page read only when its text actually reached the model", async () => {
    const { registry, ctx } = context(bigPages);
    const tools = createTools(ctx);

    const result = (await tools.read_pages.execute!(
      { urls: bigPages.map((p) => p.url) },
      { toolCallId: "t1", messages: [] } as never,
    )) as {
      pages: Array<{ citeAs: string; text: string; truncated: boolean }>;
      failures: Array<{ url: string; error: string }>;
    };

    // Every page got a slice, so every page is legitimately citable.
    expect(result.pages).toHaveLength(5);
    expect(result.failures).toHaveLength(0);
    for (const page of result.pages) {
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.truncated).toBe(true);
    }

    // The invariant that matters: read === the model saw the text.
    const read = registry.read();
    expect(read).toHaveLength(5);
    expect(read.every((s) => s.read)).toBe(true);
  });

  test("does not make an empty page citable", async () => {
    const { registry, ctx } = context([
      { url: "https://example.test/empty", title: "Empty", text: "" },
    ]);
    const tools = createTools(ctx);

    const result = (await tools.read_pages.execute!(
      { urls: ["https://example.test/empty"] },
      { toolCallId: "t1", messages: [] } as never,
    )) as { pages: unknown[]; failures: Array<{ url: string; error: string }> };

    expect(result.pages).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(registry.read()).toHaveLength(0);
  });
});

describe("the final-step reserve", () => {
  let dir: string;
  let db: Db;

  const page: FakePage = {
    url: "https://example.test/spec",
    title: "The Spec",
    text: "The limit is 42 requests per second.",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sonde-reserve-"));
    db = openDb(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function context(limits = { ...LIMITS, maxSteps: 3 }) {
    const registry = new SourceRegistry();
    const retrieval = fakeRetrieval([page]);
    const budget = new BudgetTracker(limits);
    const refusals: string[] = [];
    return {
      registry,
      retrieval,
      budget,
      refusals,
      tools: createTools({
        retrieval,
        registry,
        cache: new PageCache(db, 3_600_000),
        budget,
        emit: () => {},
        onSource: () => {},
        onRefusal: (reason) => refusals.push(reason),
      }),
    };
  }

  const runOpts = { toolCallId: "t1", messages: [] } as never;

  test("read_pages refuses on the last step instead of paying for an unread page", async () => {
    const { registry, retrieval, budget, refusals, tools } = context();
    budget.countStep();
    budget.countStep(); // now on the final step of three

    const result = (await tools.read_pages.execute!(
      { urls: [page.url] },
      runOpts,
    )) as { refused?: true; reason?: string; instruction?: string };

    expect(result.refused).toBe(true);
    expect(result.reason).toBe("max_steps");
    expect(result.instruction).toContain("never get to read it");
    // The agent hears about it, which is how a cut-short run gets labelled.
    expect(refusals).toEqual(["max_steps"]);

    // Nothing was fetched, and — the bug this guards — nothing became citable.
    expect(retrieval.fetches).toEqual([]);
    expect(registry.read()).toHaveLength(0);
    expect(budget.snapshot().searchCredits).toBe(0);
  });

  test("web_search refuses on the last step too", async () => {
    const { retrieval, budget, refusals, tools } = context();
    budget.countStep();
    budget.countStep();

    const result = (await tools.web_search.execute!(
      { query: "rate limit", topic: "general", maxResults: 5 },
      runOpts,
    )) as { refused?: true; reason?: string };

    expect(result.refused).toBe(true);
    expect(result.reason).toBe("max_steps");
    expect(refusals).toEqual(["max_steps"]);
    expect(retrieval.searches).toEqual([]);
  });

  test("names the resource that ran out, not just 'budget'", async () => {
    const { budget, refusals, tools } = context({
      ...LIMITS,
      maxSteps: 8,
      maxSearchCredits: 10,
    });
    budget.addSearchCredits(10);

    const result = (await tools.web_search.execute!(
      { query: "rate limit", topic: "general", maxResults: 5 },
      runOpts,
    )) as { reason?: string; instruction?: string };

    expect(result.reason).toBe("max_search_credits");
    expect(result.instruction).toContain("search-credit budget");
    expect(refusals).toEqual(["max_search_credits"]);
  });

  test("still retrieves while a later step can read the result", async () => {
    const { registry, retrieval, budget, tools } = context();
    budget.countStep(); // one step used, two left

    const result = (await tools.read_pages.execute!(
      { urls: [page.url] },
      runOpts,
    )) as { pages?: unknown[]; refused?: true };

    expect(result.refused).toBeUndefined();
    expect(result.pages).toHaveLength(1);
    expect(retrieval.fetches).toEqual([[page.url]]);
    expect(registry.read()).toHaveLength(1);
  });

  test("serves a cached page on the last step, since that costs nothing", async () => {
    const { registry, retrieval, budget, tools } = context();
    await tools.read_pages.execute!({ urls: [page.url] }, runOpts);

    budget.countStep();
    budget.countStep();
    budget.countStep();
    // Exhausted on steps, but the page is already paid for and in the cache.
    const result = (await tools.read_pages.execute!(
      { urls: [page.url] },
      runOpts,
    )) as { pages?: Array<{ fromCache: boolean }>; refused?: true };

    expect(result.refused).toBeUndefined();
    expect(result.pages?.[0]?.fromCache).toBe(true);
    expect(retrieval.fetches).toHaveLength(1); // no second network call
    expect(registry.read()).toHaveLength(1);
  });
});

describe("citable ids", () => {
  let dir: string;
  let db: Db;

  const page: FakePage = {
    url: "https://example.test/spec",
    title: "The Spec",
    text: "The limit is 42 requests per second.",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sonde-ids-"));
    db = openDb(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function context() {
    const registry = new SourceRegistry();
    return {
      registry,
      tools: createTools({
        retrieval: fakeRetrieval([page]),
        registry,
        cache: new PageCache(db, 3_600_000),
        budget: new BudgetTracker(LIMITS),
        emit: () => {},
        onSource: () => {},
        onRefusal: () => {},
      }),
    };
  }

  const runOpts = { toolCallId: "t1", messages: [] } as never;
  const search = {
    query: "rate limit",
    topic: "general" as const,
    maxResults: 5,
  };

  type SearchOut = {
    results: Array<{ url: string; citeAs: string | null }>;
    note: string;
  };

  test("a search result the model has not read carries no id", async () => {
    const { tools } = context();

    const out = (await tools.web_search.execute!(search, runOpts)) as SearchOut;

    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.citeAs).toBeNull();
    expect(out.results[0]!.url).toBe(page.url);
    // Nothing in the payload the model could copy into a "[S1]" marker.
    expect(JSON.stringify(out.results)).not.toMatch(/S\d/);
    expect(out.note).toContain("cannot be cited");
  });

  test("reading a page is what mints its id", async () => {
    const { registry, tools } = context();
    await tools.web_search.execute!(search, runOpts);

    const out = (await tools.read_pages.execute!(
      { urls: [page.url] },
      runOpts,
    )) as { pages: Array<{ citeAs: string; url: string }> };

    expect(out.pages[0]!.citeAs).toBe("S1");
    expect(registry.byId("S1")!.read).toBe(true);
  });

  test("a later search surfaces the id of a page already read", async () => {
    const { tools } = context();
    await tools.web_search.execute!(search, runOpts);
    await tools.read_pages.execute!({ urls: [page.url] }, runOpts);

    const out = (await tools.web_search.execute!(
      { ...search, query: "rate limit again" },
      runOpts,
    )) as SearchOut;

    // Now it has text behind it, so the id appears and it can be cited.
    expect(out.results[0]!.citeAs).toBe("S1");
  });

  test("still records what was found but not read, for the run record", async () => {
    const { registry, tools } = context();
    await tools.web_search.execute!(search, runOpts);

    // The source is tracked and numbered internally — it just has no citable
    // id until it is read, so the run can still report found-vs-read.
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]!.id).toBe("S1");
    expect(registry.read()).toHaveLength(0);
    expect(registry.citableId(registry.all()[0]!)).toBeNull();
  });
});
