// What this system costs, measured rather than estimated.
//
// Every run already computed `result.costUsd` — the runner snapshots the Claude
// client's spend either side of the run, so it is a real number and not a model
// of one. It was then discarded: nothing persisted it, `usage` was null on every
// report row, and "what am I spending" could only be answered by arithmetic over
// assumptions. For someone deciding whether $12 of credit lasts a week or a
// quarter, an estimate with that much error in it is not an answer.
//
// The arithmetic is tested without a database on purpose. A bug in it would be
// a wrong number carrying the authority of a measurement, which is worse than
// no number at all.

import { describe, expect, it } from "vitest";
import {
  emptyLedger,
  MAX_SPEND_DAYS,
  recordSpend,
  summarise,
  type SpendLedger,
} from "../src/core/spend.js";
import registry from "../src/agents/registry.ts?raw";
import growthStrategy from "../src/agents/executive/growth-strategy.ts?raw";
import chiefOfStaff from "../src/agents/orchestration/chief-of-staff.ts?raw";

const NOW = new Date("2026-08-31T12:00:00Z");
const run = (agentId: string, costUsd: number, modelCalls = 1) => ({ agentId, costUsd, modelCalls });

describe("recording a tick", () => {
  it("keeps a day, a total and a per-agent split", () => {
    const l = recordSpend(emptyLedger(NOW), [run("x", 0.072), run("content", 0.11)], NOW);
    expect(l.days).toHaveLength(1);
    expect(l.days[0]?.day).toBe("2026-08-31");
    expect(l.days[0]?.totalUsd).toBeCloseTo(0.182, 6);
    expect(l.days[0]?.byAgent).toEqual({ x: 0.072, content: 0.11 });
    expect(l.days[0]?.runs).toBe(2);
  });

  it("accumulates across ticks on the same day", () => {
    let l = recordSpend(emptyLedger(NOW), [run("x", 0.072)], NOW);
    l = recordSpend(l, [run("x", 0.05)], new Date("2026-08-31T18:00:00Z"));
    expect(l.days).toHaveLength(1);
    expect(l.days[0]?.byAgent["x"]).toBeCloseTo(0.122, 6);
    expect(l.days[0]?.runs).toBe(2);
  });

  it("writes nothing at all when the tick spent nothing", () => {
    // Most hourly ticks make no model call: the strategists wake, find their
    // shelves stocked and return. Recording those would buy two subrequests an
    // hour to store a zero, on the budget that has already killed an agent.
    const before = emptyLedger(NOW);
    expect(recordSpend(before, [run("x", 0), run("ops_health", 0)], NOW)).toBe(before);
  });

  it("stays bounded, because a row that only grows is read back in full forever", () => {
    let l: SpendLedger = emptyLedger(NOW);
    for (let i = 0; i < MAX_SPEND_DAYS + 20; i++) {
      const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
      l = recordSpend(l, [run("x", 0.01)], day);
    }
    expect(l.days).toHaveLength(MAX_SPEND_DAYS);
    // The oldest are the ones dropped.
    expect(l.days[l.days.length - 1]?.day).toBe(
      new Date(Date.UTC(2026, 0, 1) + (MAX_SPEND_DAYS + 19) * 86_400_000).toISOString().slice(0, 10)
    );
  });
});

describe("what it says about a balance", () => {
  const ledger = (): SpendLedger => {
    let l = emptyLedger(NOW);
    // Ten days at $0.40, which is a plausible shape rather than a flat line.
    for (let i = 0; i < 10; i++) {
      const day = new Date(NOW.getTime() - (9 - i) * 86_400_000);
      l = recordSpend(l, [run("chief_of_staff", 0.25), run("x", 0.15)], day);
    }
    return l;
  };

  it("averages over days observed, not days that happened to be expensive", () => {
    const s = summarise(ledger(), NOW);
    expect(s.dailyAverage).toBeCloseTo(0.4, 5);
    expect(s.monthlyProjection).toBeCloseTo(12, 5);
  });

  it("counts a quiet day against the average, not around it", () => {
    // The first version of this test used a fixture that spent on every day, so
    // "divide by days observed" and "divide by days that spent" gave the same
    // answer and it passed on either. A ledger with quiet days is what tells
    // them apart — and getting it wrong flatters the average, which is the
    // wrong direction to be wrong when the output is "your credit lasts N days".
    let l = emptyLedger(NOW);
    // Ten days on file, but only two of them cost anything.
    for (const offset of [9, 0]) {
      l = recordSpend(l, [run("x", 1.0)], new Date(NOW.getTime() - offset * 86_400_000));
    }
    // Pad the file out so ten days are observed.
    for (let i = 1; i < 9; i++) {
      l = { ...l, days: [...l.days, { day: new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10), totalUsd: 0, byAgent: {}, runs: 0, modelCalls: 0 }] };
    }
    l = { ...l, days: l.days.slice().sort((a, b) => a.day.localeCompare(b.day)) };

    const s = summarise(l, NOW);
    // $2 over ten days observed is $0.20/day. Over the two days that spent it
    // would be $1.00/day — five times too high, and it would tell you your
    // credit runs out five times sooner than it does.
    expect(s.dailyAverage).toBeCloseTo(0.2, 5);
    expect(summarise(l, NOW, 12).daysOfCreditLeft).toBe(60);
  });

  it("turns a balance into a date", () => {
    const s = summarise(ledger(), NOW, 12);
    expect(s.daysOfCreditLeft).toBe(30);
    expect(s.runsOutOn).toBe("2026-09-30");
  });

  it("says nothing about a balance it was not given", () => {
    const s = summarise(ledger(), NOW);
    expect(s.daysOfCreditLeft).toBeNull();
    expect(s.runsOutOn).toBeNull();
  });

  it("does not divide by zero on an empty ledger", () => {
    const s = summarise(emptyLedger(NOW), NOW, 12);
    expect(s.dailyAverage).toBe(0);
    expect(s.daysOfCreditLeft).toBeNull();
  });

  it("names the agents actually responsible, biggest first", () => {
    const s = summarise(ledger(), NOW);
    expect(s.topAgents[0]?.agentId).toBe("chief_of_staff");
    expect(s.topAgents[1]?.agentId).toBe("x");
  });
});

describe("where the ledger is written", () => {
  it("is recorded from runDue, so every tick is covered by one place", () => {
    expect(registry).toContain("recordSpend");
    expect(registry).toContain("writeLedger");
  });

  it("cannot take a tick down with it", () => {
    // Same rule as the status board and the failure report: bookkeeping that
    // throws must not kill the invocation that was doing real work.
    expect(registry).toMatch(/could not record this tick's spend/);
  });

  it("stays below the broadcast floor", () => {
    // Growth-Strategy and Chief-of-Staff sweep memory at minSalience 6 with no
    // tag filter. A ledger growing daily inside both their prompts is exactly
    // the cost this row exists to measure.
    expect(registry + growthStrategy + chiefOfStaff).toBeTruthy();
    for (const source of [growthStrategy, chiefOfStaff]) {
      for (const m of source.matchAll(/readMemory\(\{([^}]*)\}\)/g)) {
        const args = m[1] ?? "";
        if (/tags\s*:/.test(args) || /keys\s*:/.test(args)) continue;
        const min = /minSalience\s*:\s*(\d+)/.exec(args);
        if (min) expect(Number(min[1])).toBeGreaterThan(4);
      }
    }
  });
});
