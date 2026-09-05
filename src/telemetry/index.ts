import type { Telemetry } from 'ai';
import type { RunStore } from '../store/runs.js';

/**
 * AI SDK v7 accepts telemetry integrations per call, so we hand each run its own
 * instance instead of registering a process-wide one and routing by id. Every
 * model call and tool execution lands in the run_events table, which makes a run
 * reconstructable after the fact.
 *
 * Adding Langfuse or Braintrust later means putting their integration next to
 * this one in the `integrations` array — nothing else changes.
 */
export function createRunTelemetry(deps: {
  store: RunStore;
  runId: string;
  phase: string;
}): Telemetry {
  const record = (type: string) => (event: unknown) => {
    const e = (event ?? {}) as Record<string, unknown>;
    deps.store.event(deps.runId, `${deps.phase}.${type}`, {
      callId: e['callId'],
      stepNumber: e['stepNumber'],
      modelId: e['modelId'],
      provider: e['provider'],
      toolName: e['toolName'],
      finishReason: e['finishReason'],
      usage: e['usage'],
      error: e['error'] instanceof Error ? (e['error'] as Error).message : e['error'],
    });
  };

  return {
    onStart: record('operation.start'),
    onStepStart: record('step.start'),
    onStepEnd: record('step.end'),
    onLanguageModelCallEnd: record('model.call.end'),
    onToolExecutionStart: record('tool.start'),
    onToolExecutionEnd: record('tool.end'),
  };
}
