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
    ['max_steps', (budget) => { budget.countStep(); budget.countStep(); }],
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
    expect(budget.retrievalBlockedBy()).toBe('final_step');
    expect(budget.canRetrieve()).toBe(false);
    // Blocked on steps, not on money — the run is not exhausted yet.
    expect(budget.exhausted).toBe(false);
    expect(budget.check()).toBeNull();
  });

  test('reports an exhausted budget as spent, not as the final step', () => {
    const budget = new BudgetTracker({ ...limits, maxSteps: 3 });
    budget.addModelUsage({ inputTokens: 100 });

    expect(budget.retrievalBlockedBy()).toBe('spent');
    expect(budget.stepsLeft).toBe(3);
  });

  test('reserves synthesis headroom before the budget is exhausted', () => {
    jest.useFakeTimers();
    const budget = new BudgetTracker(limits);
    budget.addModelUsage({ inputTokens: 60, outputTokens: 24 });
    expect(budget.canRetrieve()).toBe(true);

    budget.addModelUsage({ outputTokens: 2 });
    expect(budget.canRetrieve()).toBe(false);
    expect(budget.exhausted).toBe(false);
    expect(budget.snapshot()).toMatchObject({ inputTokens: 60, outputTokens: 26, totalTokens: 86 });
  });
});
