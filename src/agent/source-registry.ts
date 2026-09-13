import type { SearchHit, SourceId, SourceRef } from "../types.js";
import { canonicalizeUrl } from "../util/url.js";

/**
* Gives every URL the run touches a stable short handle (S1, S2, …), so the
* model cites by id and every citation can be checked against what was retrieved.
*/
export class SourceRegistry {
  private readonly byUrl = new Map<string, SourceRef>();
  private counter = 0;

  register(input: {
    url: string;
    title: string;
    score?: number;
    publishedDate?: string;
  }): SourceRef {
    const url = canonicalizeUrl(input.url);
    const existing = this.byUrl.get(url);
    if (existing) {
      if (!existing.title && input.title) existing.title = input.title;
      return existing;
    }

    this.counter += 1;
    const ref: SourceRef = {
      id: `S${this.counter}`,
      url,
      title: input.title || url,
      read: false,
      ...(input.score !== undefined ? { score: input.score } : {}),
      ...(input.publishedDate ? { publishedDate: input.publishedDate } : {}),
    };
    this.byUrl.set(url, ref);
    return ref;
  }

  registerHits(hits: SearchHit[]): SourceRef[] {
    return hits.map((h) => this.register(h));
  }

  markRead(url: string): SourceRef | undefined {
    const ref = this.byUrl.get(canonicalizeUrl(url));
    if (ref) ref.read = true;
    return ref;
  }

  /**
  * The handle a source may be cited by, or null until it has been read.
  *
  * Ids are assigned on discovery so the record can say what was found as well as
  * what was used, but only a source with text behind it gets one handed to the
  * model: an id on a search hit is how a snippet gets cited as evidence.
  */
  citableId(ref: SourceRef): SourceId | null {
    return ref.read ? ref.id : null;
  }

  byId(id: SourceId): SourceRef | undefined {
    for (const ref of this.byUrl.values()) if (ref.id === id) return ref;
    return undefined;
  }

  lookup(url: string): SourceRef | undefined {
    return this.byUrl.get(canonicalizeUrl(url));
  }

  all(): SourceRef[] {
    return [...this.byUrl.values()].sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
  }

  read(): SourceRef[] {
    return this.all().filter((s) => s.read);
  }

  get size(): number {
    return this.byUrl.size;
  }
}
