import type { FetchFailure, FetchedPage, SearchHit } from '../types.js';

export interface SearchOptions {
  maxResults?: number;
  topic?: 'general' | 'news' | 'finance';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Provider-supplied direct answer, when it offers one. Never cited on its own. */
  answer?: string;
  /** Billing units consumed, in the provider's own currency (Tavily: credits). */
  creditsUsed: number;
}

export interface FetchOutcome {
  pages: FetchedPage[];
  failures: FetchFailure[];
  creditsUsed: number;
}

/**
 * Searching and reading are two different jobs. Tavily happens to do both;
 * Brave, Exa, or a self-hosted fetcher may do only one. Keep them separable so
 * swapping either side never touches the agent.
 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchOutcome>;
}

export interface ContentFetcher {
  readonly name: string;
  fetch(urls: string[], options?: { query?: string }): Promise<FetchOutcome>;
}
