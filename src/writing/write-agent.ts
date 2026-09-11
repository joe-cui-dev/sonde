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
  model?: LanguageModel;
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
  const openrouter = options.model ? null : createOpenRouter({
    apiKey: config.openrouterApiKey,
    headers: { "HTTP-Referer": config.appUrl, "X-Title": config.appTitle },
  });
  const effort = config.writeReasoningEffort;
  const model = options.model ?? openrouter!(config.writeModel, {
    usage: { include: true },
    ...(effort === "default" ? {} : { reasoning: { effort } }),
  });
  const timeout = AbortSignal.timeout(limits.maxWallMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let text = "";
  let streamError: unknown;
  let stoppedBy: StopReason = "complete";
  try {
    const result = streamText({
      model,
      prompt,
      maxOutputTokens: outputTokenLimit(
        options.length,
        mode,
        options.draft,
        effort,
      ),
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
    const finishDetail = rawFinishReason && rawFinishReason !== finishReason
      ? `${finishReason}; provider: ${rawFinishReason}`
      : finishReason;
    // A provider may spend the whole completion on reasoning and then end the
    // stream cleanly. Transport success is not a completed writing run: prose
    // is the product, and claiming an empty result completed leaves the caller
    // with neither a draft nor an explanation of what happened.
    if (text.trim() === "") {
      text = "";
      throw new Error(
        finishReason === "length"
          ? `model returned no prose before reaching the output token limit (finish reason: ${finishDetail})`
          : `model returned no prose (finish reason: ${finishDetail})`,
      );
    }
    // The text already streamed is still useful, but a length finish means it
    // is partial prose, not the finished piece the run promised to deliver.
    if (finishReason === "length") {
      throw new Error(
        `model reached the output token limit (finish reason: ${finishDetail})`,
      );
    }
  } catch (error) {
    stoppedBy = timeout.aborted && !options.signal?.aborted ? "max_wall_ms" : "error";
    const detail = error instanceof Error ? error.message : String(error);
    warn(`${stoppedBy === "max_wall_ms" ? "writing ran out of wall-clock budget" : "writing failed"}: ${detail}`);
  }
  const complete = stoppedBy === "complete";
  if (complete && mode === "expand" && options.length) {
    const written = countWords(text);
    if (written < options.length * SHORTFALL_TOLERANCE) {
      warn(
        `the expanded passage runs to roughly ${written.toLocaleString()} words, ` +
          `short of the ${options.length.toLocaleString()} asked for — ` +
          "expand the saved file again to develop it further",
      );
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
 * Generous by design: a ceiling that stops a runaway, not a target. Cutting a
 * piece off mid-sentence wastes everything already paid for, so the estimate
 * leans high — two tokens per requested word, which covers CJK prose where a
 * "word" is a character that costs roughly a token of its own.
 */
const TOKENS_PER_WORD = 2;

/**
 * Approximate share of an OpenRouter completion left for non-reasoning output
 * at each normalized effort. `default` is provider-owned, so reserve the same
 * space as Sonde's writing default (medium) without pretending it is exact.
 */
const PROSE_SHARE_BY_REASONING_EFFORT: Record<
  Config["writeReasoningEffort"],
  number
> = {
  none: 1,
  minimal: 0.9,
  low: 0.8,
  medium: 0.5,
  high: 0.2,
  xhigh: 0.05,
  default: 0.5,
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

  // OpenRouter's completion ceiling includes reasoning. Its normalized effort
  // levels allocate approximately 10/20/50/80/95 percent of that ceiling to
  // reasoning, so sending only the prose allowance can let thinking consume
  // the room intended for the piece. Inflate the shared ceiling just enough
  // that the original prose allowance remains after that allocation. `default`
  // is unknowable by definition; medium is the least surprising reserve.
  return Math.ceil(
    proseTokens / PROSE_SHARE_BY_REASONING_EFFORT[reasoningEffort],
  );
}

/** An upper bound, not a measure: CJK text runs near a token per character. */
function estimateTokens(text: string): number {
  return text.length;
}
