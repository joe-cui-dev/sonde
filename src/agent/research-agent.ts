import { randomUUID } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  generateText,
  Output,
  stepCountIs,
  streamText,
  ToolLoopAgent,
  type LanguageModel,
} from "ai";
import { z } from "zod";

import { loadConfig, type Config } from "../config.js";
import { BudgetTracker, readModelUsage } from "../budget/budget.js";
import { createRetrieval, type Retrieval } from "../providers/index.js";
import { openDb } from "../store/db.js";
import { PageCache } from "../store/cache.js";
import { RunStore } from "../store/runs.js";
import { createRunTelemetry } from "../telemetry/index.js";
import { allocateChars, createTools } from "../tools/index.js";
import { SourceRegistry } from "./source-registry.js";
import { validateCitations } from "./citations.js";
import { RESEARCH_INSTRUCTIONS, synthesisPrompt } from "./prompts.js";
import { createLogger } from "../util/log.js";
import type {
  BudgetLimits,
  EventSink,
  ResearchReport,
  ResearchResult,
  ReportPreview,
  RunEvent,
  SourceEvidence,
  SourceRef,
  StopReason,
} from "../types.js";

const ReportSchema = z.object({
  summary: z
    .string()
    .describe("Two to four sentences answering the question directly."),
  report: z
    .string()
    .describe(
      "Markdown. Every factual claim carries an inline source marker like [S3].",
    ),
  citations: z
    .array(
      z.object({
        id: z
          .string()
          .describe('A source id from the supplied list, e.g. "S3".'),
        url: z.string(),
        title: z.string(),
        quote: z
          .string()
          .describe(
            "Short span copied verbatim from that source's text. Checked " +
              "against the source; a quote that is not found there is dropped.",
          ),
      }),
    )
    .describe("One entry per source id used in the report."),
  confidence: z.enum(["low", "medium", "high"]),
  openQuestions: z
    .array(z.string())
    .describe("What the evidence did not settle."),
});

export interface RunResearchOptions {
  question: string;
  config?: Config;
  limits?: Partial<BudgetLimits>;
  onEvent?: EventSink;
  signal?: AbortSignal;
  runId?: string;
  /**
   * Injection seams. Supplying either bypasses the OpenRouter/Tavily clients
   * entirely, which is how evals and offline tests run without spending money.
   */
  models?: { planner?: LanguageModel; writer?: LanguageModel };
  retrieval?: Retrieval;
}

export async function runResearch(
  options: RunResearchOptions,
): Promise<ResearchResult> {
  const config = options.config ?? loadConfig();
  const logger = createLogger(config.logLevel);
  const question = options.question.trim();

  const limits: BudgetLimits = {
    maxSteps: config.maxSteps,
    maxUsd: config.maxUsd,
    maxTokens: config.maxTokens,
    maxSearchCredits: config.maxSearchCredits,
    maxWallMs: config.maxWallMs,
    ...options.limits,
  };

  const runId = options.runId ?? `run_${randomUUID().slice(0, 8)}`;
  const budget = new BudgetTracker(limits);
  const registry = new SourceRegistry();

  const db = openDb(config.dbPath);
  const store = new RunStore(db);
  const cache = new PageCache(db, config.cacheTtlHours * 3_600_000);
  store.start(runId, question);

  const emit: EventSink = (event: RunEvent) => {
    // Previews are transient: useful live, but unvalidated, so replaying them
    // from SQLite would make them look like durable run facts.
    if (event.type !== "run_end" && event.type !== "report_preview") {
      store.event(runId, event.type, event);
    }
    options.onEvent?.(event);
  };

  emit({ type: "run_start", runId, question });

  // `usage: { include: true }` turns on OpenRouter usage accounting, which is
  // what makes the dollar budget real rather than an estimate.
  const openrouter =
    options.models?.planner && options.models?.writer
      ? null
      : createOpenRouter({
          apiKey: config.openrouterApiKey,
          headers: {
            "HTTP-Referer": config.appUrl,
            "X-Title": config.appTitle,
          },
        });

  const plannerModel =
    options.models?.planner ??
    openrouter!(config.plannerModel, { usage: { include: true } });
  const writerModel =
    options.models?.writer ??
    openrouter!(config.writerModel, writerModelSettings(config));

  const warnings: string[] = [];

  /** Records a warning once, both for the caller and for the event stream. */
  const warn = (message: string): void => {
    warnings.push(message);
    emit({ type: "warning", message });
  };

  // The limit that first turned a tool away — half the ground truth for "cut
  // short", and a real event rather than something to infer from a stop reason.
  let retrievalCutShortBy: StopReason | null = null;

  const tools = createTools({
    retrieval: options.retrieval ?? createRetrieval(config),
    registry,
    cache,
    budget,
    emit,
    onSource: () => {},
    onRefusal: (reason) => {
      if (retrievalCutShortBy) return;
      retrievalCutShortBy = reason;
      warn(
        `retrieval was cut short by ${reason} — the report was written from what had already been gathered`,
      );
    },
  });

  // The other half. Tools are off for the final step so it cannot be spent on a
  // call whose result the model will never read; it writes findings instead.
  // Reaching that step is itself evidence of truncation — the loop only continues
  // past a step that called a tool — but with tools off the model can no longer
  // say so, hence recording the clamp rather than reading finishReason.
  let forcedWrapUp = false;

  const agent = new ToolLoopAgent({
    id: "sonde-research",
    model: plannerModel,
    instructions: RESEARCH_INSTRUCTIONS,
    tools,
    toolChoice: "auto",
    stopWhen: [stepCountIs(limits.maxSteps), () => budget.exhausted],
    prepareStep: ({ stepNumber }) => {
      if (stepNumber < limits.maxSteps - 1) return {};
      if (!forcedWrapUp) {
        forcedWrapUp = true;
        warn(
          `hit the ${limits.maxSteps}-step limit while still gathering — the last step was reserved for writing findings`,
        );
      }
      return { toolChoice: "none" };
    },
    telemetry: {
      functionId: "sonde.research",
      integrations: [createRunTelemetry({ store, runId, phase: "research" })],
    },
  });

  let loopError: string | null = null;
  let finishedNaturally = false;
  let notes = "";

  // The notes are every step's prose, not just the last. On a loop cut short,
  // `result.text` holds only the final step — typically a sentence about what
  // the model was *about* to do — and using it threw away every earlier finding.
  const stepTexts: string[] = [];

  emit({ type: "phase", phase: "research" });

  try {
    const result = await agent.generate({
      prompt: `Research question: ${question}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      onStepEnd: (event) => {
        budget.countStep();
        budget.addModelUsage(readModelUsage(event));
        const text = typeof event.text === "string" ? event.text.trim() : "";
        if (text) stepTexts.push(text);
        emit({
          type: "step",
          step: budget.snapshot().steps,
          text,
          snapshot: budget.snapshot(),
        });
      },
    });
    // "stop" means the model chose to end; anything else means it was cut off.
    finishedNaturally = result.finishReason === "stop";
    const finalText = result.text?.trim() ?? "";
    if (finalText && stepTexts.at(-1) !== finalText) stepTexts.push(finalText);
    notes = stepTexts.join("\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loopError = message;
    notes = stepTexts.join("\n\n");
    warn(
      notes
        ? `research loop failed after ${stepTexts.length} step(s), synthesising from partial notes: ${message}`
        : `research loop failed before producing any notes: ${message}`,
    );
    logger.error(message);
  }

  // What ended the loop, most conclusive evidence first: a breached resource
  // limit, then a refused tool, then the step limit — which only counts against
  // a model that still had something it wanted to do.
  let stoppedBy: StopReason = loopError
    ? "error"
    : (budget.check() ??
      retrievalCutShortBy ??
      (forcedWrapUp || !finishedNaturally ? "max_steps" : "complete"));

  // ── Synthesis ───────────────────────────────────────────────────────────────
  // A separate call, seeing the notes plus the actual text of every page read.
  // The text is what makes "quote your source" checkable.
  const evidence = collectEvidence(registry.read(), cache);
  let report: ResearchReport | null = null;

  // The writer runs inside the same wall-clock budget as everything else:
  // retrieval stops with time in reserve, and this call is capped at what is
  // left of it. Otherwise the report pushes the run past a limit it already
  // reported staying inside.
  const deadlineMs = budget.remainingWallMs;

  if (notes.trim().length === 0 && evidence.length === 0) {
    // Nothing to say and nothing to say it from — fall through.
  } else if (evidence.length === 0) {
    warn(
      "No source was successfully read — nothing to cite, so no report was written.",
    );
  } else if (deadlineMs <= 0) {
    warn(
      `No time left in the ${(limits.maxWallMs / 1000).toFixed(0)}s wall-clock budget to write the report — the notes and sources below are what the run gathered.`,
    );
  } else if (notes.trim().length > 0) {
    emit({ type: "phase", phase: "synthesis" });
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;

    // A provider error (an upstream 429, say) arrives as an `error` part that
    // `partialOutputStream` drops. Uncaught, the empty text it hands back is then
    // reported as a parse failure, naming the wrong cause.
    let streamError: unknown;

    try {
      const synthesis = streamText({
        model: writerModel,
        onError: ({ error }) => {
          streamError ??= error;
        },
        output: Output.object({ schema: ReportSchema }),
        prompt: synthesisPrompt({
          question,
          notes,
          evidence,
          degraded: stoppedBy !== "complete",
        }),
        abortSignal: signal,
        telemetry: {
          functionId: "sonde.synthesis",
          integrations: [
            createRunTelemetry({ store, runId, phase: "synthesis" }),
          ],
        },
      });

      let usageRecorded = false;
      const settleTerminalResults = async () => {
        const [output, usage, providerMetadata] = await Promise.allSettled([
          synthesis.output,
          synthesis.usage,
          synthesis.providerMetadata,
        ]);
        if (!usageRecorded && usage.status === "fulfilled") {
          usageRecorded = true;
          budget.addModelUsage(
            readModelUsage({
              usage: usage.value,
              providerMetadata:
                providerMetadata.status === "fulfilled"
                  ? providerMetadata.value
                  : undefined,
            }),
          );
        }
        if (output.status === "rejected") throw output.reason;
        return output.value;
      };

      let output: ResearchReport;
      try {
        // Parsed, cumulative snapshots. Do not derive this from text deltas: the
        // raw JSON is temporarily invalid mid-string.
        for await (const partial of synthesis.partialOutputStream) {
          const preview = previewFromPartial(partial);
          if (preview) emit({ type: "report_preview", preview });
        }
        output = await settleTerminalResults();
      } catch (error) {
        // Consume terminal promises even after a stream error. This both avoids
        // unhandled rejections and records any usage the provider did return.
        try {
          await settleTerminalResults();
        } catch {
          // The original stream error is generally the clearest failure cause.
        }
        throw streamError ?? error;
      }

      const validated = validateCitations(output, registry, evidence);
      for (const w of validated.warnings) warn(w);
      if (validated.valid) {
        report = validated.report;
      } else {
        warn(
          "synthesis output failed citation validation — no report was written",
        );
      }
    } catch (error) {
      const message = describeSynthesisFailure(error);
      const outOfTime = deadline.aborted && !options.signal?.aborted;
      warn(
        outOfTime
          ? `synthesis ran out of wall-clock budget after ${(deadlineMs / 1000).toFixed(1)}s and was aborted — no report was written`
          : `synthesis failed: ${message}`,
      );
    }
  }

  // The record must agree with itself: the writer's own spend can push a run
  // that stayed inside every limit over one, and "complete" beside a breached
  // snapshot is a budget that means nothing.
  if (stoppedBy === "complete") stoppedBy = budget.check() ?? "complete";

  for (const source of registry.all()) store.saveSource(runId, source);

  const usage = budget.snapshot();
  const result: ResearchResult = {
    runId,
    question,
    report,
    notes,
    sources: registry.all(),
    usage,
    stoppedBy,
    warnings,
  };

  store.finish(runId, stoppedBy, usage, report);
  emit({ type: "run_end", result });
  db.close();

  return result;
}

/**
* Explains a failed synthesis in terms of what the writer actually returned.
*
* `NoObjectGeneratedError` says only that the text would not parse — the same
* sentence whether the provider streamed nothing, prose, or JSON wrapped in
* another JSON string. Since OpenRouter's upstreams do not all honour the
* schema alike, the returned text is the evidence of which happened.
*/
function describeSynthesisFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = (error as { text?: unknown }).text;
  if (typeof text !== "string") return message;
  return text.trim().length === 0
    ? `${message} The writer returned no text.`
    : `${message} The writer returned ${text.length} characters starting ${JSON.stringify(text.slice(0, 120))}`;
}

/** Pull the readable report fields out of a schema-derived partial snapshot. */
function previewFromPartial(partial: unknown): ReportPreview | null {
  if (!partial || typeof partial !== "object") return null;
  const candidate = partial as Record<string, unknown>;
  const preview: ReportPreview = {};
  if (typeof candidate["summary"] === "string") {
    preview.summary = candidate["summary"];
  }
  if (typeof candidate["report"] === "string") {
    preview.report = candidate["report"];
  }
  return preview.summary !== undefined || preview.report !== undefined
    ? preview
    : null;
}

/**
* Provider settings for the writer.
*
* The writer transcribes and quote-checks; it does not deliberate. Left to the
* provider's default, one run spent 22,301 reasoning tokens on a 2,469-token
* report — eight minutes and five times the cost of an identical result — while
* runs that emitted no reasoning still matched every quote. Set
* SONDE_WRITER_REASONING_EFFORT=default to hand the decision back.
*
* Routing is pinned for a related reason: the writer is the one call whose
* output has to parse, and OpenRouter's upstreams do not all honour the schema
* when streaming. `allow_fallbacks` is off because a fallback past the list is
* a fallback to text no downstream handling can turn back into a report.
*/
export function writerModelSettings(config: Config): {
  usage: { include: true };
  reasoning?: { effort: Exclude<Config["writerReasoningEffort"], "default"> };
  extraBody?: { provider: { order: string[]; allow_fallbacks: false } };
} {
  const effort = config.writerReasoningEffort;
  return {
    usage: { include: true },
    ...(effort === "default" ? {} : { reasoning: { effort } }),
    ...(config.writerProviders.length === 0
      ? {}
      : {
          extraBody: {
            provider: {
              order: config.writerProviders,
              allow_fallbacks: false as const,
            },
          },
        }),
  };
}

/** Per-source and total character caps on the evidence handed to the writer. */
const MAX_EVIDENCE_CHARS_PER_SOURCE = 6_000;
const MAX_EVIDENCE_CHARS_TOTAL = 40_000;

/**
* Pairs every source read with the page text behind it, sharing the character
* budget fairly so one long page cannot crowd the others out. A source with no
* text is dropped: an id with nothing behind it is how unquotable citations
* get written.
*/
function collectEvidence(
  sources: SourceRef[],
  cache: PageCache,
): SourceEvidence[] {
  const texts = sources.map((ref) => cache.get(ref.url)?.text ?? "");
  const allowances = allocateChars(
    texts.map((text) => text.length),
    MAX_EVIDENCE_CHARS_TOTAL,
    MAX_EVIDENCE_CHARS_PER_SOURCE,
  );

  const evidence: SourceEvidence[] = [];
  sources.forEach((ref, index) => {
    const excerpt = (texts[index] ?? "").slice(0, allowances[index] ?? 0);
    if (excerpt.length > 0) evidence.push({ ref, excerpt });
  });
  return evidence;
}
