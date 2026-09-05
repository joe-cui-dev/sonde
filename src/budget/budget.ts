import type { BudgetLimits, BudgetSnapshot, StopReason } from '../types.js';

export class BudgetExceededError extends Error {
  constructor(public readonly reason: StopReason, public readonly snapshot: BudgetSnapshot) {
    super(`Budget exceeded: ${reason}`);
    this.name = 'BudgetExceededError';
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

  addModelUsage(u: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    this.inputTokens += u.inputTokens ?? 0;
    this.outputTokens += u.outputTokens ?? 0;
    this.usdSpent += u.costUsd ?? 0;
  }

  addSearchCredits(n: number): void {
    this.credits += n;
  }

  /** The first limit that has been reached, or null. */
  check(): StopReason | null {
    if (this.steps >= this.limits.maxSteps) return 'max_steps';
    if (this.usdSpent >= this.limits.maxUsd) return 'max_usd';
    if (this.inputTokens + this.outputTokens >= this.limits.maxTokens) return 'max_tokens';
    if (this.credits >= this.limits.maxSearchCredits) return 'max_search_credits';
    if (Date.now() - this.startedAt >= this.limits.maxWallMs) return 'max_wall_ms';
    return null;
  }

  get exhausted(): boolean {
    return this.check() !== null;
  }

  /**
   * True while there is still room to spend on retrieval. Deliberately stricter
   * than `exhausted`: we reserve headroom so the writer can still produce a
   * report after the loop stops gathering.
   */
  canRetrieve(reservePct = 0.15): boolean {
    if (this.exhausted) return false;
    const usdLeft = 1 - this.usdSpent / this.limits.maxUsd;
    const tokLeft = 1 - (this.inputTokens + this.outputTokens) / this.limits.maxTokens;
    const creditLeft = 1 - this.credits / this.limits.maxSearchCredits;
    return Math.min(usdLeft, tokLeft, creditLeft) > reservePct;
  }

  snapshot(): BudgetSnapshot {
    return {
      steps: this.steps,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      usd: this.usdSpent,
      searchCredits: this.credits,
      elapsedMs: Date.now() - this.startedAt,
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
    ].join(' · ');
  }
}
