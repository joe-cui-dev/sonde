import { randomUUID } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, type LanguageModel } from "ai";
import { BudgetTracker } from "../budget/budget.js";
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
import { writePrompt } from "./prompts.js";
import { WRITE_STYLES } from "./styles.js";

export interface RunWriteOptions {
  brief: string;
  draft?: string;
  mode?: WriteMode;
  style?: WriteStyleId;
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
  const style = options.style ?? "plain";
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
    if (event.type !== "write_end") store.event(runId, event.type, event);
    options.onEvent?.(event);
  };
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    emit({ type: "warning", message });
  };
  emit({ type: "write_start", runId, brief, mode });
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
        brief, draft: options.draft, mode, style: WRITE_STYLES[style],
        language: options.language, length: options.length ?? DEFAULT_LENGTH,
      }),
      maxOutputTokens: outputTokenLimit(options.length, mode),
      abortSignal: signal,
      onError: ({ error }) => { streamError ??= error; },
    });
    for await (const delta of result.textStream) {
      text += delta;
      emit({ type: "text_delta", delta });
    }
    const [usage, metadata] = await Promise.all([result.usage, result.providerMetadata]);
    budget.countStep();
    budget.addModelUsage(readUsage({ usage, providerMetadata: metadata }));
    if (streamError) throw streamError;
    if (timeout.aborted || options.signal?.aborted) throw signal.reason;
  } catch (error) {
    stoppedBy = timeout.aborted && !options.signal?.aborted ? "max_wall_ms" : "error";
    const detail = error instanceof Error ? error.message : String(error);
    warn(`${stoppedBy === "max_wall_ms" ? "writing ran out of wall-clock budget" : "writing failed"}: ${detail}`);
  }
  const complete = stoppedBy === "complete";
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

function outputTokenLimit(length: number | undefined, mode: WriteMode): number {
  const target = length ?? DEFAULT_LENGTH;
  return Math.max(128, Math.ceil(mode === "expand" ? target * 800 : target * 1.5));
}

function readUsage(value: { usage: any; providerMetadata: any }) {
  return {
    inputTokens: value.usage?.inputTokens?.total,
    outputTokens: value.usage?.outputTokens?.total,
    costUsd: value.providerMetadata?.openrouter?.usage?.cost,
  };
}
