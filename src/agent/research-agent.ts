import { randomUUID } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  generateText,
  Output,
  stepCountIs,
  ToolLoopAgent,
  type LanguageModel,
} from "ai";
import { z } from "zod";

import { loadConfig, type Config } from "../config.js";
import { BudgetTracker } from "../budget/budget.js";
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
    if (event.type !== "run_end") store.event(runId, event.type, event);
    options.onEvent?.(event);
  };

  emit({ type: "run_start", runId, question });

  // `usage: { include: true }` turns on OpenRouter usage accounting — this is
  // what makes the dollar budget real rather than an estimate.
  // To pin or order upstream providers, add:
  //   extraBody: { provider: { order: ['anthropic'], allow_fallbacks: true } }
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

  // The limit that first turned a tool away, if any — one half of the ground
  // truth for "this run was cut short". A refusal is a real event, so it is
  // surfaced rather than left to be inferred from the stop reason.
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

  // The other half. Tools are switched off for the final step so the model can
  // never spend it on a call whose result it will not live to read; that step
  // goes to writing findings instead.
  //
  // Reaching that step is itself evidence the run was truncated: the loop only
  // continues past a step that called a tool, so a model still working one step
  // earlier was not finished. With tools switched off it can no longer say so,
  // which is why the clamp is recorded here rather than inferred from
  // finishReason afterwards.
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

  // Every step's prose is kept as it arrives, and the notes are the whole
  // sequence — not just the last step. When the loop is cut short by a step or
  // budget limit, `result.text` holds only the final step's text, which is
  // typically a sentence about what the model was *about* to do. Relying on it
  // silently threw away every finding from the steps before.
  const stepTexts: string[] = [];

  emit({ type: "phase", phase: "research" });

  try {
    const result = await agent.generate({
      prompt: `Research question: ${question}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      onStepEnd: (event) => {
        budget.countStep();
        budget.addModelUsage(readUsage(event));
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
    // "stop" means the model chose to end; anything else means it was cut off
    // mid-thought and had more it wanted to do.
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

  // What ended the research loop, in order of how conclusive the evidence is:
  // a breached resource limit, then a tool we turned away, then the step limit —
  // which only counts against a model that still had something it wanted to do.
  let stoppedBy: StopReason = loopError
    ? "error"
    : (budget.check() ??
      retrievalCutShortBy ??
      (forcedWrapUp || !finishedNaturally ? "max_steps" : "complete"));

  // ── Synthesis ───────────────────────────────────────────────────────────────
  // Deliberately a separate call. The writer sees the notes plus the actual text
  // of every page that was read — the text is what makes "quote your source" a
  // checkable instruction rather than an invitation to paraphrase a headline.
  const evidence = collectEvidence(registry.read(), cache);
  let report: ResearchReport | null = null;

  // The writer runs inside the same wall-clock budget as everything else. It
  // used to run outside it: the loop would gather right up to the deadline and
  // the report would then push the run past a limit it had already reported
  // staying inside. Retrieval now stops with time in reserve, and the call
  // below is capped at whatever of that reserve is actually left.
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

    try {
      const synthesis = await generateText({
        model: writerModel,
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

      budget.addModelUsage(readUsage(synthesis));

      const validated = validateCitations(
        synthesis.output,
        registry,
        evidence,
      );
      report = validated.report;
      for (const w of validated.warnings) warn(w);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outOfTime = deadline.aborted && !options.signal?.aborted;
      warn(
        outOfTime
          ? `synthesis ran out of wall-clock budget after ${(deadlineMs / 1000).toFixed(1)}s and was aborted — no report was written`
          : `synthesis failed: ${message}`,
      );
    }
  }

  // The record must agree with itself. The writer's own spend can push a run
  // that stayed inside every limit over one of them, and a run that reports
  // "complete" while its snapshot shows a breached limit is a run whose budget
  // means nothing.
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
 * Provider settings for the writer.
 *
 * The writer transcribes and quote-checks; it does not deliberate. Left to the
 * provider's default, one run spent 22,301 reasoning tokens to produce 2,469
 * tokens of report — eight minutes and five times the cost of an identical
 * result. Runs that happened to emit no reasoning at all still matched every
 * quote exactly, so a cap here has no observed downside. Set
 * SONDE_WRITER_REASONING_EFFORT=default to hand the decision back.
 */
export function writerModelSettings(config: Config): {
  usage: { include: true };
  reasoning?: { effort: Exclude<Config["writerReasoningEffort"], "default"> };
} {
  const effort = config.writerReasoningEffort;
  return {
    usage: { include: true },
    ...(effort === "default" ? {} : { reasoning: { effort } }),
  };
}

/** Pulls token counts and — when OpenRouter reports it — real dollars. */
function readUsage(source: unknown): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const s = source as {
    usage?: { inputTokens?: number; outputTokens?: number };
    totalUsage?: { inputTokens?: number; outputTokens?: number };
    providerMetadata?: Record<string, unknown>;
  };

  const usage = s.totalUsage ?? s.usage ?? {};
  const openrouter = s.providerMetadata?.["openrouter"] as
    | { usage?: { cost?: number; totalCost?: number } }
    | undefined;

  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: openrouter?.usage?.cost ?? openrouter?.usage?.totalCost ?? 0,
  };
}

/** Per-source and total character caps on the evidence handed to the writer. */
const MAX_EVIDENCE_CHARS_PER_SOURCE = 6_000;
const MAX_EVIDENCE_CHARS_TOTAL = 40_000;

/**
 * Pairs every source that was read with the page text behind it, sharing the
 * character budget out fairly so one long page cannot crowd the others out.
 *
 * A source whose text we cannot produce is dropped rather than listed: offering
 * the writer an id it has no text for is exactly how unquotable citations get
 * written in the first place.
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
