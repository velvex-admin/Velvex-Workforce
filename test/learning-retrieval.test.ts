// A learning record must never become everyone else's context.
//
// This is the constraint the intelligence layer already paid to learn. Every
// agent's run pulls memory rows into its prompt by salience, so a document
// stored in `memory` is read, and paid for, by agents that never asked for it.
// That is why a brief lives in `intel_briefs` and only a one-line pointer goes
// into memory. A per-agent learning record broadcast the same way would be the
// same mistake with more rows and a per-run write.
//
// The defence is not a convention. It is arithmetic on a PostgREST filter:
// `readMemory({ minSalience: 6 })` becomes `salience=gte.6`, so a row written at
// 4 cannot match it whatever anyone later forgets. That only holds while BOTH
// halves hold, which is why both are asserted here:
//
//   1. what we write is below the floor
//   2. the readers that broadcast still read at the floor
//
// Assert only the first and someone raises a lesson's salience "so the
// Chief-of-Staff can see it too" and nothing fails. Assert only the second and
// someone lowers Growth-Strategy to minSalience 3 and nothing fails. The pair is
// the invariant.

import { describe, expect, it } from "vitest";
import growthStrategy from "../src/agents/executive/growth-strategy.ts?raw";
import chiefOfStaff from "../src/agents/orchestration/chief-of-staff.ts?raw";
import { BROADCAST_FLOOR, emptyRecord, LESSON_SALIENCE } from "../src/core/learning.js";
import { writeLearning } from "../src/core/learning-store.js";
import type { MemoryRow } from "../src/lib/supabase.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

/** Captures the row a write would have sent, without a database. */
function captureDb(): { rows: MemoryRow[]; db: { writeMemory(row: MemoryRow): Promise<MemoryRow> } } {
  const rows: MemoryRow[] = [];
  return {
    rows,
    db: {
      async writeMemory(row: MemoryRow) {
        rows.push(row);
        return row;
      },
    },
  };
}

/**
 * Every `minSalience` a source asks memory for, when it passes no tag filter.
 *
 * A tagged read is not a broadcast: it selects rows on purpose, which is exactly
 * what a learning record wants to be reachable by. Only the untagged reads
 * sweep up whatever is above the floor, so only those constrain us.
 */
function untaggedMinSalience(source: string): number[] {
  const out: number[] = [];
  for (const match of source.matchAll(/readMemory\(\{([^}]*)\}\)/g)) {
    const args = match[1] ?? "";
    if (/tags\s*:/.test(args) || /keys\s*:/.test(args)) continue;
    const salience = /minSalience\s*:\s*(\d+)/.exec(args);
    if (salience) out.push(Number(salience[1]));
  }
  return out;
}

describe("a learning record stays out of other agents' prompts", () => {
  it("is written below the broadcast floor", async () => {
    const { rows, db } = captureDb();
    await writeLearning(db as never, "x", emptyRecord(NOW));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.salience).toBe(LESSON_SALIENCE);
    expect(row.salience!).toBeLessThan(BROADCAST_FLOOR);
  });

  it("carries the tags that make an explicit read possible", async () => {
    // Below the floor it is invisible to a salience sweep, so the ONLY way back
    // to it is a tag or key query. Losing these tags would not fail anything
    // loudly — the agent would simply start every run knowing nothing.
    const { rows, db } = captureDb();
    await writeLearning(db as never, "x", emptyRecord(NOW));

    expect(rows[0]?.tags).toContain("lesson");
    expect(rows[0]?.tags).toContain("x");
    expect(rows[0]?.scope).toBe("x");
    expect(rows[0]?.key).toBe("learning.x");
  });

  it("would not match the sweep that Growth-Strategy and Chief-of-Staff run", async () => {
    const { rows, db } = captureDb();
    await writeLearning(db as never, "x", emptyRecord(NOW));
    const row = rows[0]!;

    // `minSalience: n` becomes `salience=gte.n`. This is that filter.
    const matchesSweep = (minSalience: number) => (row.salience ?? 0) >= minSalience;
    expect(matchesSweep(BROADCAST_FLOOR)).toBe(false);
  });

  it("still faces readers that sweep at the floor, not below it", () => {
    // The other half of the invariant. If either of these drops below
    // LESSON_SALIENCE, learning records start reaching prompts that never asked
    // for them and this test is the only thing that would say so.
    for (const [name, source] of [
      ["growth-strategy", growthStrategy],
      ["chief-of-staff", chiefOfStaff],
    ] as const) {
      const found = untaggedMinSalience(source);
      expect(found.length, `${name} should still read memory by salience`).toBeGreaterThan(0);
      for (const minSalience of found) {
        expect(minSalience, `${name} reads memory at minSalience ${minSalience}`).toBeGreaterThan(
          LESSON_SALIENCE
        );
        expect(minSalience, `${name} reads memory at minSalience ${minSalience}`).toBeGreaterThanOrEqual(
          BROADCAST_FLOOR
        );
      }
    }
  });
});
