import type { Telemetry } from "ai";
import type { RunStore } from "../store/runs.js";

/**
* AI SDK v7 takes telemetry integrations per call, so each run gets its own
* instance rather than a process-wide one routed by id. Every model call and
* tool execution lands in run_events, which is what makes a run reconstructable.
* Langfuse or Braintrust would go beside this one in `integrations`.
*/
export function createRunTelemetry(deps: {
  store: RunStore;
  runId: string;
  phase: string;
}): Telemetry {
  const record = (type: string) => (event: unknown) => {
    const e = (event ?? {}) as Record<string, unknown>;
    deps.store.event(deps.runId, `${deps.phase}.${type}`, {
      callId: e["callId"],
      stepNumber: e["stepNumber"],
      modelId: e["modelId"],
      provider: e["provider"],
      toolName: e["toolName"],
      finishReason: e["finishReason"],
      usage: e["usage"],
      error:
        e["error"] instanceof Error
          ? (e["error"] as Error).message
          : e["error"],
    });
  };

  return {
    onStart: record("operation.start"),
    onStepStart: record("step.start"),
    onStepEnd: record("step.end"),
    onLanguageModelCallEnd: record("model.call.end"),
    onToolExecutionStart: record("tool.start"),
    onToolExecutionEnd: record("tool.end"),
  };
}
