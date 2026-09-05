import { tavily, type TavilyClient } from "@tavily/core";
import type {
  ContentFetcher,
  FetchOutcome,
  SearchOptions,
  SearchOutcome,
  SearchProvider,
} from "./types.js";
import type { FetchFailure, FetchedPage } from "../types.js";
import { canonicalizeUrl } from "../util/url.js";

export interface TavilyOptions {
  apiKey: string;
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  extractDepth?: "basic" | "advanced";
}

/** Tavily implements both halves of retrieval. Each is exposed separately. */
export class TavilyProvider implements SearchProvider, ContentFetcher {
  readonly name = "tavily";
  private readonly client: TavilyClient;
  private readonly searchDepth: NonNullable<TavilyOptions["searchDepth"]>;
  private readonly extractDepth: NonNullable<TavilyOptions["extractDepth"]>;

  constructor(options: TavilyOptions) {
    this.client = tavily({ apiKey: options.apiKey });
    this.searchDepth = options.searchDepth ?? "advanced";
    this.extractDepth = options.extractDepth ?? "basic";
  }

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchOutcome> {
    const res = await this.client.search(query, {
      searchDepth: this.searchDepth,
      maxResults: options.maxResults ?? 8,
      topic: options.topic ?? "general",
      ...(options.timeRange ? { timeRange: options.timeRange } : {}),
      ...(options.includeDomains?.length
        ? { includeDomains: options.includeDomains }
        : {}),
      ...(options.excludeDomains?.length
        ? { excludeDomains: options.excludeDomains }
        : {}),
      includeAnswer: false,
      includeRawContent: false,
      includeUsage: true,
    });

    return {
      hits: res.results.map((r) => ({
        url: canonicalizeUrl(r.url),
        title: r.title,
        snippet: r.content,
        score: r.score,
        publishedDate: r.publishedDate || undefined,
      })),
      ...(res.answer ? { answer: res.answer } : {}),
      creditsUsed:
        res.usage?.credits ?? estimateSearchCredits(this.searchDepth),
    };
  }

  async fetch(
    urls: string[],
    options: { query?: string } = {},
  ): Promise<FetchOutcome> {
    if (urls.length === 0) return { pages: [], failures: [], creditsUsed: 0 };

    const res = await this.client.extract(urls, {
      extractDepth: this.extractDepth,
      format: "markdown",
      includeUsage: true,
      ...(options.query ? { query: options.query } : {}),
    });

    const now = Date.now();
    const pages: FetchedPage[] = res.results.map((r) => ({
      url: canonicalizeUrl(r.url),
      title: r.title,
      text: r.rawContent,
      fetchedAt: now,
      fromCache: false,
    }));

    const failures: FetchFailure[] = res.failedResults.map((f) => ({
      url: f.url,
      error: f.error,
    }));

    return {
      pages,
      failures,
      creditsUsed:
        res.usage?.credits ??
        estimateExtractCredits(urls.length, this.extractDepth),
    };
  }
}

/** Fallback accounting when the API does not return usage. Deliberately pessimistic. */
function estimateSearchCredits(depth: string): number {
  return depth === "advanced" ? 2 : 1;
}

function estimateExtractCredits(urlCount: number, depth: string): number {
  const perCredit = depth === "advanced" ? 5 : 10;
  return (
    Math.max(1, Math.ceil(urlCount / perCredit)) *
    (depth === "advanced" ? 2 : 1)
  );
}
