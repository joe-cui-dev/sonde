# Sonde

A web research agent in TypeScript.

- **Orchestration** — Vercel AI SDK v7 (`ToolLoopAgent`)
- **Reasoning** — OpenRouter, via `@openrouter/ai-sdk-provider`
- **Retrieval** — Tavily (`search` + `extract`), behind swappable interfaces
- **State** — SQLite via `node:sqlite` (built into Node 22, no dependency)

## Quick start

```bash
npm install
cp .env.example .env     # then put real keys in .env
npm run dev -- doctor    # verify keys and models before spending anything
npm run research "What changed in the EU AI Act's GPAI obligations in 2026?"
```

Other commands:

```bash
npm run research "…" -- --out report.md   # write markdown to a file
npm run research "…" -- --json            # full result as JSON
npm run dev -- runs                       # list past runs with what each cost
npm run dev -- doctor                     # preflight: keys, model slugs, credit left
npm run build && npm start research "…"   # compiled
```

`doctor` is worth running after any change to `.env`. It checks the key is
accepted, that both model slugs exist on OpenRouter, and — the part that is easy
to get wrong — that the planner supports `tools` and the writer supports
`structured_outputs`. A model missing either only fails once a run is already
underway and retrieval has been paid for.

## How a run works

```
question
   │
   ├─ research loop (ToolLoopAgent, planner model)
   │     web_search  → ranked hits, snippets only, sources get ids S1…Sn
   │     read_pages  → full cleaned text; cache-first, so a URL is paid for once
   │     …repeats until the model is satisfied or a budget gate trips
   │
   └─ synthesis (separate call, writer model)
         sees only the notes + the pages actually READ
         emits a structured report whose citations are then verified
         against the source registry — unknown ids are dropped, not trusted
```

Two calls, not one, on purpose: the writer cannot cite a page the loop never
fetched, because it is never shown one. `validateCitations` enforces that
mechanically and records a warning for every citation it drops.

## Layout

```
src/
  agent/
    research-agent.ts   runResearch() — the two-phase loop above
    prompts.ts          research instructions + synthesis prompt
    source-registry.ts  URL → stable S1/S2 handles, tracks what was read
  providers/
    types.ts            SearchProvider / ContentFetcher — the swap seam
    tavily.ts           Tavily implements both halves
    index.ts            provider selection (one switch)
  tools/index.ts        web_search, read_pages (budget-aware)
  budget/budget.ts      steps · tokens · dollars · credits · wall time
  store/                sqlite: page cache, run records, event trace
  telemetry/index.ts    AI SDK telemetry integration → sqlite
  util/url.ts           canonicalization + dedupe
  preflight.ts          doctor: key, model capability and credit checks
  cli.ts                sonde research / sonde runs / sonde doctor
```

## Budget gates

A run stops at the first limit it reaches and still produces a report from what
it gathered. Configure in `.env`:

| Variable                   | Default | Guards against       |
| -------------------------- | ------- | -------------------- |
| `SONDE_MAX_STEPS`          | 16      | infinite tool loops  |
| `SONDE_MAX_USD`            | 1.00    | runaway model spend  |
| `SONDE_MAX_TOKENS`         | 400000  | context/token blowup |
| `SONDE_MAX_SEARCH_CREDITS` | 60      | Tavily credit burn   |
| `SONDE_MAX_WALL_MS`        | 300000  | hung runs            |

Dollars are real, not estimated: the OpenRouter models are created with
`usage: { include: true }`, so each response carries its actual cost.

`BudgetTracker.canRetrieve()` is deliberately stricter than `exhausted` — it
reserves ~15% headroom so the writer can still produce a report after the loop
stops gathering. When it returns false the tools refuse politely and tell the
model to conclude, rather than throwing mid-loop.

## Swapping providers

Search and extraction are separate interfaces because they are separate jobs.
To put Brave in front of search while keeping Tavily for extraction, implement
`SearchProvider` and return it from `createRetrieval`:

```ts
return { searcher: new BraveProvider({ apiKey }), fetcher: tavily };
```

Nothing else in the codebase changes — the tools depend on the interfaces, not
on Tavily.

## Observability

Every model call, step and tool execution is written to `run_events` in SQLite,
tagged by run and phase. `sonde runs` lists what each run cost.

The trace comes from AI SDK v7's native telemetry integration interface
(`src/telemetry/index.ts`), passed per call rather than registered globally. To
add Langfuse or Braintrust, put their integration alongside this one in the
`integrations` array — no other change.

## Testing without spending money

```bash
npm test                       # run Jest unit tests
npm test -- --watch             # rerun affected tests while editing
npm test -- --coverage          # write coverage reports to coverage/
npm run typecheck              # check source and test types
```

Tests live in `tests/**/*.test.ts` and run without API keys or network calls.
They cover URL handling, source registration, budget limits, config parsing, the
`read_pages` character allocator, and a scripted end-to-end `runResearch` — search,
read, notes, synthesis, citation validation and sqlite persistence — driven by a
mock model. `tests/helpers/mock.ts` holds the step builders (`calls`, `says`,
`scriptedModel`) and a fake `Retrieval`. Jest uses ts-jest's
[ESM preset](https://kulshekhar.github.io/ts-jest/docs/guides/esm-support)
to match the project's NodeNext modules. Import test helpers from `@jest/globals`
and keep `.js` extensions on relative source imports, as in the application.

`runResearch` accepts injection seams:

```ts
await runResearch({
  question: "…",
  models: { planner: mockModel, writer: mockModel }, // ai/test → MockLanguageModelV4
  retrieval: { searcher: stub, fetcher: stub },
});
```

Note the v4 model spec nests both fields: `finishReason: { unified: 'tool-calls' }`
and `usage: { inputTokens: { total: n }, outputTokens: { total: n } }`.

## Streaming synthesis previews

During synthesis, an interactive terminal shows a transient report preview on
stderr. It is labelled as in progress and unvalidated; only the complete,
schema- and citation-validated report is written to stdout or `--out`. `--json`,
`--out`, pipes, and `--quiet` keep stdout machine-readable. If synthesis or
final delivery fails, any preview text already shown remains visible and is
marked incomplete rather than being presented as a final report.

Library consumers can observe transient `{ type: "report_preview" }` events
through `RunResearchOptions.onEvent`. These events are not stored in SQLite and
are not replayable run history.

## Not built yet

Deliberately out of scope for this skeleton, roughly in order of value:

- **Eval set** — fixture questions + a scoring script, so prompt changes can be
  judged rather than guessed at.
- **Rerank before context** — right now `read_pages` truncates at 8k chars per
  page. Chunking and reranking against the sub-question would spend context far
  better.
- **Query planning as an explicit step** — currently the model decomposes in its
  head; making it a structured artifact makes it inspectable and cacheable.
- **Parallel reads** — `read_pages` fetches a batch, but the loop is serial.
- **HTTP surface** — the library/CLI split is already there; a Hono `/research`
  endpoint with SSE is a thin layer over `runResearch`.

## Notes

- Model slugs in `.env.example` are starting points — verify current ids and
  prices at <https://openrouter.ai/models>.
- For production, pin upstream providers rather than letting OpenRouter route
  freely; see the `extraBody: { provider: … }` comment in `research-agent.ts`.
- `node:sqlite` prints an experimental warning on Node 22; the npm scripts pass
  `--disable-warning=ExperimentalWarning`.
