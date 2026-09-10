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
  // than on the far side of a paid model call.
  const spec = requireStyle(loadStyles(config.stylesPath), style);
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
    if (event.type !== "write_end" && event.type !== "text_delta") {
      store.event(runId, event.type, event);
    }
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
      prompt: writePrompt({
        brief, draft: options.draft, mode, style: spec, characters,
        language: options.language, length: options.length,
      }),
      maxOutputTokens: outputTokenLimit(options.length, mode, options.draft),
      abortSignal: signal,
      onError: ({ error }) => { streamError ??= error; },
    });
    for await (const delta of result.textStream) {
      text += delta;
      emit({ type: "text_delta", delta });
    }
    const [usage, metadata] = await Promise.all([result.usage, result.providerMetadata]);
    budget.countStep();
    budget.addModelUsage(readModelUsage({ usage, providerMetadata: metadata }));
    if (streamError) throw streamError;
    if (timeout.aborted || options.signal?.aborted) throw signal.reason;
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
    runId, mode, brief, text: text || null, complete, style,
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
 * Continue hands the draft back inside the finished piece, so its ceiling has
 * to pay for the draft as well as for the new prose. New and expand both return
 * new writing only.
 */
function outputTokenLimit(
  length: number | undefined,
  mode: WriteMode,
  draft?: string,
): number {
  const target = length ?? DEFAULT_LENGTH;
  const carried = mode === "continue" ? estimateTokens(draft ?? "") : 0;
  return Math.max(128, Math.ceil(target * TOKENS_PER_WORD + carried));
}

/** An upper bound, not a measure: CJK text runs near a token per character. */
function estimateTokens(text: string): number {
  return text.length;
}
