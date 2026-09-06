import { z } from "zod";
import type { LogLevel } from "./util/log.js";

/** Node 22 reads .env natively — no dotenv dependency. */
function loadDotEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent or unreadable — fall through to real process env
    }
  }
}

/**
 * A key left blank in .env (`SONDE_MAX_USD=`) means "use the default", not "0".
 * Without this, `z.coerce.number()` turns "" into 0 and every budget field
 * fails its `.positive()` check with an error that reads like a typo.
 */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The upstream providers allowed to write the report.
 *
 * OpenRouter spreads a model across every provider serving it, and they do not
 * all honour a JSON schema once the response is streamed. One observed run had
 * the whole report returned as a JSON string nested inside another JSON string
 * and truncated; another answered a streaming request with an in-stream 429.
 * Either way the report is lost after the retrieval it was built from has
 * already been paid for, so routing is pinned to the providers whose streamed
 * output was actually checked against the report schema.
 *
 * This list is a snapshot, not a ranking — re-check it when the writer model
 * changes. `SONDE_WRITER_PROVIDERS=any` hands routing back to OpenRouter.
 */
const VERIFIED_WRITER_PROVIDERS = [
  "BaseTen",
  "CoreWeave",
  "DeepInfra",
  "Fireworks",
  "Morph",
  "NextBit",
  "Parasail",
  "Together",
  "Venice",
];

const num = (fallback: number) =>
  z.coerce
    .number()
    .finite("must be a number")
    .positive("must be greater than 0")
    .default(fallback);

const ConfigSchema = z.object({
  openrouterApiKey: z.string().min(1, "OPENROUTER_API_KEY is missing"),
  tavilyApiKey: z.string().min(1, "TAVILY_API_KEY is missing"),

  plannerModel: z.string().default("z-ai/glm-5.3-flash"),
  writerModel: z.string().default("z-ai/glm-5.3-flash"),
  writeModel: z.string().default(""),

  /**
   * How hard the writer is allowed to think. "default" sends nothing and lets
   * the provider decide — which is how one run spent 22,301 reasoning tokens to
   * produce 2,469 tokens of report.
   */
  writerReasoningEffort: z
    .enum(["default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .default("low"),
  writeReasoningEffort: z
    .enum(["default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .default("medium"),

  /**
   * Empty means "no restriction". A list is sent as an ordered preference with
   * fallbacks off: falling back past the list would put the report back in the
   * hands of a provider that is not known to produce parseable output, which
   * is the failure this setting exists to prevent.
   */
  writerProviders: z
    .string()
    .default(VERIFIED_WRITER_PROVIDERS.join(","))
    .refine(
      (raw) =>
        raw.trim().toLowerCase() === "any" ||
        raw.split(",").some((name) => name.trim().length > 0),
      'must be a comma-separated list of OpenRouter provider names, or "any" to let OpenRouter route',
    )
    .transform((raw) =>
      raw.trim().toLowerCase() === "any"
        ? []
        : raw
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
    ),

  maxSteps: num(16),
  maxUsd: num(1),
  maxTokens: num(400_000),
  maxSearchCredits: num(60),
  maxWallMs: num(900_000),

  searchProvider: z.enum(["tavily"]).default("tavily"),
  searchDepth: z
    .enum(["basic", "advanced", "fast", "ultra-fast"])
    .default("advanced"),
  extractDepth: z.enum(["basic", "advanced"]).default("basic"),

  dbPath: z.string().default(".sonde/sonde.db"),
  /** Where writing runs keep their prose. Under .sonde/, which is gitignored. */
  writingDir: z.string().default(".sonde/writing"),
  cacheTtlHours: num(168),

  logLevel: z.enum(["silent", "info", "debug"]).default("info"),
  appUrl: z.string().default("https://github.com/sonde"),
  appTitle: z.string().default("Sonde"),
});

export type Config = z.infer<typeof ConfigSchema> & {
  logLevel: LogLevel;
  writeModelFallsBack: boolean;
};

const PLACEHOLDER = /REPLACE_ME/i;

export function loadConfig(
  overrides: Partial<Record<string, string>> = {},
): Config {
  loadDotEnv();
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    env[key] = present(value);
  }

  const parsed = ConfigSchema.safeParse({
    openrouterApiKey: env.OPENROUTER_API_KEY,
    tavilyApiKey: env.TAVILY_API_KEY,
    plannerModel: env.SONDE_PLANNER_MODEL,
    writerModel: env.SONDE_WRITER_MODEL,
    writeModel: env.SONDE_WRITE_MODEL,
    writerReasoningEffort: env.SONDE_WRITER_REASONING_EFFORT,
    writeReasoningEffort: env.SONDE_WRITE_REASONING_EFFORT,
    writerProviders: env.SONDE_WRITER_PROVIDERS,
    maxSteps: env.SONDE_MAX_STEPS,
    maxUsd: env.SONDE_MAX_USD,
    maxTokens: env.SONDE_MAX_TOKENS,
    maxSearchCredits: env.SONDE_MAX_SEARCH_CREDITS,
    maxWallMs: env.SONDE_MAX_WALL_MS,
    searchProvider: env.SONDE_SEARCH_PROVIDER,
    searchDepth: env.SONDE_SEARCH_DEPTH,
    extractDepth: env.SONDE_EXTRACT_DEPTH,
    dbPath: env.SONDE_DB_PATH,
    writingDir: env.SONDE_WRITING_DIR,
    cacheTtlHours: env.SONDE_CACHE_TTL_HOURS,
    logLevel: env.SONDE_LOG_LEVEL,
    appUrl: env.SONDE_APP_URL,
    appTitle: env.SONDE_APP_TITLE,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`,
    );
  }

  const config = parsed.data as Config;
  const writeModelFallsBack = !config.writeModel;
  if (writeModelFallsBack) config.writeModel = config.writerModel;
  (config as Config).writeModelFallsBack = writeModelFallsBack;

  for (const [name, value] of [
    ["OPENROUTER_API_KEY", config.openrouterApiKey],
    ["TAVILY_API_KEY", config.tavilyApiKey],
  ] as const) {
    if (PLACEHOLDER.test(value)) {
      throw new Error(
        `${name} is still the placeholder from .env.example — put a real key in .env.`,
      );
    }
  }

  return config;
}
