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
   * Stands in for the OpenRouter model Sonde would build, which is the seam
   * tests reach through. A function is called once per attempt with the
   * reasoning effort that attempt asks for — the only way to observe the
   * reasoning retry from outside, since effort is fixed when the model is
   * constructed. A bare model is used for every attempt exactly as given,
   * because nothing outside Sonde can reconfigure one.
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
  // Resolved before anything is opened, spent, or recorded: a style that does
  // not exist is a typo in the command, and the run should die on it rather
  // than on the far side of a paid model call. No style at all is not a typo —
  // it is a new run that was given none and wants none, so nothing is loaded
  // and the prompt goes out without a register.
  const spec = style === undefined
    ? undefined
    : requireStyle(loadStyles(config.stylesPath), style);
  // Characters are resolved at the same point and for the same reason: an
  // unknown id, or a run that asks for more people or bigger fields than the
  // hard limits allow, is a mistake in the command that should fail here,
  // not after the model has already been paid for a prompt built around it.
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
  // Build this once, expose that same immutable string to diagnostics, and
  // then hand it to streamText. Keeping one value avoids a prompt preview
  // drifting away from the request it claims to show.
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
    // Deltas are live output; finishWrite persists the accumulated prose once.
    // Reasoning is not persisted at all: it is scaffolding the model threw
    // away, and run history is a record of what was written, not of thinking.
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
    // Only present when characters were actually injected, so the ordinary
    // run — no characters file, or none named — leaves no trace of a feature
    // it never touched.
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
  // Effort is fixed when the model is constructed, so an attempt that wants a
  // different one needs a different model — which is why this is a function
  // and not the single value it used to be.
  const modelFor = (attemptEffort: Config["writeReasoningEffort"]): LanguageModel =>
    typeof supplied === "function"
      ? supplied(attemptEffort)
      : supplied ?? openrouter!(config.writeModel, {
          usage: { include: true },
          ...(attemptEffort === "default" ? {} : { reasoning: { effort: attemptEffort } }),
        });
  // One ceiling for the whole run rather than one per attempt. The retry below
  // exists to give the piece the room the first attempt spent on thinking, and
  // a ceiling recomputed for a reasoning-free attempt would take that room
  // straight back out again.
  const maxOutputTokens = outputTokenLimit(options.length, mode, options.draft, effort);
  const timeout = AbortSignal.timeout(limits.maxWallMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let text = "";
  let stoppedBy: StopReason = "complete";
  /**
   * One model turn: streams it, bills it, and reports how the provider says it
   * ended. Prose accumulates into the run's `text` rather than into a return
   * value, so whatever was streamed before a throw is still there to deliver.
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
    // The full stream, not textStream: a reasoning-capable provider's
    // reasoning-start/-delta parts arrive here and nowhere else, and they are
    // the only trustworthy signal that the model has started working before
    // any prose exists. Their text is forwarded to the caller as live output
    // and never accumulated into `text`: reasoning is not the piece.
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
    // No prose at all, and the ceiling is why: every token of the completion
    // went on thinking that never reached a first word. The ceiling already
    // carries several times the thinking this model was measured wanting (see
    // REASONING_HEADROOM_TOKENS), so the run that overruns it has drawn from
    // the far tail of an appetite the effort level does not actually bound —
    // and raising the headroom cannot close a tail, it can only move it. What
    // does close it is taking reasoning out of the request, which is the one
    // remaining shape of this call whose whole ceiling belongs to the writer.
    // It is worth a second call: the run has already been paid for and has
    // nothing to show for it, and this is the difference between charging for
    // a draft and charging for silence.
    //
    // Deliberately narrow. Partial prose does not qualify — that is a piece
    // that was cut off, and it is delivered as what it is rather than thrown
    // away and rewritten from the start. A finish reason other than `length`
    // does not qualify either: the model stopped for a reason of its own and
    // repeating the request would only buy the same answer again.
    const spentCeilingOnThinking =
      text.trim() === "" && outcome.finishReason === "length";
    if (spentCeilingOnThinking && effort !== "none" && !budget.exhausted) {
      warn(
        "the model spent the whole output ceiling on reasoning and wrote nothing " +
          `(finish reason: ${outcome.detail}); retrying once with reasoning off`,
      );
      outcome = await attempt("none");
    }
    // A provider may spend the whole completion on reasoning and then end the
    // stream cleanly. Transport success is not a completed writing run: prose
    // is the product, and claiming an empty result completed leaves the caller
    // with neither a draft nor an explanation of what happened.
    if (text.trim() === "") {
      text = "";
      throw new Error(
        outcome.finishReason === "length"
          ? `model returned no prose before reaching the output token limit (finish reason: ${outcome.detail})`
          : `model returned no prose (finish reason: ${outcome.detail})`,
      );
    }
    // The text already streamed is still useful, but a length finish means it
    // is partial prose, not the finished piece the run promised to deliver.
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
  // Every mode that was given a count, not only expand. A count is the one
  // requirement a run can check against its own output, and a 2,000-word brief
  // answered with eight characters was being archived as the finished piece.
  // Under continue the measure is the whole returned text, which is what the
  // count means in that mode: the draft carried back plus what was added.
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

/**
 * A floor is a floor, but the measure of what was written is an estimate, and a
 * run that lands a few percent under it has done what was asked. Only a miss
 * wide enough to be real is worth putting in front of whoever ran the command.
 */
const SHORTFALL_TOLERANCE = 0.9;

/**
 * Under new and continue the count is a soft target, and a warning that fires
 * on a piece delivered at 1,750 of the 2,000 asked for would be noise — and a
 * warning that is noise is a warning nobody reads. The failures worth naming
 * there are the order-of-magnitude ones: prose that stopped in its first
 * paragraph, or a model that answered the brief with a line about not writing
 * it. Half the count is well below anything a finished piece lands on.
 */
const SOFT_TARGET_TOLERANCE = 0.5;

function shortfallTolerance(mode: WriteMode): number {
  return mode === "expand" ? SHORTFALL_TOLERANCE : SOFT_TARGET_TOLERANCE;
}

/**
 * Reports the count and nothing more. A short return has several causes — a
 * passage that ran out of material, a piece that stopped early, a model that
 * declined the brief — and the count cannot tell them apart. Naming a cause
 * here would be a guess dressed as a finding; the prose is on screen and
 * whoever ran the command can see which it was.
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
 * Generous by design: a ceiling that stops a runaway, not a target. Cutting a
 * piece off mid-sentence wastes everything already paid for, so the estimate
 * leans high — two tokens per requested word, which covers CJK prose where a
 * "word" is a character that costs roughly a token of its own.
 */
const TOKENS_PER_WORD = 2;

/**
 * Tokens of thinking to leave room for above the prose allowance, at each
 * normalized effort.
 *
 * This used to be a share: the prose allowance divided by the fraction of a
 * completion the effort level was thought to leave for prose, on the model
 * that OpenRouter's levels hand thinking a percentage of whatever ceiling they
 * are given. Measured against deepseek/deepseek-v4.1-flash at `low`, that
 * model of the world is wrong in both of its parts.
 *
 * It is not a percentage. Sweeping the ceiling against one brief at `low`, the
 * thinking took 2,000 tokens of a 2,000 ceiling and 3,652 of a 4,000, both cut
 * off mid-thought; given 6,000 it took 1,290 on one attempt and 3,515 on
 * another, given 10,000 it took 2,253 and then 483, and given 32,000 it took
 * 422. Past roughly five thousand tokens the ceiling stops predicting anything
 * and what is left is the model's own appetite, which on this one brief ran
 * anywhere from 400 tokens to 3,700. Below that the ceiling does not size the
 * thinking, it only cuts it off — and thinking cut off before the first word
 * of prose returns nothing at all.
 *
 * Dividing also made the reservation shrink with the request, which is the
 * wrong way round, because a fixed overhead costs a short piece most. At
 * `--length 600` the share put the entire ceiling at 1,500 tokens: ten
 * attempts produced one usable piece, and six of the ten returned no prose
 * whatsoever. Every one of them was paid for.
 *
 * So thinking is budgeted as the thing it is — an overhead added on top of the
 * prose allowance, the same tokens for a 200-word piece as for a 2,000-word
 * one — and the figures sit well clear of that measured appetite rather than
 * near it. Headroom that goes unspent costs nothing, because a ceiling is only
 * ever a stop and never a target, while headroom that runs out costs the whole
 * run. They stop short of the tens of thousands for one reason only: a ceiling
 * above a model's own completion limit is a request some providers refuse
 * outright, and an unusable run is a worse outcome than a rare truncated one.
 * `default` is provider-owned and unknowable; it reserves what Sonde's own
 * writing default (medium) reserves, without pretending to know.
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

  // OpenRouter's completion ceiling is shared: reasoning is spent out of the
  // same allowance as the prose. So the ceiling is the room the piece needs
  // plus the room the thinking will take, and the prose allowance survives
  // whatever the thinking does with its own.
  return proseTokens + REASONING_HEADROOM_TOKENS[reasoningEffort];
}

/** An upper bound, not a measure: CJK text runs near a token per character. */
function estimateTokens(text: string): number {
  return text.length;
}
