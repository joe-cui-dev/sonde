import { describe, expect, test } from "@jest/globals";
import { loadConfig } from "../src/config.js";

const KEYS = { OPENROUTER_API_KEY: "sk-or-test", TAVILY_API_KEY: "tvly-test" };

describe("loadConfig", () => {
  test('treats a blank value in .env as "use the default"', () => {
    // `SONDE_MAX_USD=` with nothing after it used to coerce to 0 and fail the
    // positive() check, which reads like the user typed a bad number.
    const config = loadConfig({
      ...KEYS,
      SONDE_MAX_USD: "",
      SONDE_MAX_STEPS: "   ",
      SONDE_SEARCH_DEPTH: "",
      SONDE_LOG_LEVEL: "",
    });

    expect(config.maxUsd).toBe(1);
    expect(config.maxSteps).toBe(16);
    expect(config.searchDepth).toBe("advanced");
    expect(config.logLevel).toBe("info");
  });

  test("caps the writer's reasoning by default", () => {
    // Left to the provider, one run spent 22,301 reasoning tokens on a report
    // whose text was 2,469 tokens. The cap is the default, not opt-in.
    expect(loadConfig(KEYS).writerReasoningEffort).toBe("low");
    expect(
      loadConfig({ ...KEYS, SONDE_WRITER_REASONING_EFFORT: "" })
        .writerReasoningEffort,
    ).toBe("low");
  });

  test("the reasoning cap can be retuned or handed back to the provider", () => {
    expect(
      loadConfig({ ...KEYS, SONDE_WRITER_REASONING_EFFORT: "high" })
        .writerReasoningEffort,
    ).toBe("high");
    expect(
      loadConfig({ ...KEYS, SONDE_WRITER_REASONING_EFFORT: "default" })
        .writerReasoningEffort,
    ).toBe("default");
    expect(() =>
      loadConfig({ ...KEYS, SONDE_WRITER_REASONING_EFFORT: "very hard" }),
    ).toThrow(/writerReasoningEffort/);
  });

  test("pins the writer to verified providers by default", () => {
    // Unpinned, OpenRouter picked a provider per request and some of them
    // returned a report that would not parse — a whole run's retrieval paid
    // for and thrown away. The pin is the default, not opt-in.
    const providers = loadConfig(KEYS).writerProviders;
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain("DeepInfra");
    expect(
      loadConfig({ ...KEYS, SONDE_WRITER_PROVIDERS: "" }).writerProviders,
    ).toEqual(providers);
  });

  test("writer routing can be re-pinned or handed back to OpenRouter", () => {
    expect(
      loadConfig({ ...KEYS, SONDE_WRITER_PROVIDERS: " Together , Parasail " })
        .writerProviders,
    ).toEqual(["Together", "Parasail"]);

    // Empty means unrestricted everywhere downstream, so "any" has to be the
    // only way to reach it — a list that is all separators is a typo.
    expect(
      loadConfig({ ...KEYS, SONDE_WRITER_PROVIDERS: "any" }).writerProviders,
    ).toEqual([]);
    expect(() =>
      loadConfig({ ...KEYS, SONDE_WRITER_PROVIDERS: ",  ,," }),
    ).toThrow(/writerProviders/);
  });

  test("an explicit value still wins over the default", () => {
    expect(loadConfig({ ...KEYS, SONDE_MAX_USD: "2.5" }).maxUsd).toBe(2.5);
    expect(loadConfig({ ...KEYS, SONDE_MAX_USD: " 2.5 " }).maxUsd).toBe(2.5);
  });

  test.each([
    ["abc", "expected number"],
    ["-1", "must be greater than 0"],
    ["0", "must be greater than 0"],
  ])("rejects %s with a usable message", (value, expected) => {
    expect(() => loadConfig({ ...KEYS, SONDE_MAX_USD: value })).toThrow(
      expected,
    );
  });

  test("rejects the placeholder key from .env.example", () => {
    expect(() =>
      loadConfig({ ...KEYS, OPENROUTER_API_KEY: "sk-or-v1-REPLACE_ME" }),
    ).toThrow("still the placeholder");
  });
});
