# Writing runs carry no citations

Sonde began as a research tool whose defining mechanism is that the writer is
shown only the pages the loop actually fetched, so `validateCitations` can drop
any citation whose quote is not in the source text. The writing workflow has no
retrieval and therefore no such constraint, so it emits prose with no source
markers and no citation validation at all — a citation produced without that
mechanism would carry the appearance of having been checked without the fact of
it, which is worse than no citation.

## Consequences

- Writing is a single model turn. It needs neither `tools` nor
  `structured_outputs`, so it streams plain text and, unlike the research
  writer, needs no pinned upstream providers: there is no JSON that can fail to
  parse. `SONDE_WRITER_PROVIDERS` stays scoped to research.
- Budget for a writing run is accounting, not gating. `canRetrieve()` and the
  step and search-credit limits have nothing to act on; only the wall clock and
  an output-token ceiling constrain it, so `stoppedBy` can only ever be
  `complete`, `max_wall_ms`, or `error`.
- The two workflows part company on failure. A truncated report is withheld
  because unvalidated citations mislead; truncated prose is delivered and
  marked incomplete because half a draft is still worth having.
- Sonde's top-level definition had to widen from "a research agent" to a host
  for more than one workflow. Run history is shared, which is the point of that
  widening and also its cost: the `runs` table keeps its research-era column
  names.
