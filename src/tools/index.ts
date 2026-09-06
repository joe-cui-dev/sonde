import { tool } from "ai";
import { z } from "zod";
import type { BudgetTracker } from "../budget/budget.js";
import type { Retrieval } from "../providers/index.js";
import type { PageCache } from "../store/cache.js";
import type { SourceRegistry } from "../agent/source-registry.js";
import type { EventSink, StopReason } from "../types.js";
import { canonicalizeUrl, dedupeByUrl, isHttpUrl } from "../util/url.js";

/** Per-page character cap fed to the model, and the cap across one read call. */
const MAX_CHARS_PER_PAGE = 8_000;
const MAX_CHARS_PER_CALL = 24_000;

/**
 * Split the per-call character budget across pages so a late page is never
 * starved by an early one: everyone gets an equal share first, then whatever
 * nobody needed is handed back to the pages that are still truncated.
 */
export function allocateChars(
  lengths: number[],
  total: number = MAX_CHARS_PER_CALL,
  perPage: number = MAX_CHARS_PER_PAGE,
): number[] {
  if (lengths.length === 0) return [];

  const want = lengths.map((n) => Math.min(Math.max(0, n), perPage));
  const share = Math.floor(total / lengths.length);
  const given = want.map((n) => Math.min(n, share));

  let leftover = total - given.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < given.length && leftover > 0; i += 1) {
    const gap = (want[i] ?? 0) - (given[i] ?? 0);
    if (gap <= 0) continue;
    const give = Math.min(gap, leftover);
    given[i] = (given[i] ?? 0) + give;
    leftover -= give;
  }

  return given;
}

export interface ToolContext {
  retrieval: Retrieval;
  registry: SourceRegistry;
  cache: PageCache;
  budget: BudgetTracker;
  emit: EventSink;
  onSource: (id: string) => void;
  /** Called when a tool is turned away, with the limit that turned it away. */
  onRefusal: (reason: StopReason) => void;
}

const RESOURCE_LABEL: Record<string, string> = {
  max_usd: "dollar budget",
  max_tokens: "token budget",
  max_search_credits: "search-credit budget",
  max_wall_ms: "time budget",
};

/**
 * What the model is told when a tool declines to run. The step limit needs
 * different wording from the rest: there is budget left, just no step in which
 * the answer could be read.
 */
function refusal(reason: StopReason) {
  const conclude =
    "Do not call any more tools. Write your findings now from the evidence you " +
    "already have, and be explicit about what you could not verify.";

  return {
    refused: true as const,
    reason,
    instruction:
      reason === "max_steps"
        ? `This is the last step of the run. Anything fetched now would be paid for and you would never get to read it. ${conclude}`
        : `The ${RESOURCE_LABEL[reason] ?? "retrieval budget"} for this run is spent. ${conclude}`,
  };
}

export function createTools(ctx: ToolContext) {
  return {
    web_search: tool({
      description:
        "Search the web and get ranked results with short snippets. Snippets are NOT " +
        "evidence — they tell you which pages are worth reading. Use several narrow, " +
        "differently-worded queries rather than one broad one.",
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .describe("One focused query. Not a whole research question."),
        topic: z
          .enum(["general", "news", "finance"])
          .default("general")
          .describe(
            'Use "news" for recent events, "finance" for markets/filings.',
          ),
        timeRange: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Only set when recency actually matters."),
        maxResults: z.number().int().min(1).max(15).default(8),
        includeDomains: z.array(z.string()).optional(),
        excludeDomains: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        const blocked = ctx.budget.retrievalBlockedBy();
        if (blocked) {
          ctx.onRefusal(blocked);
          return refusal(blocked);
        }

        const started = Date.now();
        ctx.emit({ type: "tool_start", tool: "web_search", input });

        const outcome = await ctx.retrieval.searcher.search(input.query, {
          maxResults: input.maxResults,
          topic: input.topic,
          ...(input.timeRange ? { timeRange: input.timeRange } : {}),
          ...(input.includeDomains
            ? { includeDomains: input.includeDomains }
            : {}),
          ...(input.excludeDomains
            ? { excludeDomains: input.excludeDomains }
            : {}),
        });

        ctx.budget.addSearchCredits(outcome.creditsUsed);

        const hits = dedupeByUrl(outcome.hits);
        const refs = ctx.registry.registerHits(hits);
        for (const ref of refs) ctx.onSource(ref.id);

        const results = refs.map((ref, i) => ({
          id: ref.id,
          title: ref.title,
          url: ref.url,
          published: ref.publishedDate ?? null,
          alreadyRead: ref.read,
          snippet: hits[i]?.snippet ?? "",
        }));

        ctx.emit({
          type: "tool_end",
          tool: "web_search",
          summary: `"${input.query}" → ${results.length} results (${outcome.creditsUsed} credits)`,
          ms: Date.now() - started,
        });

        return {
          query: input.query,
          results,
          note: "Call read_pages on the ids worth reading. Never cite a source you have not read.",
        };
      },
    }),

    read_pages: tool({
      description:
        "Fetch and read the full cleaned text of up to 5 pages. This is the only way to " +
        "get evidence you may cite. Results are cached, so re-reading a URL is free.",
      inputSchema: z.object({
        urls: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe("Full URLs from a previous web_search result."),
        query: z
          .string()
          .optional()
          .describe(
            "What you are looking for on these pages — helps focus extraction.",
          ),
      }),
      execute: async (input) => {
        const urls = input.urls.map(canonicalizeUrl).filter(isHttpUrl);
        if (urls.length === 0)
          return { error: "No valid http(s) URLs supplied." };

        const started = Date.now();
        ctx.emit({ type: "tool_start", tool: "read_pages", input });

        const { hits: cached, misses } = ctx.cache.partition(urls);

        let fetched: typeof cached = [];
        let failures: Array<{ url: string; error: string }> = [];

        if (misses.length > 0) {
          const blocked = ctx.budget.retrievalBlockedBy();
          if (blocked) {
            ctx.onRefusal(blocked);
            if (cached.length === 0) return refusal(blocked);
            failures = misses.map((url) => ({
              url,
              error:
                blocked === "max_steps"
                  ? "skipped: last step of the run, you would never read it"
                  : "skipped: retrieval budget spent",
            }));
          } else {
            const outcome = await ctx.retrieval.fetcher.fetch(misses, {
              ...(input.query ? { query: input.query } : {}),
            });
            ctx.budget.addSearchCredits(outcome.creditsUsed);
            fetched = outcome.pages;
            failures = outcome.failures;
            for (const page of outcome.pages) ctx.cache.set(page);
          }
        }

        const all = [...cached, ...fetched];
        const allowances = allocateChars(all.map((page) => page.text.length));
        const pages: Array<{
          id: string;
          url: string;
          title: string;
          fromCache: boolean;
          truncated: boolean;
          text: string;
        }> = [];

        all.forEach((page, index) => {
          const ref = ctx.registry.register({
            url: page.url,
            title: page.title ?? page.url,
          });
          const text = page.text.slice(0, allowances[index] ?? 0);

          // `read: true` is what makes a source citable during synthesis, so a
          // page whose text never reached the model must not be given it.
          if (text.length === 0) {
            failures.push({
              url: page.url,
              error:
                page.text.length === 0
                  ? "extraction returned no text — nothing here to cite"
                  : "skipped: per-call character budget spent — read it on its own",
            });
            return;
          }

          ctx.registry.markRead(page.url);
          ctx.onSource(ref.id);

          pages.push({
            id: ref.id,
            url: page.url,
            title: page.title ?? ref.title,
            fromCache: page.fromCache,
            truncated: text.length < page.text.length,
            text,
          });
        });

        ctx.emit({
          type: "tool_end",
          tool: "read_pages",
          summary: `${pages.length} pages (${cached.length} cached, ${failures.length} failed)`,
          ms: Date.now() - started,
        });

        return {
          pages,
          failures,
          note:
            "Quote only what these pages actually say. If a page did not answer your " +
            "question, say so and search differently rather than inferring.",
        };
      },
    }),
  };
}

export type SondeTools = ReturnType<typeof createTools>;
