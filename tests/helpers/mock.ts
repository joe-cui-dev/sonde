import { MockLanguageModelV4 } from "ai/test";
import type { Config } from "../../src/config.js";
import type { Retrieval } from "../../src/providers/index.js";
import type { FetchOutcome, SearchOutcome } from "../../src/providers/types.js";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

export function usage(input = 100, output = 50) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** A step where the model just talks — used for the final notes. */
export function says(text: string, costUsd = 0.001): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(),
    warnings: [],
    providerMetadata: { openrouter: { usage: { cost: costUsd } } },
  } as GenerateResult;
}

/**
 * A step where the model calls one tool, optionally narrating first. The
 * narration matters: it is what a run has to fall back on if a later step dies.
 */
export function calls(
  toolName: string,
  input: unknown,
  options: { text?: string; costUsd?: number } = {},
): GenerateResult {
  const costUsd = options.costUsd ?? 0.001;
  return {
    content: [
      ...(options.text ? [{ type: "text" as const, text: options.text }] : []),
      {
        type: "tool-call",
        toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: usage(),
    warnings: [],
    providerMetadata: { openrouter: { usage: { cost: costUsd } } },
  } as GenerateResult;
}

/**
 * Plays the given steps in order; a step may be an Error to throw instead.
 * Every prompt it was sent is kept, flattened to text — that is how a test can
 * assert what the model was actually shown, rather than what we meant to show it.
 */
export function scriptedModel(steps: Array<GenerateResult | Error>) {
  let index = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    modelId: "mock/planner",
    doGenerate: async (options) => {
      prompts.push(flattenPrompt(options.prompt));
      const step = steps[index];
      index += 1;
      if (step === undefined)
        throw new Error(`mock model ran out of steps at ${index}`);
      if (step instanceof Error) throw step;
      return step;
    },
  });
  return Object.assign(model, {
    prompts,
    get callCount() {
      return index;
    },
  });
}

/**
 * A model that never answers and rejects only when its call is aborted — used
 * to prove a deadline is actually wired to the request.
 */
export function hangingModel() {
  return new MockLanguageModelV4({
    modelId: "mock/hanging",
    doGenerate: ({ abortSignal }) =>
      new Promise<GenerateResult>((_, reject) => {
        const fail = () =>
          reject(abortSignal?.reason ?? new Error("aborted"));
        if (abortSignal?.aborted) fail();
        else abortSignal?.addEventListener("abort", fail);
      }),
  });
}

/** Collapses a prompt's messages into one searchable string. */
function flattenPrompt(prompt: unknown): string {
  const messages = (prompt ?? []) as Array<{ content?: unknown }>;
  return messages
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part: Record<string, unknown>) =>
          typeof part["text"] === "string"
            ? part["text"]
            : JSON.stringify(part["output"] ?? part["input"] ?? ""),
        )
        .join("\n");
    })
    .join("\n");
}

export interface FakePage {
  url: string;
  title: string;
  text: string;
}

/**
 * Retrieval that never touches the network and bills a fixed credit cost.
 * `delayMs` makes a fetch take real time, which is how a test can walk a run
 * into its own wall-clock deadline.
 */
export function fakeRetrieval(
  pages: FakePage[],
  delayMs = 0,
): Retrieval & { searches: string[]; fetches: string[][] } {
  const searches: string[] = [];
  const fetches: string[][] = [];
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  return {
    searches,
    fetches,
    searcher: {
      name: "fake",
      async search(query): Promise<SearchOutcome> {
        searches.push(query);
        return {
          hits: pages.map((p) => ({
            url: p.url,
            title: p.title,
            snippet: p.text.slice(0, 80),
            score: 0.9,
          })),
          creditsUsed: 2,
        };
      },
    },
    fetcher: {
      name: "fake",
      async fetch(urls): Promise<FetchOutcome> {
        fetches.push([...urls]);
        if (delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        const found = urls.filter((u) => byUrl.has(u));
        return {
          pages: found.map((u) => {
            const p = byUrl.get(u)!;
            return {
              url: p.url,
              title: p.title,
              text: p.text,
              fetchedAt: Date.now(),
              fromCache: false,
            };
          }),
          failures: urls
            .filter((u) => !byUrl.has(u))
            .map((url) => ({ url, error: "not found" })),
          creditsUsed: found.length,
        };
      },
    },
  };
}

export function testConfig(dbPath: string): Config {
  return {
    openrouterApiKey: "sk-or-test",
    tavilyApiKey: "tvly-test",
    plannerModel: "mock/planner",
    writerModel: "mock/writer",
    maxSteps: 8,
    maxUsd: 1,
    maxTokens: 400_000,
    maxSearchCredits: 60,
    maxWallMs: 300_000,
    searchProvider: "tavily",
    searchDepth: "basic",
    extractDepth: "basic",
    dbPath,
    cacheTtlHours: 168,
    logLevel: "silent",
    appUrl: "https://example.test",
    appTitle: "sonde-test",
  };
}
