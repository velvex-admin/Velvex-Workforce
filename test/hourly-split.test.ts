// The hourly tick is split for the same reason the weekly one is, against a
// different limit.
//
// The weekly split exists because an invocation gets fifteen minutes of WALL
// CLOCK for everything it runs. This one exists because it also gets roughly
// fifty SUBREQUESTS for everything it runs, and Site-Integrity is last in the
// hourly loop and the heaviest thing in it: it fetches every stored page. So it
// is the agent that discovers the budget is already spent.
//
// It died exactly that way on consecutive hourly ticks on 2026-08-29 — one log
// line and then nothing, no findings, no restore-point promotion, no error —
// while the same agent, run alone in its own invocation, finished in seconds and
// promoted the restore point. Guarding the failure report (see
// test/failure-reporting.test.ts) makes that failure visible. It does not raise
// the ceiling. Its own slot does.
//
// A split is only safe if it is a partition. Drop the agent from one tick
// without adding it to the other and it silently never runs again, which for
// this particular agent means auto-restore quietly stops being armed. Put it in
// both and it runs twice an hour. Both are asserted here against the real
// roster, not a fixture.

import { describe, expect, it } from "vitest";
import { AGENTS, agentsDueWith, applyBatchFilter } from "../src/agents/registry.js";
import toml from "../wrangler.toml?raw";
import index from "../src/index.ts?raw";

const HOURLY_MAIN = "0 * * * *";
const HOURLY_INTEGRITY = "30 * * * *";

const hourly = agentsDueWith("hourly", {});
const mainTick = applyBatchFilter(hourly, { exceptAgents: ["site_integrity"] });
const integrityTick = applyBatchFilter(hourly, { onlyAgents: ["site_integrity"] });

describe("the two hourly ticks", () => {
  it("between them run every hourly agent, exactly once", () => {
    const ids = [...mainTick, ...integrityTick].map((a) => a.id).sort();
    expect(ids).toEqual(hourly.map((a) => a.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives site_integrity the :30 slot to itself", () => {
    expect(integrityTick.map((a) => a.id)).toEqual(["site_integrity"]);
  });

  it("keeps it off the main tick, which is what frees the budget", () => {
    expect(mainTick.map((a) => a.id)).not.toContain("site_integrity");
    // And the main tick still has real work, so this is a split rather than a
    // move of everything onto one line.
    expect(mainTick.length).toBeGreaterThan(0);
  });

  it("still runs it hourly, because auto-restore arms on a clean hourly pass", () => {
    // Its cadence in code must stay hourly. Moving the cron without this is how
    // the restore point would start advancing once a day instead.
    const integrity = AGENTS.find((a) => a.id === "site_integrity");
    expect(integrity?.cadence).toBe("hourly");
  });

  it("does not disturb an unfiltered tick", () => {
    expect(applyBatchFilter(hourly, {}).map((a) => a.id).sort()).toEqual(
      hourly.map((a) => a.id).sort()
    );
  });
});

describe("the cron table and the code that reads it", () => {
  // wrangler.toml is the source of truth for triggers and the handler matches on
  // the literal strings. If one moves without the other, a tick either never
  // fires or fires with the wrong filter, and nothing fails at build time.
  it("declares both hourly triggers", () => {
    expect(toml).toContain(`"${HOURLY_MAIN}"`);
    expect(toml).toContain(`"${HOURLY_INTEGRITY}"`);
  });

  it("routes both of them in the scheduled handler", () => {
    expect(index).toContain(`const HOURLY_MAIN = "${HOURLY_MAIN}"`);
    expect(index).toContain(`const HOURLY_INTEGRITY = "${HOURLY_INTEGRITY}"`);
    expect(index).toContain('{ onlyAgents: ["site_integrity"] }');
    expect(index).toContain('{ exceptAgents: ["site_integrity"] }');
  });

  it("resolves the :30 tick to the hourly cadence by falling through", () => {
    // The cadence ladder names MONTHLY, the two weekly crons and the daily one,
    // and everything else falls through to "hourly". That is what makes the :30
    // tick hourly without a branch of its own. So HOURLY_INTEGRITY must be
    // tested in exactly ONE place: the filter. A second test of it would mean
    // somebody gave it a cadence branch, and site_integrity — whose cadence in
    // code is hourly — would then be due on nothing at all, forever, silently.
    const mentions = index.match(/event\.cron === HOURLY_INTEGRITY/g) ?? [];
    expect(mentions).toHaveLength(1);
  });
});
