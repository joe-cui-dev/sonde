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
  confidence: 'low' | 'medium' | 'high';
  openQuestions: string[];
}

export type StopReason =
  | 'complete'
  | 'max_steps'
  | 'max_usd'
  | 'max_tokens'
  | 'max_search_credits'
  | 'max_wall_ms'
  | 'error';

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

export type RunEvent =
  | { type: 'run_start'; runId: string; question: string }
  | { type: 'step'; step: number; text: string; snapshot: BudgetSnapshot }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_end'; tool: string; summary: string; ms: number }
  | { type: 'phase'; phase: 'research' | 'synthesis' }
  | { type: 'warning'; message: string }
  | { type: 'run_end'; result: ResearchResult };

export type EventSink = (event: RunEvent) => void;
