import { randomUUID } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, type LanguageModel } from "ai";
import { BudgetTracker, readModelUsage } from "../budget/budget.js";
import { loadConfig, type Config } from "../config.js";
import { openDb } from "../store/db.js";
import { RunStore } from "../store/runs.js";
import type {
  BudgetLimits,
  StopReason,
  WriteEvent,
  WriteEventSink,
  WriteMode,
  WriteResult,
  WriteStyleId,
} from "../types.js";
import { assertFieldLimit, hashCharactersFile, loadCharacters, requireCharacter } from "./character-file.js";
import { countWords } from "./length.js";
import { writePrompt } from "./prompts.js";
import { loadStyles, requireStyle } from "./style-file.js";
import { defaultStyle } from "./styles.js";

export interface RunWriteOptions {
  brief: string;
  draft?: string;
  mode?: WriteMode;
  style?: WriteStyleId;
  /** Ids from the project's characters file (SONDE_CHARACTERS_FILE), each one a `--character`. */
  characters?: string[];
  language?: string;
  length?: number;
  config?: Config;
  limits?: Partial<BudgetLimits>;
  onEvent?: WriteEventSink;
  /** Observe the exact application-level prompt that will be handed to the model. */
  onPrompt?: (prompt: string) => void;
  signal?: AbortSignal;
  runId?: string;
  /**
   * Test seam for the OpenRouter model. A function is called once per attempt
   * with that attempt's reasoning effort — the only way to observe the
   * reasoning retry, since effort is fixed when a model is constructed. A bare
   * model is reused as given.
   */
  model?:
    | LanguageModel
    | ((effort: Config["writeReasoningEffort"]) => LanguageModel);
}

export async function runWrite(options: RunWriteOptions): Promise<WriteResult> {
  const config = options.config ?? loadConfig();
  const brief = options.brief.trim();
  const mode = options.mode ?? "new";
  const style = options.style ?? defaultStyle(mode);
  // Resolved before anything is opened, spent, or recorded: an unknown style is
  // a typo in the command and should fail here, not past a paid model call. No
  // style at all is not a typo — the prompt then goes out without a register.
  const spec = style === undefined
    ? undefined
    : requireStyle(loadStyles(config.stylesPath), style);
  // Characters, same point and same reason: an unknown id or an over-limit cast
  // is a mistake in the command, not something to discover after paying.
  const characterIds = options.characters ?? [];
  if (characterIds.length > config.maxCharacterCards) {
    throw new Error(
      `--character was given ${characterIds.length} names; at most ${config.maxCharacterCards} ` +
        "may be injected into one run (SONDE_MAX_CHARACTER_CARDS).",
    );
  }
  const catalogue = loadCharacters(config.charactersPath, config.maxCharactersFileBytes);
  const characters = characterIds.map((id) => requireCharacter(catalogue, id));
  for (const card of characters) assertFieldLimit(card, config.maxCharacterFieldChars);
  // Built once so the preview cannot drift from the request it claims to show.
  const prompt = writePrompt({
    brief, draft: options.draft, mode, style: spec, characters,
    language: options.language, length: options.length,
  });
  options.onPrompt?.(prompt);
  const limits: BudgetLimits = {
    maxSteps: config.maxSteps, maxUsd: config.maxUsd,
    maxTokens: config.maxTokens, maxSearchCredits: config.maxSearchCredits,
    maxWallMs: config.maxWallMs, ...options.limits,
  };
  const runId = options.runId ?? `run_${randomUUID().slice(0, 8)}`;
  const budget = new BudgetTracker(limits);
  const db = openDb(config.dbPath);
  const store = new RunStore(db);
  store.start(runId, brief, "writing");
  const emit = (event: WriteEvent) => {
    // Deltas are live output; finishWrite persists the prose once. Reasoning is
    // never persisted — run history records what was written, not the thinking.
    const transient =
      event.type === "write_end" || event.type === "text_delta" || event.type === "reasoning_delta";
    if (!transient) store.event(runId, event.type, event);
    options.onEvent?.(event);
  };
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    emit({ type: "warning", message });
  };
  emit({
    type: "write_start",
    runId,
    brief,
    mode,
    // Only present when characters were actually injected.
    ...(characters.length
      ? { characters: characters.map((card) => card.name), charactersHash: hashCharactersFile(config.charactersPath) }
      : {}),
  });
  const supplied = options.model;
  const openrouter = supplied ? null : createOpenRouter({
    apiKey: config.openrouterApiKey,
    headers: { "HTTP-Referer": config.appUrl, "X-Title": config.appTitle },
  });
  const effort = config.writeReasoningEffort;
  // Effort is fixed at construction, so a different effort needs a new model.
  const modelFor = (attemptEffort: Config["writeReasoningEffort"]): LanguageModel =>
    typeof supplied === "function"
      ? supplied(attemptEffort)
      : supplied ?? openrouter!(config.writeModel, {
          usage: { include: true },
          ...(attemptEffort === "default" ? {} : { reasoning: { effort: attemptEffort } }),
        });
  // One ceiling for the whole run: recomputing it for the reasoning-free retry
  // would take back the room that retry exists to give the prose.
  const maxOutputTokens = outputTokenLimit(options.length, mode, options.draft, effort);
  const timeout = AbortSignal.timeout(limits.maxWallMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let text = "";
  let stoppedBy: StopReason = "complete";
  /**
   * One model turn: streams it, bills it, reports how it ended. Prose
   * accumulates into `text`, so a throw still leaves what was streamed.
   */
  const attempt = async (attemptEffort: Config["writeReasoningEffort"]) => {
    let streamError: unknown;
    const result = streamText({
      model: modelFor(attemptEffort),
      prompt,
      maxOutputTokens,
      abortSignal: signal,
      onError: ({ error }) => { streamError ??= error; },
    });
    // The full stream, not textStream: reasoning parts arrive only here, and
    // they are the only trustworthy signal of work before any prose exists.
    // Their text is forwarded live and never accumulated into `text`.
    let thinkingEmitted = false;
    let writingEmitted = false;
    for await (const part of result.stream) {
      if (part.type === "reasoning-start" || (part.type === "reasoning-delta" && part.text !== "")) {
        if (!thinkingEmitted) { thinkingEmitted = true; emit({ type: "write_phase", phase: "thinking" }); }
        if (part.type === "reasoning-delta") emit({ type: "reasoning_delta", delta: part.text });
      } else if (part.type === "text-delta" && part.text !== "") {
        if (!writingEmitted) { writingEmitted = true; emit({ type: "write_phase", phase: "writing" }); }
        text += part.text;
        emit({ type: "text_delta", delta: part.text });
      }
    }
    const [usage, metadata, finishReason, rawFinishReason] = await Promise.all([
      result.usage,
      result.providerMetadata,
      result.finishReason,
      result.rawFinishReason,
    ]);
    budget.countStep();
    budget.addModelUsage(readModelUsage({ usage, providerMetadata: metadata }));
    if (streamError) throw streamError;
    if (timeout.aborted || options.signal?.aborted) throw signal.reason;
    return {
      finishReason,
      detail: rawFinishReason && rawFinishReason !== finishReason
        ? `${finishReason}; provider: ${rawFinishReason}`
        : finishReason,
    };
  };
  try {
    let outcome = await attempt(effort);
    // No prose at all, and the ceiling is why: the whole completion went on
    // thinking. Raising the headroom cannot close that tail, only move it;
    // taking reasoning out of the request can, and the run has already been
    // paid for with nothing to show. Deliberately narrow: partial prose is
    // delivered as what it is, and a non-`length` finish means the model
    // stopped for its own reason, which a repeat would only buy again.
    const spentCeilingOnThinking =
      text.trim() === "" && outcome.finishReason === "length";
    if (spentCeilingOnThinking && effort !== "none" && !budget.exhausted) {
      warn(
        "the model spent the whole output ceiling on reasoning and wrote nothing " +
          `(finish reason: ${outcome.detail}); retrying once with reasoning off`,
      );
      outcome = await attempt("none");
    }
    // A provider may burn the whole completion on reasoning and still end the
    // stream cleanly. Transport success is not a completed writing run.
    if (text.trim() === "") {
      text = "";
      throw new Error(
        outcome.finishReason === "length"
          ? `model returned no prose before reaching the output token limit (finish reason: ${outcome.detail})`
          : `model returned no prose (finish reason: ${outcome.detail})`,
      );
    }
    // What streamed is still useful, but a length finish means partial prose.
    if (outcome.finishReason === "length") {
      throw new Error(
        `model reached the output token limit (finish reason: ${outcome.detail})`,
      );
    }
  } catch (error) {
    stoppedBy = timeout.aborted && !options.signal?.aborted ? "max_wall_ms" : "error";
    const detail = error instanceof Error ? error.message : String(error);
    warn(`${stoppedBy === "max_wall_ms" ? "writing ran out of wall-clock budget" : "writing failed"}: ${detail}`);
  }
  const complete = stoppedBy === "complete";
  // Every mode given a count, not only expand: a count is the one requirement a
  // run can check against its own output. Under continue the measure is the
  // whole returned text — the draft carried back plus what was added.
  if (complete && options.length) {
    const written = countWords(text);
    if (written < options.length * shortfallTolerance(mode)) {
      warn(shortfall(mode, written, options.length));
    }
  }
  const result: WriteResult = {
    runId, mode, brief, text: text || null, complete, style: style ?? null,
    usage: budget.snapshot(), stoppedBy, warnings,
  };
  store.finishWrite(runId, stoppedBy, result.usage, result.text);
  emit({ type: "write_end", result });
  db.close();
  return result;
}

const DEFAULT_LENGTH = 800;

/** The count is an estimate, so only a miss wide enough to be real is worth reporting. */
const SHORTFALL_TOLERANCE = 0.9;

/**
 * Under new and continue the count is a soft target, so only order-of-magnitude
 * misses are worth naming — a piece that stopped in its first paragraph, or a
 * model that declined the brief. A warning that is noise is one nobody reads.
 */
const SOFT_TARGET_TOLERANCE = 0.5;

function shortfallTolerance(mode: WriteMode): number {
  return mode === "expand" ? SHORTFALL_TOLERANCE : SOFT_TARGET_TOLERANCE;
}

/**
 * Reports the count and nothing more. A short return has several causes the
 * count cannot tell apart, and naming one would be a guess dressed as a finding.
 */
function shortfall(mode: WriteMode, written: number, length: number): string {
  const measured =
    `runs to roughly ${written.toLocaleString()} words, ` +
    `short of the ${length.toLocaleString()} asked for`;
  return mode === "expand"
    ? `the expanded passage ${measured} — expand the saved file again to develop it further`
    : `the piece ${measured} — check what came back before building on it`;
}

/**
 * A ceiling that stops a runaway, not a target, so the estimate leans high:
 * two tokens per word covers CJK, where a "word" is a character costing ~a token.
 */
const TOKENS_PER_WORD = 2;

/**
 * Tokens of thinking to leave room for above the prose allowance, at each
 * normalized effort.
 *
 * A flat overhead, not a share of the ceiling. Measured against
 * deepseek/deepseek-v4.1-flash at `low`, thinking spent the whole of a 2,000
 * and 4,000 ceiling cut off mid-thought, but only 422–3,515 tokens when given
 * 6,000 or more: past ~5k the ceiling stops sizing the thinking and what is
 * left is the model's own appetite. Deriving it from the prose allowance also
 * shrank the reservation as the request shrank, which is backwards — at
 * `--length 600` that put the whole ceiling at 1,500 tokens and six of ten
 * paid attempts returned no prose at all.
 *
 * So the figures sit well clear of that appetite. Unspent headroom costs
 * nothing; headroom that runs out costs the run. They stop short of the tens
 * of thousands because a ceiling above a model's own completion limit is a
 * request some providers refuse outright. `default` is provider-owned and
 * unknowable, so it reserves what Sonde's own writing default (medium) does.
 */
const REASONING_HEADROOM_TOKENS: Record<
  Config["writeReasoningEffort"],
  number
> = {
  none: 0,
  minimal: 4_096,
  low: 8_192,
  medium: 16_384,
  high: 24_576,
  xhigh: 32_768,
  default: 16_384,
};

/**
 * Continue hands the draft back inside the finished piece, so its ceiling has
 * to pay for the draft as well as for the new prose. New and expand both return
 * new writing only.
 */
function outputTokenLimit(
  length: number | undefined,
  mode: WriteMode,
  draft: string | undefined,
  reasoningEffort: Config["writeReasoningEffort"],
): number {
  const target = length ?? DEFAULT_LENGTH;
  const carried = mode === "continue" ? estimateTokens(draft ?? "") : 0;
  const proseTokens = Math.max(128, Math.ceil(target * TOKENS_PER_WORD + carried));

  // OpenRouter's completion ceiling is shared with reasoning, so the prose
  // allowance only survives if the thinking is given room of its own on top.
  return proseTokens + REASONING_HEADROOM_TOKENS[reasoningEffort];
}

/** An upper bound, not a measure: CJK text runs near a token per character. */
function estimateTokens(text: string): number {
  return text.length;
}
