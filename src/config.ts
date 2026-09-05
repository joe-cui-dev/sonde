import { z } from 'zod';
import type { LogLevel } from './util/log.js';

/** Node 22 reads .env natively — no dotenv dependency. */
function loadDotEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent or unreadable — fall through to real process env
    }
  }
}

const num = (fallback: number) =>
  z.coerce.number().finite().positive().default(fallback);

const ConfigSchema = z.object({
  openrouterApiKey: z.string().min(1, 'OPENROUTER_API_KEY is missing'),
  tavilyApiKey: z.string().min(1, 'TAVILY_API_KEY is missing'),

  plannerModel: z.string().default('anthropic/claude-sonnet-4.5'),
  writerModel: z.string().default('anthropic/claude-sonnet-4.5'),

  maxSteps: num(16),
  maxUsd: num(1),
  maxTokens: num(400_000),
  maxSearchCredits: num(60),
  maxWallMs: num(300_000),

  searchProvider: z.enum(['tavily']).default('tavily'),
  searchDepth: z.enum(['basic', 'advanced', 'fast', 'ultra-fast']).default('advanced'),
  extractDepth: z.enum(['basic', 'advanced']).default('basic'),

  dbPath: z.string().default('.sonde/sonde.db'),
  cacheTtlHours: num(168),

  logLevel: z.enum(['silent', 'info', 'debug']).default('info'),
  appUrl: z.string().default('https://github.com/sonde'),
  appTitle: z.string().default('Sonde'),
});

export type Config = z.infer<typeof ConfigSchema> & { logLevel: LogLevel };

const PLACEHOLDER = /REPLACE_ME/i;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  loadDotEnv();
  const env = { ...process.env, ...overrides };

  const parsed = ConfigSchema.safeParse({
    openrouterApiKey: env.OPENROUTER_API_KEY,
    tavilyApiKey: env.TAVILY_API_KEY,
    plannerModel: env.SONDE_PLANNER_MODEL,
    writerModel: env.SONDE_WRITER_MODEL,
    maxSteps: env.SONDE_MAX_STEPS,
    maxUsd: env.SONDE_MAX_USD,
    maxTokens: env.SONDE_MAX_TOKENS,
    maxSearchCredits: env.SONDE_MAX_SEARCH_CREDITS,
    maxWallMs: env.SONDE_MAX_WALL_MS,
    searchProvider: env.SONDE_SEARCH_PROVIDER,
    searchDepth: env.SONDE_SEARCH_DEPTH,
    extractDepth: env.SONDE_EXTRACT_DEPTH,
    dbPath: env.SONDE_DB_PATH,
    cacheTtlHours: env.SONDE_CACHE_TTL_HOURS,
    logLevel: env.SONDE_LOG_LEVEL,
    appUrl: env.SONDE_APP_URL,
    appTitle: env.SONDE_APP_TITLE,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }

  const config = parsed.data as Config;

  for (const [name, value] of [
    ['OPENROUTER_API_KEY', config.openrouterApiKey],
    ['TAVILY_API_KEY', config.tavilyApiKey],
  ] as const) {
    if (PLACEHOLDER.test(value)) {
      throw new Error(`${name} is still the placeholder from .env.example — put a real key in .env.`);
    }
  }

  return config;
}
