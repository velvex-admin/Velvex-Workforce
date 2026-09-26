// Weekly jittered scheduling. The point of these tests is that the plan is
// deterministic within a week (so the workers agree), varied between weeks (so
// it does not read as automated), and respects the min gap.

import { describe, expect, it } from "vitest";
import {
  ENGLISH_AUDIENCE_WINDOWS_WEEKDAY,
  ENGLISH_AUDIENCE_WINDOWS_MIDWEEK,
  dueSlot,
  isoWeekMonday,
  planWeek,
  type StoredPlan,
} from "../src/core/schedule.js";

const week = (isoDate: string) => isoWeekMonday(new Date(isoDate));

const spec = (channel: string, extra: Partial<Parameters<typeof planWeek>[0]> = {}) => ({
  channel,
  weeklyPosts: 3,
  windows: ENGLISH_AUDIENCE_WINDOWS_WEEKDAY,
  minGapHours: 30,
  ...extra,
});

describe("the weekly posting plan", () => {
  it("picks the requested number of slots", () => {
    expect(planWeek(spec("x"), week("2026-08-19"))).toHaveLength(3);
  });

  it("is deterministic across calls in the same week", () => {
    const a = planWeek(spec("x"), week("2026-08-19"));
    const b = planWeek(spec("x"), week("2026-08-19"));
    expect(a.map((d) => d.toISOString())).toEqual(b.map((d) => d.toISOString()));
  });

  it("varies between weeks so it does not read as a cron pattern", () => {
    const now = planWeek(spec("x"), week("2026-08-19"));
    const later = planWeek(spec("x"), week("2026-08-26"));
    expect(now.map((d) => d.getUTCHours())).not.toEqual(later.map((d) => d.getUTCHours()));
  });

  it("varies between channels in the same week", () => {
    const x = planWeek(spec("x"), week("2026-08-19"));
    const linkedin = planWeek(
      spec("linkedin", { windows: ENGLISH_AUDIENCE_WINDOWS_MIDWEEK }),
      week("2026-08-19")
    );
    expect(x.map((d) => d.toISOString())).not.toEqual(linkedin.map((d) => d.toISOString()));
  });

  it("stays inside the windows it was given", () => {
    const slots = planWeek(spec("x"), week("2026-08-19"));
    for (const slot of slots) {
      const dow = slot.getUTCDay();
      const hour = slot.getUTCHours();
      expect([1, 2, 3, 4, 5]).toContain(dow);
      expect(hour).toBeGreaterThanOrEqual(12);
      expect(hour).toBeLessThan(21);
    }
  });

  it("never plans a slot the publish gate would refuse, across two years of X weeks", () => {
    // The publish pass skips a due slot within minGapHours of the last post.
    // On 2026-09-21 the planner dropped the gap after one greedy pass and put
    // Friday 14:00 nineteen hours after Thursday 19:00, so the slot could only
    // go out at 01:00 Saturday. 30h always fits three weekday posts.
    const offenders: string[] = [];
    const start = week("2026-01-05").getTime();
    for (let w = 0; w < 104; w += 1) {
      const monday = new Date(start + w * 7 * 86_400_000);
      const times = planWeek(spec("x"), monday).map((d) => d.getTime());
      expect(times).toHaveLength(3);
      for (let i = 1; i < times.length; i += 1) {
        if (times[i]! - times[i - 1]! < 30 * 3600_000) offenders.push(monday.toISOString().slice(0, 10));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves a week the first pass could already fill exactly as it was", () => {
    expect(planWeek(spec("x"), week("2026-09-14")).map((d) => d.toISOString())).toEqual([
      "2026-09-14T12:00:00.000Z",
      "2026-09-15T19:00:00.000Z",
      "2026-09-18T17:00:00.000Z",
    ]);
  });

  it("respects the minimum gap when the window is wide enough to allow it", () => {
    // 24h gap fits comfortably in the Mon-Fri window; three posts fit.
    const slots = planWeek(spec("x", { minGapHours: 24 }), week("2026-08-19"));
    const times = slots.map((d) => d.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(24 * 3600_000 - 1);
    }
  });

  it("falls back to filling the plan when the gap cannot be honoured", () => {
    // 60h × 3 posts would need 120h of separation; the window has ~45h in it.
    // The plan should still return three slots rather than fewer.
    const slots = planWeek(spec("x", { minGapHours: 60 }), week("2026-08-19"));
    expect(slots).toHaveLength(3);
  });

  it("never lands on the same hour every week", () => {
    // Look across a month: at least one week should differ from the others.
    const weeks = ["2026-08-19", "2026-08-26", "2026-09-02", "2026-09-09"].map((iso) =>
      planWeek(spec("x"), week(iso))
    );
    const patterns = weeks.map((plan) =>
      plan.map((d) => `${d.getUTCDay()}-${d.getUTCHours()}`).sort().join(",")
    );
    expect(new Set(patterns).size).toBeGreaterThan(1);
  });
});

describe("consuming a slot", () => {
  it("returns the earliest unconsumed slot that has passed", () => {
    const plan: StoredPlan = {
      week: "2026-08-17",
      slots: [
        "2026-08-18T12:00:00.000Z",
        "2026-08-20T15:00:00.000Z",
        "2026-08-21T18:00:00.000Z",
      ],
      consumed: [],
    };
    expect(dueSlot(plan, new Date("2026-08-18T13:00:00Z")))
      .toBe("2026-08-18T12:00:00.000Z");
  });

  it("skips slots that are already consumed", () => {
    const plan: StoredPlan = {
      week: "2026-08-17",
      slots: [
        "2026-08-18T12:00:00.000Z",
        "2026-08-20T15:00:00.000Z",
      ],
      consumed: ["2026-08-18T12:00:00.000Z"],
    };
    expect(dueSlot(plan, new Date("2026-08-20T16:00:00Z")))
      .toBe("2026-08-20T15:00:00.000Z");
  });

  it("returns null when nothing has come due yet", () => {
    const plan: StoredPlan = {
      week: "2026-08-17",
      slots: ["2026-08-20T15:00:00.000Z"],
      consumed: [],
    };
    expect(dueSlot(plan, new Date("2026-08-18T13:00:00Z"))).toBeNull();
  });
});
