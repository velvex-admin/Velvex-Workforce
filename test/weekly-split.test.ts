// The weekly cadence runs on two Monday ticks rather than one.
//
// A cron invocation gets fifteen minutes of wall clock for everything it runs,
// and the agent loop is sequential. Competitive Intelligence measured 10m03s on
// its own, so putting it in front of Growth-Strategy left the second one under
// five minutes. It would not have failed loudly either: a killed agent leaves a
// "running" status row, not an error, so the loss would have been silent.
//
// Splitting a cadence across ticks is only safe if the split is a partition.
// Drop an agent and it silently never runs again; overlap and it runs twice and
// bills twice. Both are asserted here against the real roster, not a fixture.

import { describe, expect, it } from "vitest";
import { AGENTS, agentsDueWith, applyBatchFilter } from "../src/agents/registry.js";
import toml from "../wrangler.toml?raw";
import index from "../src/index.ts?raw";

const WEEKLY_INTEL = "0 8 * * 1";
const WEEKLY_REST = "0 9 * * 1";

const weekly = agentsDueWith("weekly", {});
const intelTick = applyBatchFilter(weekly, { only: ["intelligence"] });
const restTick = applyBatchFilter(weekly, { except: ["intelligence"] });

describe("the two Monday ticks", () => {
  it("between them run every weekly agent, exactly once", () => {
    const ids = [...intelTick, ...restTick].map((a) => a.id).sort();
    expect(ids).toEqual(weekly.map((a) => a.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts the intelligence agent on its own tick", () => {
    expect(intelTick.map((a) => a.id)).toEqual(["competitive_intel"]);
  });

  it("leaves Growth-Strategy on the other one", () => {
    expect(restTick.map((a) => a.id)).toContain("growth_strategy");
    expect(restTick.map((a) => a.id)).not.toContain("competitive_intel");
  });

  it("does not disturb the other cadences", () => {
    // An unfiltered tick still runs everything due, which is what the hourly
    // and daily crons pass.
    expect(applyBatchFilter(weekly, {}).map((a) => a.id).sort()).toEqual(
      weekly.map((a) => a.id).sort()
    );
  });
});

describe("the cron table and the code that reads it", () => {
  // wrangler.toml is the source of truth for triggers, and the handler matches
  // on the literal strings. If one moves without the other, a tick either never
  // fires or fires with the wrong filter, and nothing fails at build time.
  it("declares both Monday triggers", () => {
    expect(toml).toContain(`"${WEEKLY_INTEL}"`);
    expect(toml).toContain(`"${WEEKLY_REST}"`);
  });

  it("routes both of them in the scheduled handler", () => {
    expect(index).toContain(`const WEEKLY_INTEL = "${WEEKLY_INTEL}"`);
    expect(index).toContain(`const WEEKLY_REST = "${WEEKLY_REST}"`);
    expect(index).toContain('{ only: ["intelligence"] }');
    expect(index).toContain('{ except: ["intelligence"] }');
  });
});

describe("what the composing pass is allowed to spend", () => {
  it("runs at high, not max", () => {
    // Measured: at "max" the compose pass alone took 5m32s and $0.64, putting a
    // $1.25-capped run at $1.39 with no room left in the cron window. Raising
    // this again should follow a measurement, not a hunch.
    const intel = AGENTS.find((a) => a.id === "competitive_intel");
    expect(intel?.effort).toBe("high");
  });
});
