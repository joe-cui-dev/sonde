import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { BudgetTracker } from '../src/budget/budget.js';
import type { BudgetLimits, StopReason } from '../src/types.js';

const limits: BudgetLimits = {
  maxSteps: 2,
  maxUsd: 1,
  maxTokens: 100,
  maxSearchCredits: 20,
  maxWallMs: 1_000,
};

afterEach(() => {
  jest.useRealTimers();
});

describe('BudgetTracker', () => {
  test.each<[StopReason, (budget: BudgetTracker) => void]>([
    ['max_usd', (budget) => budget.addModelUsage({ costUsd: 1 })],
    ['max_tokens', (budget) => budget.addModelUsage({ inputTokens: 60, outputTokens: 40 })],
    ['max_search_credits', (budget) => budget.addSearchCredits(20)],
    ['max_wall_ms', () => jest.advanceTimersByTime(1_000)],
  ])('stops at the %s boundary', (reason, consume) => {
    jest.useFakeTimers();
    const budget = new BudgetTracker(limits);
    expect(budget.check()).toBeNull();
    expect(budget.canRetrieve()).toBe(true);

    consume(budget);

    expect(budget.check()).toBe(reason);
    expect(budget.exhausted).toBe(true);
    expect(budget.canRetrieve()).toBe(false);
    expect(budget.retrievalBlockedBy()).toBe(reason);
  });

  /**
   * Steps are the loop's business, not the ledger's. A model that wraps up on
   * its last allowed step has overspent nothing, so reporting a breach here is
   * what made a finished run look like a truncated one.
   */
  test('running out of steps is not a breached resource limit', () => {
    const budget = new BudgetTracker({ ...limits, maxSteps: 2 });
    budget.countStep();
    budget.countStep();

    expect(budget.stepsLeft).toBe(0);
    expect(budget.check()).toBeNull();
    expect(budget.exhausted).toBe(false);
    expect(budget.snapshot().hit).toBeNull();
    // But retrieval is still blocked, and named for the limit that blocks it.
    expect(budget.retrievalBlockedBy()).toBe('max_steps');
    expect(budget.canRetrieve()).toBe(false);
  });

  test('reserves the final step, because its tool results are never read', () => {
    const budget = new BudgetTracker({ ...limits, maxSteps: 3 });

    // Steps 0 and 1: whatever they fetch, a later step still gets to read it.
    expect(budget.stepsLeft).toBe(3);
    expect(budget.retrievalBlockedBy()).toBeNull();
    budget.countStep();
    expect(budget.retrievalBlockedBy()).toBeNull();
    budget.countStep();

    // Step 2 is the last one: the loop stops before the model sees any result.
    expect(budget.stepsLeft).toBe(1);
    expect(budget.retrievalBlockedBy()).toBe('max_steps');
    expect(budget.canRetrieve()).toBe(false);
    // Blocked on steps, not on money — nothing is over its line yet.
    expect(budget.exhausted).toBe(false);
  });

  test('names the tightest resource when the reserve is what blocks retrieval', () => {
    const budget = new BudgetTracker({ ...limits, maxSteps: 8 });
    budget.addModelUsage({ inputTokens: 60, outputTokens: 24 });
    expect(budget.canRetrieve()).toBe(true);

    budget.addModelUsage({ outputTokens: 2 });
    expect(budget.retrievalBlockedBy()).toBe('max_tokens');
    expect(budget.canRetrieve()).toBe(false);
    // Reserved, not breached: there is still headroom for the writer.
    expect(budget.exhausted).toBe(false);
    expect(budget.snapshot()).toMatchObject({ inputTokens: 60, outputTokens: 26, totalTokens: 86 });
  });

  /**
   * Wall time belongs in the reserve with everything else. Left out, a run
   * could gather right up to its deadline and then overrun it while writing.
   */
  test('stops gathering with wall-clock time still in reserve', () => {
    jest.useFakeTimers();
    const budget = new BudgetTracker({ ...limits, maxSteps: 8, maxWallMs: 1_000 });

    jest.advanceTimersByTime(840);
    expect(budget.canRetrieve()).toBe(true);
    expect(budget.remainingWallMs).toBe(160);

    jest.advanceTimersByTime(20); // 86% spent, past the 15% reserve
    expect(budget.retrievalBlockedBy()).toBe('max_wall_ms');
    expect(budget.exhausted).toBe(false);
    expect(budget.remainingWallMs).toBe(140);
  });

  test('remainingWallMs floors at zero once the deadline is past', () => {
    jest.useFakeTimers();
    const budget = new BudgetTracker({ ...limits, maxWallMs: 1_000 });

    jest.advanceTimersByTime(1_500);
    expect(budget.remainingWallMs).toBe(0);
    expect(budget.check()).toBe('max_wall_ms');
  });
});
