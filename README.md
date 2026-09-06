# Sonde

A model-backed research and writing tool in TypeScript.

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
npm run dev -- write "Announce the launch" # write a new piece
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

## Writing

`sonde write` is a separate one-turn workflow: it does no retrieval and emits
no citations. See [the decision record](docs/adr/0001-writing-runs-carry-no-citations.md)
for why that boundary is deliberate.

```bash
sonde write "A welcome email for new members" --style business --length 350
sonde write "Finish this article" --mode continue --in draft.md
sonde write "Open up the storm at sea" --mode expand --in draft.md --length 3000
cat draft.md | sonde write "Make this fuller" --mode expand
```

`new` (the default) refuses a draft. `continue` and `expand` require one, read
either from `--in <file>` or from stdin.

`new` and `continue` return a whole finished piece — `continue` gives back the
draft with its continuation, never only the increment. `expand` is the
exception: it returns **the expanded passage alone**. The draft is context it
reads, not output it repeats, so what lands on your screen is the new writing
and nothing else, ready to drop back into the original where you want it.

`expand` is aimed, not blanket, and the brief is read as a list of requirements
rather than a topic — which part to develop, where it starts, what it must now
contain that the draft only implies, how long it runs. All of them bind:

```bash
sonde write "详细展开描写原文中的暴风雨那一段，并额外描写暴风雨中行人艰难在路上行走的样子，从第一次打雷的时间点开始写起，字数 2000 字以上。" \
  --mode expand --in draft.md --style literary --lang Chinese
```

That comes back as the storm passage on its own — opening on the first
thunderclap, carrying the pedestrians struggling along the road — with no
recap of what preceded it in the draft and no writing on past where it ends.

`--length` is a word count in every mode. Under `new` and `continue` it is a
soft target for the whole piece; under `expand` it is a floor for the passage.
When the writing is in Chinese, Japanese, or Korean the count is characters
(`--length 3000` = 3000 字). Omit the flag and the brief decides the length by
itself; where a length in the brief and `--length` disagree, the brief wins.

The count is checked afterwards, not enforced: if the passage lands well under
the floor it was given, the run still returns its prose and says so.

```
! the expanded passage runs to roughly 1,240 words, short of the 2,000 asked for
  — expand the saved file again to develop it further
```

Styles are registers, not author imitations. Each one reaches the writer as a
specification rather than an adjective — the moves that produce the register,
and the failure it falls into:

| Style | Use |
| --- | --- |
| `match` | take the register from the draft (default under `continue` and `expand`) |
| `plain` | direct, clear prose (default under `new`) |
| `literary` | controlled imagery and rhythm |
| `reportage` | scene-led journalistic prose |
| `commentary` | a considered argument |
| `explainer` | progressive explanation |
| `business` | concise, decision-oriented writing |

Leave `--style` off when continuing or expanding: `match` reads the register out
of the draft, and any other choice would show at the seam. Every style also
carries a shared set of house rules against the habits that make prose read as
machine-made, in whatever language it is written.

Every run saves its prose to a timestamped markdown file under
`SONDE_WRITING_DIR` (`.sonde/writing`, gitignored) and prints the path last, so
the next round is a copy and a paste:

```
→ saved to .sonde/writing/20260906-212410-new-run_ab12cd34.md
  sonde write "<what to do next>" --mode continue --in .sonde/writing/20260906-212410-new-run_ab12cd34.md
```

The file holds the prose and nothing else — no brief, no usage line — because
`--in` reads it straight back as the draft. An `expand` run saves what it
produced, which is the passage on its own; the original draft it worked from is
untouched, and merging the two is yours to do. `--out` and `--json` still work
and are unaffected; `--json` also reports the saved path as `savedTo`.

If a provider error, timeout, or interrupt occurs after prose has begun,
Sonde delivers that partial prose with an incomplete marker and exits with code
2. A partial draft can still be useful; unlike a partial research report, it
does not imply unvalidated evidence is safe to rely on.

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
  writing/              one-turn prose: write-agent, prompts, styles
    archive.ts          saves each piece to .sonde/writing/<timestamp>-<mode>-<run id>.md
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
