/** Stable, run-scoped citation handle, e.g. "S3". */
export type SourceId = string;

export interface SourceRef {
  id: SourceId;
  url: string;
  title: string;
  publishedDate?: string;
  score?: number;
  /** Whether the full text was actually read, or we only ever saw a snippet. */
  read: boolean;
}

/**
 * A citable source paired with the text it may quote from. The pairing is the
 * point: a source with no excerpt is one the writer must invent quotes for.
 */
export interface SourceEvidence {
  ref: SourceRef;
  /** Verbatim slice of the fetched page body. */
  excerpt: string;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  score?: number;
  publishedDate?: string;
}

export interface FetchedPage {
  url: string;
  title: string | null;
  /** Cleaned markdown/plain text of the page body. */
  text: string;
  fetchedAt: number;
  fromCache: boolean;
}

export interface FetchFailure {
  url: string;
  error: string;
}

export interface Citation {
  id: SourceId;
  url: string;
  title: string;
  /** Short verbatim span from the source that supports the claim. */
  quote: string;
}

export interface ResearchReport {
  summary: string;
  /** Markdown. Claims carry inline [S1] / [S2] markers. */
  report: string;
  citations: Citation[];
  confidence: "low" | "medium" | "high";
  openQuestions: string[];
}

export type StopReason =
  | "complete"
  | "max_steps"
  | "max_usd"
  | "max_tokens"
  | "max_search_credits"
  | "max_wall_ms"
  | "error";

export interface BudgetLimits {
  maxSteps: number;
  maxUsd: number;
  maxTokens: number;
  maxSearchCredits: number;
  maxWallMs: number;
}

export interface BudgetSnapshot {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usd: number;
  searchCredits: number;
  elapsedMs: number;
  limits: BudgetLimits;
  /** Non-null once any limit is reached. */
  hit: StopReason | null;
}

export interface ResearchResult {
  runId: string;
  question: string;
  report: ResearchReport | null;
  /** Raw notes the tool loop produced before synthesis. */
  notes: string;
  sources: SourceRef[];
  usage: BudgetSnapshot;
  stoppedBy: StopReason;
  warnings: string[];
}

/**
 * An incomplete, transient view of the report while synthesis is running.
 * It has not passed complete schema or citation validation.
 */
export interface ReportPreview {
  summary?: string;
  report?: string;
}

export type RunEvent =
  | { type: "run_start"; runId: string; question: string }
  | { type: "step"; step: number; text: string; snapshot: BudgetSnapshot }
  | { type: "tool_start"; tool: string; input: unknown }
  | { type: "tool_end"; tool: string; summary: string; ms: number }
  | { type: "phase"; phase: "research" | "synthesis" }
  | { type: "report_preview"; preview: ReportPreview }
  | { type: "warning"; message: string }
  | { type: "run_end"; result: ResearchResult };

export type EventSink = (event: RunEvent) => void;

export type WriteMode = "new" | "continue" | "expand";
/** The styles Sonde ships with, and the only ones it knows at compile time. */
export type BuiltInStyleId =
  | "match"
  | "plain"
  | "literary"
  | "reportage"
  | "commentary"
  | "explainer"
  | "business";
/**
 * A styles file may name a style anything, so an id is a string — whether one
 * exists is a question for the catalogue at run time, not for the compiler.
 */
export type WriteStyleId = string;
export interface WriteResult {
  runId: string;
  mode: WriteMode;
  brief: string;
  text: string | null;
  complete: boolean;
  /** The register the run wrote in, or null: a new run given no `--style` takes none. */
  style: WriteStyleId | null;
  usage: BudgetSnapshot;
  stoppedBy: StopReason;
  warnings: string[];
}
export type WriteEvent =
  | {
      type: "write_start";
      runId: string;
      brief: string;
      mode: WriteMode;
      /** Names of the characters injected into this run, if any. */
      characters?: string[];
      /** Fingerprint of the characters file they came from — see hashCharactersFile. */
      charactersHash?: string;
    }
  /**
   * A coarse, trustworthy progress transition. `thinking` fires once, only on an
   * observed provider reasoning event — never assumed; `writing` fires once,
   * just before the first non-empty prose delta.
   */
  | { type: "write_phase"; phase: "thinking" | "writing" }
  /**
   * Raw reasoning as the provider streamed it. Live terminal output and nothing
   * else — never persisted, never part of the prose, never on the `WriteResult`.
   * It exists so a run that returns no prose can still show what was paid for.
   */
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "warning"; message: string }
  | { type: "write_end"; result: WriteResult };
export type WriteEventSink = (event: WriteEvent) => void;
