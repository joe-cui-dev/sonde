# Synthesis streaming design

Status: implemented and offline-verified.

## Confirmed decisions

- Use `streamText` for synthesis while retaining structured report output. Extract readable report content from `partialOutputStream`; raw text deltas contain JSON.
- Display a waiting indicator with elapsed time before report content arrives, then progressively show report content. The feature improves visible feedback and does not promise shorter model latency. Reasoning display is outside the agreed scope.
- Label the report preview as in progress and not yet validated. The final report remains subject to complete schema and citation validation.
- Show live previews on interactive stderr. Preserve a single complete result on stdout for Markdown or `--json`, and a complete report file for `--out`. Suppress previews with `--quiet`.

- On interruption, timeout, stream failure, provider refusal, or final validation failure, retain all report preview content already displayed. Mark it as incomplete or not validated and show the failure reason. A guardrail failure must not silently retract the displayed preview. Preserve research notes and sources; do not promote partial content to a final report or add application-level automatic retries.
- Clear the temporary preview only after the final result has been successfully delivered. For `--out`, successful delivery means the complete report file was written and its path displayed. If final output delivery fails, retain the preview and report the error. Terminal cleanup must preserve the delivered final output.
- Expose live preview updates through the library event callback. Keep preview updates transient, outside SQLite event persistence; retain existing run records and final report storage. Preview replay is outside this change.

## Implementation constraints

- Preserve the remaining wall-clock budget and external cancellation signal.
- Await streaming usage and provider metadata for existing accounting; retain citation checks on the final structured output.
- The existing event sink persists events synchronously. Exclude preview updates from that persistence path.
- Verify delayed first content, incremental structured output, stream failure and cancellation, citation validation, accounting, and CLI output isolation with offline mocks. Include preview retention after failure (including final output delivery failure), cleanup after successful delivery, and transient callback events that are not stored in SQLite.

These choices are reversible and do not currently warrant an ADR.
