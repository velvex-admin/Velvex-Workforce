// What this system actually costs to run, recorded rather than estimated.
//
// Every run already computes `result.costUsd` — the runner snapshots the Claude
// client's spend before and after, so the number is real rather than modelled.
// It was then thrown away: nothing persisted it, `usage` was null on every
// report row, and the only way to answer "what am I spending" was arithmetic
// over assumptions. For someone deciding whether $12 of credit lasts a week or
// a quarter, an estimate with that much error in it is not an answer.
//
// So a ledger. One memory row, a day per entry, capped — the same shape as
// every other bounded store here, and for the same reason: a row that only ever
// grows is read back in full by whoever reads it, forever.

import type { Supabase } from "../lib/supabase.js";
import { state } from "./state.js";

export const SPEND_KEY = "spend.ledger";

/**
 * Two months. Long enough to see a month-on-month trend and to answer "when
 * does this credit run out" from real data, short enough that the row stays
 * small. A daily entry is a few dozen bytes.
 */
export const MAX_SPEND_DAYS = 60;

export interface SpendDay {
  /** YYYY-MM-DD, UTC, matching the tick clock rather than anyone's local day. */
  day: string;
  totalUsd: number;
  /** Per agent, so an expensive one is visible without a second source. */
  byAgent: Record<string, number>;
  runs: number;
  modelCalls: number;
}

export interface SpendLedger {
  updatedAt: string;
  days: SpendDay[];
}

const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export function emptyLedger(now: Date): SpendLedger {
  return { updatedAt: now.toISOString(), days: [] };
}

/**
 * Fold one tick's results into the ledger. Pure, so the arithmetic is testable
 * without a database — which matters more here than usual, because a bug in it
 * would be a wrong number presented with the authority of a measurement.
 */
export function recordSpend(
  ledger: SpendLedger,
  entries: Array<{ agentId: string; costUsd: number; modelCalls: number }>,
  now: Date
): SpendLedger {
  const spending = entries.filter((entry) => entry.costUsd > 0);
  if (spending.length === 0) return ledger;

  const day = now.toISOString().slice(0, 10);
  const days = ledger.days.slice();
  let entry = days.find((d) => d.day === day);
  if (!entry) {
    entry = { day, totalUsd: 0, byAgent: {}, runs: 0, modelCalls: 0 };
    days.push(entry);
  }

  for (const run of spending) {
    entry.totalUsd = round(entry.totalUsd + run.costUsd);
    entry.byAgent[run.agentId] = round((entry.byAgent[run.agentId] ?? 0) + run.costUsd);
    entry.runs += 1;
    entry.modelCalls += run.modelCalls;
  }

  days.sort((a, b) => a.day.localeCompare(b.day));
  return { updatedAt: now.toISOString(), days: days.slice(-MAX_SPEND_DAYS) };
}

/**
 * What the ledger says, and what it implies for a balance.
 *
 * The daily average deliberately divides by the number of days ON FILE rather
 * than the number with spending in them. A quiet day is a real day and counting
 * only the expensive ones would flatter the average, which is the wrong error
 * to make when the output is "your credit lasts N days".
 */
export function summarise(
  ledger: SpendLedger,
  now: Date,
  balanceUsd?: number
): {
  today: number;
  last7: number;
  last30: number;
  dailyAverage: number;
  monthlyProjection: number;
  daysOfCreditLeft: number | null;
  runsOutOn: string | null;
  topAgents: Array<{ agentId: string; usd: number }>;
} {
  const day = now.toISOString().slice(0, 10);
  const since = (n: number): SpendDay[] => {
    const cutoff = new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    return ledger.days.filter((d) => d.day > cutoff);
  };

  const sum = (days: SpendDay[]) => round(days.reduce((t, d) => t + d.totalUsd, 0));
  const last7 = sum(since(7));
  const last30 = sum(since(30));

  // Days observed, not days billed. Before there is a week of history this is
  // whatever exists, which is honest: a two-day average IS a two-day average.
  const observed = Math.max(1, Math.min(30, ledger.days.length));
  const dailyAverage = round(last30 / observed);

  const byAgent = new Map<string, number>();
  for (const d of since(30)) {
    for (const [agentId, usd] of Object.entries(d.byAgent)) {
      byAgent.set(agentId, round((byAgent.get(agentId) ?? 0) + usd));
    }
  }

  const daysLeft =
    balanceUsd !== undefined && dailyAverage > 0
      ? Math.floor(balanceUsd / dailyAverage)
      : null;

  return {
    today: ledger.days.find((d) => d.day === day)?.totalUsd ?? 0,
    last7,
    last30,
    dailyAverage,
    monthlyProjection: round(dailyAverage * 30),
    daysOfCreditLeft: daysLeft,
    runsOutOn:
      daysLeft === null
        ? null
        : new Date(now.getTime() + daysLeft * 86_400_000).toISOString().slice(0, 10),
    topAgents: [...byAgent.entries()]
      .map(([agentId, usd]) => ({ agentId, usd }))
      .sort((a, b) => b.usd - a.usd),
  };
}

export async function readLedger(db: Supabase, now: Date): Promise<SpendLedger> {
  const value = await state.read<SpendLedger>(db, SPEND_KEY);
  if (!value || !Array.isArray(value.days)) return emptyLedger(now);
  return value;
}

/**
 * Persist the ledger.
 *
 * Salience 4, below the broadcast floor of 6, for the reason the learning layer
 * is: Growth-Strategy and Chief-of-Staff sweep memory at minSalience 6 with no
 * tag filter, and a spend ledger growing daily in both their prompts is exactly
 * the cost this row exists to measure.
 */
export async function writeLedger(db: Supabase, ledger: SpendLedger): Promise<void> {
  const today = ledger.days[ledger.days.length - 1];
  await state.write(
    db,
    SPEND_KEY,
    ledger,
    today ? `${today.day}: $${today.totalUsd.toFixed(4)} across ${today.runs} run(s)` : "no spend recorded",
    { scope: "global", salience: 4, tags: ["spend"] }
  );
}
