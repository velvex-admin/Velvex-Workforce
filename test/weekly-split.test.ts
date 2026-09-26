// The weekly cadence ran on two Monday ticks. It does not any more, and the
// reason is a hard platform ceiling rather than a change of mind.
//
// Workers Free allows FIVE cron triggers per ACCOUNT — not per Worker, not per
// day. Site-Integrity needed one of its own (see test/hourly-split.test.ts), so
// a line had to be given up, and the 08:00 Monday line was the one that was
// costing without earning: it was filtered to the intelligence batch, and
// intelligence has been monthly since the cost measurement, so it fired every
// Monday and ran nothing at all.
//
// What that trades away is real and is asserted here. Intelligence being monthly
// is now LOAD-BEARING: set it back to weekly and it shares fifteen minutes with
// Growth-Strategy, which is the squeeze the split existed to prevent. So the
// weekly tick is deliberately unfiltered — a filter here is how a weekly agent
// silently never runs — and runDue says so out loud when intelligence lands on
// it, because the failure mode is an agent killed with a "running" row and no
// error anywhere.

import { describe, expect, it } from "vitest";
import { AGENTS, agentsDueWith, applyBatchFilter } from "../src/agents/registry.js";
import toml from "../wrangler.toml?raw";
import index from "../src/index.ts?raw";

const WEEKLY = "0 9 * * 1";
const MONTHLY = "0 8 1 * *";
const RETIRED_WEEKLY_INTEL = "0 8 * * 1";

const weekly = agentsDueWith("weekly", {});

describe("the single Monday tick", () => {
  it("runs every weekly agent, because a filter here would hide one", () => {
    expect(applyBatchFilter(weekly, {}).map((a) => a.id).sort()).toEqual(
      weekly.map((a) => a.id).sort()
    );
  });

  it("carries Growth-Strategy", () => {
    expect(weekly.map((a) => a.id)).toContain("growth_strategy");
  });

  it("picks up intelligence too if it is ever set back to weekly", () => {
    // The old 08:00 tick is gone, so this is the ONLY tick that could run it.
    // If this ever stopped being true, setting the cadence back to weekly would
    // mean the agent simply never runs, with nothing saying so.
    const overridden = agentsDueWith("weekly", {
      competitive_intel: { cadence: "weekly", updatedAt: "2026-08-28T00:00:00Z" },
    });
    expect(applyBatchFilter(overridden, {}).map((a) => a.id)).toContain("competitive_intel");
  });

  it("keeps intelligence ordered before Growth-Strategy on the roster", () => {
    // Registry order decides which brief Growth-Strategy reads. It mattered when
    // they were an hour apart and it matters more now they share a tick.
    const ids = AGENTS.map((a) => a.id);
    expect(ids.indexOf("competitive_intel")).toBeLessThan(ids.indexOf("growth_strategy"));
  });
});

describe("the cron table and the code that reads it", () => {
  it("declares the one Monday trigger and no longer the retired one", () => {
    expect(toml).toContain(`"${WEEKLY}"`);
    expect(toml).not.toContain(`"${RETIRED_WEEKLY_INTEL}"`);
  });

  it("routes it in the scheduled handler, unfiltered", () => {
    expect(index).toContain(`const WEEKLY = "${WEEKLY}"`);
    expect(index).not.toContain('{ only: ["intelligence"] }');
    expect(index).not.toContain('{ except: ["intelligence"] }');
  });

  it("stays inside the account's five cron triggers", () => {
    // Workers Free allows five per ACCOUNT. A sixth is refused with code 10072,
    // and — this is the part that cost eighteen hours of site_integrity not
    // running — the refusal does NOT roll back the script upload. So the new
    // code goes live against the old cron table, and any agent the code moved to
    // a schedule that was never created simply stops running, with no error.
    //
    // Counting them here is the only cheap place this is catchable.
    const crons = [...toml.matchAll(/^\s*"([^"]+)",?\s*(?:#.*)?$/gm)]
      .map((m) => m[1]!)
      .filter((line) => /^[\d*\/,\- ]+$/.test(line) && line.split(" ").length === 5);
    expect(crons.length).toBeLessThanOrEqual(5);
    expect(crons).toContain("0 * * * *");
    expect(crons).toContain("30 * * * *");
    expect(crons).toContain(WEEKLY);
    expect(crons).toContain(MONTHLY);
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

describe("the monthly tick", () => {
  // The category has few competitors and moves quarterly at most, so a weekly
  // brief was paying full price to report that nothing changed. That cost
  // argument is now also a scheduling one: monthly is what keeps intelligence
  // off the weekly tick, and off it is what keeps Growth-Strategy alive.
  const monthly = agentsDueWith("monthly", {});

  it("is where the intelligence agent runs by default", () => {
    expect(monthly.map((a) => a.id)).toContain("competitive_intel");
    const intel = AGENTS.find((a) => a.id === "competitive_intel");
    expect(intel?.cadence).toBe("monthly");
  });

  it("runs every monthly agent, because a filter here would hide a future one", () => {
    expect(applyBatchFilter(monthly, {}).map((a) => a.id).sort()).toEqual(
      monthly.map((a) => a.id).sort()
    );
    expect(index).toContain('const MONTHLY = "0 8 1 * *"');
    expect(toml).toContain('"0 8 1 * *"');
  });

  it("does not also fire on the weekly tick", () => {
    // A monthly agent picked up weekly runs four times a month and bills for it.
    expect(weekly.map((a) => a.id)).not.toContain("competitive_intel");
  });
});
