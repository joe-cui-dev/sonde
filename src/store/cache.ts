import type { Db } from "./db.js";
import type { FetchedPage } from "../types.js";
import { canonicalizeUrl } from "../util/url.js";

/**
 * Page cache keyed on the canonical URL. This is the single highest-leverage
 * cost control in the project: the same URL is never extracted twice, across
 * runs and across processes.
 */
export class PageCache {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
  ) {}

  get(url: string): FetchedPage | null {
    const key = canonicalizeUrl(url);
    const row = this.db
      .prepare("SELECT url, title, text, fetched_at FROM pages WHERE url = ?")
      .get(key) as
      | { url: string; title: string | null; text: string; fetched_at: number }
      | undefined;

    if (!row) return null;
    if (Date.now() - row.fetched_at > this.ttlMs) return null;

    return {
      url: row.url,
      title: row.title,
      text: row.text,
      fetchedAt: row.fetched_at,
      fromCache: true,
    };
  }

  set(page: FetchedPage): void {
    const key = canonicalizeUrl(page.url);
    this.db
      .prepare(
        `INSERT INTO pages (url, title, text, fetched_at, bytes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           text = excluded.text,
           fetched_at = excluded.fetched_at,
           bytes = excluded.bytes`,
      )
      .run(
        key,
        page.title,
        page.text,
        page.fetchedAt,
        Buffer.byteLength(page.text),
      );
  }

  /** Split a URL list into what we already have and what we must pay for. */
  partition(urls: string[]): { hits: FetchedPage[]; misses: string[] } {
    const hits: FetchedPage[] = [];
    const misses: string[] = [];
    for (const url of urls) {
      const cached = this.get(url);
      if (cached) hits.push(cached);
      else misses.push(url);
    }
    return { hits, misses };
  }
}
