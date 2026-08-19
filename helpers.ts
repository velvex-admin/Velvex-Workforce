import type { Judge, ProposedAction, RuleContext } from "../src/core/types.js";

export function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    type: "observation",
    summary: "test action",
    payload: {},
    ...overrides,
  };
}

/** A judge with a canned answer, so rule tests stay deterministic. */
export function fixedJudge(category: string, confidence = 0.99): Judge {
  return {
    async categorize<T extends string>() {
      return { category: category as T, confidence, reason: "fixed for test" };
    },
  };
}

export const failingJudge: Judge = {
  async categorize(): Promise<never> {
    throw new Error("judge unavailable");
  },
};

export function ruleContext(judge: Judge = fixedJudge("praise")): RuleContext {
  return { agentId: "content", judge, now: new Date("2026-08-18T12:00:00Z") };
}
