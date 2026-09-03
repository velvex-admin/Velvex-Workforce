// Three agents in this system are fully configured and have nothing to work on.
// That is a fourth state, and until it was written down the dashboard had only
// three words for it: running, failed, paused. The owner read a paused agent
// with a stale failed row and reasonably concluded something was broken.
//
// These tests assert the distinction end to end: a missing FEED is reported,
// a connected one is not, and the run path never pays a subrequest for it.

import { describe, expect, it, vi } from "vitest";
import { resolveRequirements, unmetRequirements } from "../src/core/agent.js";
import { leadPipelineAgent } from "../src/agents/sales/lead-pipeline.js";
import { financeWatchAgent } from "../src/agents/executive/finance-watch.js";
import { STATE_KEYS } from "../src/core/state.js";
import type { Env } from "../src/env.js";

const env = {} as Env;

/** A Supabase stand-in that records exactly which keys were asked for. */
function stubDb(rows: Array<{ key: string; value: unknown }>) {
  const asked: string[][] = [];
  return {
    asked,
    db: {
      readMemory: vi.fn(async ({ keys }: { keys?: string[] }) => {
        asked.push(keys ?? []);
        return rows
          .filter((row) => (keys ?? []).includes(row.key))
          .map((row) => ({ key: row.key, detail: { value: row.value } }));
      }),
    } as never,
  };
}

describe("an agent waiting on data it was never given", () => {
  it("reports lead_pipeline as needing setup when no snapshot has been pushed", async () => {
    const { db } = stubDb([]);
    const resolved = await resolveRequirements([leadPipelineAgent], env, db);

    const unmet = resolved.get("lead_pipeline") ?? [];
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.requirement.id).toBe("lead_pipeline.pipeline_snapshot");
    expect(unmet[0]?.reason).toContain(STATE_KEYS.pipeline);
    // Non-blocking: it must still run, because running is what files the
    // "no pipeline data to track" report that makes the gap visible at all.
    expect(unmet[0]?.requirement.blocking).toBe(false);
    expect(unmet[0]?.requirement.steps.length).toBeGreaterThan(0);
  });

  it("reports finance_watch the same way, and stops once figures arrive", async () => {
    const empty = await resolveRequirements([financeWatchAgent], env, stubDb([]).db);
    expect(empty.get("finance_watch")).toHaveLength(1);

    const { db } = stubDb([
      {
        key: STATE_KEYS.finance,
        value: { periodStart: "2026-08-01", periodEnd: "2026-08-31", revenueMinor: 14900, clientsServed: 1 },
      },
    ]);
    const connected = await resolveRequirements([financeWatchAgent], env, db);
    expect(connected.get("finance_watch")).toHaveLength(0);
  });

  it("treats a snapshot carrying zero prospects as connected, not as missing", async () => {
    // "Nothing is wired up" and "wired up, no prospects yet" are different
    // sentences, and only the first is a setup step.
    const { db } = stubDb([{ key: STATE_KEYS.pipeline, value: { prospects: [], updatedAt: "2026-09-03" } }]);
    const resolved = await resolveRequirements([leadPipelineAgent], env, db);
    expect(resolved.get("lead_pipeline")).toHaveLength(0);
  });

  it("asks for every feed key in ONE read, whatever the roster size", async () => {
    // The reason check() cannot see the database. A read per agent per tick is
    // the budget that has already killed two agents in this system.
    const { db, asked } = stubDb([]);
    await resolveRequirements([leadPipelineAgent, financeWatchAgent], env, db);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(expect.arrayContaining([STATE_KEYS.pipeline, STATE_KEYS.finance]));
  });

  it("does not paint 'needs setup' across the board when the database is unreachable", async () => {
    const db = { readMemory: vi.fn(async () => { throw new Error("network"); }) } as never;
    const resolved = await resolveRequirements([leadPipelineAgent, financeWatchAgent], env, db);
    expect(resolved.get("lead_pipeline")).toHaveLength(0);
    expect(resolved.get("finance_watch")).toHaveLength(0);
  });

  it("keeps the per-tick check environment-only, so a feed costs nothing to run", () => {
    // unmetRequirements() is what runs before propose() on every tick. It must
    // see no feed and take no read.
    expect(unmetRequirements(leadPipelineAgent, env)).toHaveLength(0);
    expect(unmetRequirements(financeWatchAgent, env)).toHaveLength(0);
  });
});
