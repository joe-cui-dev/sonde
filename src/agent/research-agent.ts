import { randomUUID } from 'node:crypto';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, Output, stepCountIs, ToolLoopAgent, type LanguageModel } from 'ai';
import { z } from 'zod';

import { loadConfig, type Config } from '../config.js';
import { BudgetTracker } from '../budget/budget.js';
import { createRetrieval, type Retrieval } from '../providers/index.js';
import { openDb } from '../store/db.js';
import { PageCache } from '../store/cache.js';
import { RunStore } from '../store/runs.js';
import { createRunTelemetry } from '../telemetry/index.js';
import { createTools } from '../tools/index.js';
import { SourceRegistry } from './source-registry.js';
import { RESEARCH_INSTRUCTIONS, synthesisPrompt } from './prompts.js';
import { createLogger } from '../util/log.js';
import type {
  BudgetLimits,
  EventSink,
  ResearchReport,
  ResearchResult,
  RunEvent,
  StopReason,
} from '../types.js';

const ReportSchema = z.object({
  summary: z.string().describe('Two to four sentences answering the question directly.'),
  report: z
    .string()
    .describe('Markdown. Every factual claim carries an inline source marker like [S3].'),
  citations: z
    .array(
      z.object({
        id: z.string().describe('A source id from the supplied list, e.g. "S3".'),
        url: z.string(),
        title: z.string(),
        quote: z.string().describe('Short verbatim span from that source supporting the claim.'),
      }),
    )
    .describe('One entry per source id used in the report.'),
  confidence: z.enum(['low', 'medium', 'high']),
  openQuestions: z.array(z.string()).describe('What the evidence did not settle.'),
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

export async function runResearch(options: RunResearchOptions): Promise<ResearchResult> {
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
    if (event.type !== 'run_end') store.event(runId, event.type, event);
    options.onEvent?.(event);
  };

  emit({ type: 'run_start', runId, question });

  // `usage: { include: true }` turns on OpenRouter usage accounting — this is
  // what makes the dollar budget real rather than an estimate.
  // To pin or order upstream providers, add:
  //   extraBody: { provider: { order: ['anthropic'], allow_fallbacks: true } }
  const openrouter =
    options.models?.planner && options.models?.writer
      ? null
      : createOpenRouter({
          apiKey: config.openrouterApiKey,
          headers: { 'HTTP-Referer': config.appUrl, 'X-Title': config.appTitle },
        });

  const plannerModel =
    options.models?.planner ?? openrouter!(config.plannerModel, { usage: { include: true } });
  const writerModel =
    options.models?.writer ?? openrouter!(config.writerModel, { usage: { include: true } });

  const tools = createTools({
    retrieval: options.retrieval ?? createRetrieval(config),
    registry,
    cache,
    budget,
    emit,
    onSource: () => {},
  });

  const agent = new ToolLoopAgent({
    id: 'sonde-research',
    model: plannerModel,
    instructions: RESEARCH_INSTRUCTIONS,
    tools,
    toolChoice: 'auto',
    stopWhen: [stepCountIs(limits.maxSteps), () => budget.exhausted],
    telemetry: {
      functionId: 'sonde.research',
      integrations: [createRunTelemetry({ store, runId, phase: 'research' })],
    },
  });

  const warnings: string[] = [];
  let stoppedBy: StopReason = 'complete';
  let notes = '';

  emit({ type: 'phase', phase: 'research' });

  try {
    const result = await agent.generate({
      prompt: `Research question: ${question}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      onStepEnd: (event) => {
        budget.countStep();
        budget.addModelUsage(readUsage(event));
        emit({
          type: 'step',
          step: budget.snapshot().steps,
          text: typeof event.text === 'string' ? event.text : '',
          snapshot: budget.snapshot(),
        });
      },
    });
    notes = result.text;
  } catch (error) {
    stoppedBy = 'error';
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`research loop failed: ${message}`);
    emit({ type: 'warning', message });
    logger.error(message);
  }

  const limitHit = budget.check();
  if (stoppedBy !== 'error' && limitHit) stoppedBy = limitHit;

  // ── Synthesis ───────────────────────────────────────────────────────────────
  // Deliberately a separate call: the writer sees only the notes and the list of
  // pages that were actually read, so a citation can be checked mechanically.
  const readSources = registry.read();
  let report: ResearchReport | null = null;

  if (notes.trim().length > 0 && readSources.length > 0) {
    emit({ type: 'phase', phase: 'synthesis' });
    try {
      const synthesis = await generateText({
        model: writerModel,
        output: Output.object({ schema: ReportSchema }),
        prompt: synthesisPrompt({
          question,
          notes,
          sources: readSources,
          degraded: stoppedBy !== 'complete',
        }),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        telemetry: {
          functionId: 'sonde.synthesis',
          integrations: [createRunTelemetry({ store, runId, phase: 'synthesis' })],
        },
      });

      budget.addModelUsage(readUsage(synthesis));

      const validated = validateCitations(synthesis.output, registry);
      report = validated.report;
      warnings.push(...validated.warnings);
      for (const w of validated.warnings) emit({ type: 'warning', message: w });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`synthesis failed: ${message}`);
      emit({ type: 'warning', message });
    }
  } else if (readSources.length === 0) {
    warnings.push('No source was successfully read — nothing to cite, so no report was written.');
  }

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
  emit({ type: 'run_end', result });
  db.close();

  return result;
}

/** Pulls token counts and — when OpenRouter reports it — real dollars. */
function readUsage(source: unknown): { inputTokens: number; outputTokens: number; costUsd: number } {
  const s = source as {
    usage?: { inputTokens?: number; outputTokens?: number };
    totalUsage?: { inputTokens?: number; outputTokens?: number };
    providerMetadata?: Record<string, unknown>;
  };

  const usage = s.totalUsage ?? s.usage ?? {};
  const openrouter = s.providerMetadata?.['openrouter'] as
    | { usage?: { cost?: number; totalCost?: number } }
    | undefined;

  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: openrouter?.usage?.cost ?? openrouter?.usage?.totalCost ?? 0,
  };
}

/** Drops citations pointing at pages we never read, rather than trusting the model. */
function validateCitations(
  report: ResearchReport,
  registry: SourceRegistry,
): { report: ResearchReport; warnings: string[] } {
  const warnings: string[] = [];
  const kept = report.citations.filter((citation) => {
    const ref = registry.byId(citation.id);
    if (!ref || !ref.read) {
      warnings.push(`dropped citation ${citation.id} — that source was never read`);
      return false;
    }
    citation.url = ref.url;
    citation.title = ref.title;
    return true;
  });

  const validIds = new Set(kept.map((c) => c.id));
  for (const id of report.report.match(/\[S\d+\]/g) ?? []) {
    const bare = id.slice(1, -1);
    if (!validIds.has(bare)) {
      warnings.push(`report cites ${bare}, which is not in the validated citation list`);
    }
  }

  return { report: { ...report, citations: kept }, warnings };
}
