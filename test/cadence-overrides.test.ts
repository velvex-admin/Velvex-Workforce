// A schedule override outlives the reason it was set.
//
// Nothing clears one, no redeploy touches it, and a cadence changed in code
// loses to it silently. That is how the Competitive Intelligence agent sat
// paused straight through the change that moved it to a monthly cadence: the
// pause was still correct as a stored value and still wrong as a decision, and
// nothing anywhere said so.
//
// The override still wins — clearing somebody's pause on their behalf is worse
// than leaving it — but it is now visibly stale.

import { describe, expect, it } from "vitest";
import { AGENTS, agentsDueWith, getAgent, staleOverrides } from "../src/agents/registry.js";
import { overrideIsStale, type AgentScheduleMap } from "../src/core/state.js";

const override = (
  cadence: "hourly" | "daily" | "weekly" | "monthly" | "paused",
  builtInCadence?: string
): AgentScheduleMap[string] => ({
  cadence,
  updatedAt: "2026-08-21T12:00:00Z",
  ...(builtInCadence ? { builtInCadence } : {}),
});

describe("monthly is a real cadence", () => {
  it("Competitive Intelligence runs monthly", () => {
    expect(getAgent("competitive_intel")?.cadence).toBe("monthly");
  });

  it("the monthly tick picks it up", () => {
    const due = agentsDueWith("monthly", {}).map((agent) => agent.id);
    expect(due).toContain("competitive_intel");
  });

  it("the weekly tick no longer does", () => {
    const due = agentsDueWith("weekly", {}).map((agent) => agent.id);
    expect(due).not.toContain("competitive_intel");
    // Growth-Strategy still owns the Monday tick.
    expect(due).toContain("growth_strategy");
  });

  it("an override can select it", () => {
    const due = agentsDueWith("monthly", { seo_site: override("monthly") });
    expect(due.map((agent) => agent.id)).toContain("seo_site");
  });

  it("every agent's built-in cadence is one a tick actually carries", () => {
    const dispatched = new Set(["hourly", "daily", "weekly", "monthly", "manual", "external"]);
    for (const agent of AGENTS) {
      expect(dispatched.has(agent.cadence)).toBe(true);
    }
  });
});

describe("a paused override still wins", () => {
  it("excludes the agent from every tick, stale or not", () => {
    const overrides = { competitive_intel: override("paused", "weekly") };
    for (const tick of ["hourly", "daily", "weekly", "monthly"] as const) {
      expect(agentsDueWith(tick, overrides).map((a) => a.id)).not.toContain("competitive_intel");
    }
  });
});

describe("staleness", () => {
  it("is reported when the code cadence has moved since the override was set", () => {
    // Exactly the live state: paused while the cadence in code was weekly, and
    // the cadence in code is now monthly.
    const stale = staleOverrides({ competitive_intel: override("paused", "weekly") });
    expect(stale.map((entry) => entry.agentId)).toEqual(["competitive_intel"]);
    expect(stale[0]!.builtInCadence).toBe("monthly");
  });

  it("is not reported when the code cadence has not moved", () => {
    expect(staleOverrides({ seo_site: override("paused", "daily") })).toEqual([]);
  });

  it("is not claimed for an override with no recorded baseline", () => {
    // Overrides written before the field existed. Not knowing is not evidence.
    expect(staleOverrides({ competitive_intel: override("paused") })).toEqual([]);
    expect(overrideIsStale(undefined, "daily")).toBe(false);
  });
});
