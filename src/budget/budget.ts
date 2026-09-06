import type { BudgetLimits, BudgetSnapshot, StopReason } from "../types.js";

export class BudgetExceededError extends Error {
  constructor(
    public readonly reason: StopReason,
    public readonly snapshot: BudgetSnapshot,
  ) {
    super(`Budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Tracks the four things a research run can run out of: steps, tokens, dollars
 * and search credits — plus wall time. Nothing here throws by default; callers
 * decide whether a hit limit means "stop now" or "degrade gracefully".
 */
export class BudgetTracker {
  readonly limits: BudgetLimits;
  private readonly startedAt = Date.now();

  private steps = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private usdSpent = 0;
  private credits = 0;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  countStep(): void {
    this.steps += 1;
  }

  addModelUsage(u: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }): void {
    this.inputTokens += u.inputTokens ?? 0;
    this.outputTokens += u.outputTokens ?? 0;
    this.usdSpent += u.costUsd ?? 0;
  }

  addSearchCredits(n: number): void {
    this.credits += n;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Wall-clock time left in the run's budget, floored at zero. */
  get remainingWallMs(): number {
    return Math.max(0, this.limits.maxWallMs - this.elapsedMs);
  }

  /**
   * The first *resource* limit that has been reached, or null.
   *
   * Steps are deliberately not one of them. The loop's own `stepCountIs` owns
   * that boundary, and a model that wraps up on its last allowed step has not
   * overspent anything — reporting it here made a finished run look like a
   * breached one. Whether the step limit truncated a run is a question about
   * the loop, answered where the loop ends.
   */
  check(): StopReason | null {
    if (this.usdSpent >= this.limits.maxUsd) return "max_usd";
    if (this.inputTokens + this.outputTokens >= this.limits.maxTokens)
      return "max_tokens";
    if (this.credits >= this.limits.maxSearchCredits)
      return "max_search_credits";
    if (this.elapsedMs >= this.limits.maxWallMs) return "max_wall_ms";
    return null;
  }

  get exhausted(): boolean {
    return this.check() !== null;
  }

  /** Steps still available before `maxSteps` stops the loop. */
  get stepsLeft(): number {
    return Math.max(0, this.limits.maxSteps - this.steps);
  }

  /**
   * Which limit is blocking retrieval, named as the reason that would end the
   * run, or null while retrieval is still allowed.
   *
   * `"max_steps"` is the subtle one. Tools run *during* a step, but the model
   * only sees what they returned on the *next* step. Fetching on the last step
   * means paying for pages nobody ever reads — and worse, those pages get
   * marked citable, so the writer is handed sources it has no text for. We stop
   * retrieval one step early and let the model spend that step writing notes.
   *
   * Everything else is the reserve: retrieval stops with `reservePct` of each
   * resource still unspent, so the writer is never left without the budget to
   * produce a report. Wall time is in that list — leaving it out was how a run
   * could gather until the very last second and then overrun its own deadline
   * while synthesising.
   */
  retrievalBlockedBy(reservePct = 0.15): StopReason | null {
    const spent = this.check();
    if (spent) return spent;
    if (this.stepsLeft <= 1) return "max_steps";

    const remaining: Array<[StopReason, number]> = [
      ["max_usd", 1 - this.usdSpent / this.limits.maxUsd],
      [
        "max_tokens",
        1 - (this.inputTokens + this.outputTokens) / this.limits.maxTokens,
      ],
      [
        "max_search_credits",
        1 - this.credits / this.limits.maxSearchCredits,
      ],
      ["max_wall_ms", 1 - this.elapsedMs / this.limits.maxWallMs],
    ];

    let tightest = remaining[0]!;
    for (const entry of remaining) {
      if (entry[1] < tightest[1]) tightest = entry;
    }
    return tightest[1] > reservePct ? null : tightest[0];
  }

  /** True while there is still room — and a step left — to spend on retrieval. */
  canRetrieve(reservePct = 0.15): boolean {
    return this.retrievalBlockedBy(reservePct) === null;
  }

  snapshot(): BudgetSnapshot {
    return {
      steps: this.steps,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      usd: this.usdSpent,
      searchCredits: this.credits,
      elapsedMs: this.elapsedMs,
      limits: this.limits,
      hit: this.check(),
    };
  }

  /** Human-readable one-liner for logs. */
  format(): string {
    const s = this.snapshot();
    return [
      `${s.steps}/${s.limits.maxSteps} steps`,
      `${s.totalTokens.toLocaleString()} tok`,
      `$${s.usd.toFixed(4)}/$${s.limits.maxUsd}`,
      `${s.searchCredits}/${s.limits.maxSearchCredits} credits`,
      `${(s.elapsedMs / 1000).toFixed(1)}s`,
    ].join(" · ");
  }
}
