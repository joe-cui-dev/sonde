import type { Config } from "../config.js";
import type { ContentFetcher, SearchProvider } from "./types.js";
import { TavilyProvider } from "./tavily.js";

export interface Retrieval {
  searcher: SearchProvider;
  fetcher: ContentFetcher;
}

/**
* The single place provider choice is made. Returning
* `{ searcher: brave, fetcher: tavily }` here is the whole of swapping one out.
*/
export function createRetrieval(config: Config): Retrieval {
  switch (config.searchProvider) {
    case "tavily": {
      const tavily = new TavilyProvider({
        apiKey: config.tavilyApiKey,
        searchDepth: config.searchDepth,
        extractDepth: config.extractDepth,
      });
      return { searcher: tavily, fetcher: tavily };
    }
    default: {
      const exhaustive: never = config.searchProvider;
      throw new Error(`Unknown search provider: ${String(exhaustive)}`);
    }
  }
}

export type { ContentFetcher, SearchProvider } from "./types.js";
