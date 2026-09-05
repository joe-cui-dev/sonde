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

  function context(pages: FakePage[]) {
    const registry = new SourceRegistry();
    return {
      registry,
      ctx: {
        retrieval: fakeRetrieval(pages),
        registry,
        cache: new PageCache(db, 3_600_000),
        budget: new BudgetTracker(LIMITS),
        emit: () => {},
        onSource: () => {},
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
      pages: Array<{ id: string; text: string; truncated: boolean }>;
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
