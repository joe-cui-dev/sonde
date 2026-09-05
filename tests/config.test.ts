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
