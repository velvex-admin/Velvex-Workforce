// Weekly jittered posting schedule.
//
// The owner wants three posts a week per channel, without the pattern reading
// as "cron on the hour". So each channel picks its own three slots at the
// start of the ISO week, randomised within windows tuned to English-speaking
// audiences (roughly UK afternoon through US morning-to-midday). The plan is
// stored in the memory table under a stable key, so every worker sees the same
// slots regardless of which one wakes for the tick.
//
// This lives away from the strategist itself so it stays testable in isolation.

import type { Supabase } from "../lib/supabase.js";

export interface PostingWindow {
  /** Days of week the window covers, 0 = Sunday. */
  days: number[];
  /** UTC hour (0-23) the window opens, inclusive. */
  startHourUTC: number;
  /** UTC hour (0-23) the window closes, exclusive. */
  endHourUTC: number;
}

export interface WeeklyPlanSpec {
  channel: string;
  weeklyPosts: number;
  windows: PostingWindow[];
  /** Minimum hours between two posts, so three per week do not clump. */
  minGapHours: number;
}

/**
 * Default set of windows for an English-speaking audience: weekday mid-day UTC
 * through evening covers UK afternoon and US morning-to-lunch. LinkedIn uses
 * only Tue-Thu; X allows the full weekday range.
 */
export const ENGLISH_AUDIENCE_WINDOWS_WEEKDAY: PostingWindow[] = [
  { days: [1, 2, 3, 4, 5], startHourUTC: 12, endHourUTC: 21 },
];

export const ENGLISH_AUDIENCE_WINDOWS_MIDWEEK: PostingWindow[] = [
  { days: [2, 3, 4], startHourUTC: 13, endHourUTC: 21 },
];

/** ISO week number: 1-53, aligned to Monday start. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** UTC datetime of Monday 00:00 for the ISO week that contains `date`. */
export function isoWeekMonday(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Deterministic seeded PRNG (mulberry32). Same channel + ISO week always yields
 * the same plan, so a re-run does not reshuffle a week half-published.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** All hourly candidate timestamps (Date) inside the windows for this week. */
function candidateSlots(spec: WeeklyPlanSpec, weekStart: Date): Date[] {
  const out: Date[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(weekStart);
    day.setUTCDate(day.getUTCDate() + offset);
    const dow = day.getUTCDay();
    for (const window of spec.windows) {
      if (!window.days.includes(dow)) continue;
      for (let hour = window.startHourUTC; hour < window.endHourUTC; hour += 1) {
        const slot = new Date(day);
        slot.setUTCHours(hour, 0, 0, 0);
        out.push(slot);
      }
    }
  }
  return out;
}

/**
 * Pick `weeklyPosts` random slots this week, respecting the minimum gap and the
 * spec's windows. Pure and deterministic; the seed is (channel + ISO week).
 */
export function planWeek(spec: WeeklyPlanSpec, weekStart: Date): Date[] {
  const seed = hashString(`${spec.channel}:${weekStart.toISOString().slice(0, 10)}`);
  const random = rng(seed);
  const candidates = candidateSlots(spec, weekStart);
  const chosen: Date[] = [];

  // Fisher-Yates through candidates; accept a slot when it clears the gap.
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const gapMs = spec.minGapHours * 3600_000;
  for (const slot of shuffled) {
    if (chosen.length >= spec.weeklyPosts) break;
    const tooClose = chosen.some((other) => Math.abs(other.getTime() - slot.getTime()) < gapMs);
    if (!tooClose) chosen.push(slot);
  }

  // Fallback: if gaps prevent hitting the target, drop the gap and take the top
  // remaining, so a very sparse windows spec still produces the target count.
  if (chosen.length < spec.weeklyPosts) {
    for (const slot of shuffled) {
      if (chosen.length >= spec.weeklyPosts) break;
      if (!chosen.includes(slot)) chosen.push(slot);
    }
  }

  return chosen.sort((a, b) => a.getTime() - b.getTime());
}

export interface StoredPlan {
  week: string; // ISO date of the Monday
  slots: string[]; // ISO datetimes
  consumed: string[]; // slots we have already posted for
}

export function planKey(channel: string): string {
  return `schedule.plan.${channel}`;
}

/** Reads or generates the plan for the ISO week containing `now`. */
export async function ensureWeeklyPlan(
  db: Supabase,
  spec: WeeklyPlanSpec,
  now: Date
): Promise<StoredPlan> {
  const monday = isoWeekMonday(now);
  const key = planKey(spec.channel);

  const rows = await db.readMemory({ keys: [key], limit: 1 });
  const detail = rows[0]?.detail as { value?: StoredPlan } | undefined;
  const existing = detail?.value;

  if (existing && existing.week === monday.toISOString().slice(0, 10)) {
    return existing;
  }

  const plan: StoredPlan = {
    week: monday.toISOString().slice(0, 10),
    slots: planWeek(spec, monday).map((slot) => slot.toISOString()),
    consumed: [],
  };

  await db.writeMemory({
    key,
    scope: spec.channel,
    kind: "pattern",
    content: `${spec.channel} weekly plan: ${plan.slots.map((s) => s.slice(0, 16)).join(", ")}`,
    detail: { value: plan },
    salience: 5,
    source_agent: spec.channel,
    tags: [spec.channel, "schedule"],
  });

  return plan;
}

/**
 * Returns the earliest slot in `plan` that has passed and has not been marked
 * consumed. When one is returned the caller should call `markSlotConsumed`
 * after publishing, so the same slot does not fire twice.
 */
export function dueSlot(plan: StoredPlan, now: Date): string | null {
  const consumed = new Set(plan.consumed);
  for (const slot of plan.slots) {
    if (consumed.has(slot)) continue;
    if (new Date(slot).getTime() <= now.getTime()) return slot;
  }
  return null;
}

export async function markSlotConsumed(
  db: Supabase,
  spec: WeeklyPlanSpec,
  slot: string,
  plan: StoredPlan
): Promise<void> {
  const updated: StoredPlan = {
    ...plan,
    consumed: [...new Set([...plan.consumed, slot])],
  };
  await db.writeMemory({
    key: planKey(spec.channel),
    scope: spec.channel,
    kind: "pattern",
    content: `${spec.channel} weekly plan: ${plan.slots.map((s) => s.slice(0, 16)).join(", ")}`,
    detail: { value: updated },
    salience: 5,
    source_agent: spec.channel,
    tags: [spec.channel, "schedule"],
  });
}
