// The ideation freeze.
//
// Owner's instruction, 2026-09-15: "freeze the ideation level for 14 days...
// we have more ideas than posts and no way to know which is working and which
// is not."
//
// The numbers behind it, measured over 2026-08-30 to 2026-09-15:
//
//   28 growth ideas approved (`campaign_direction`)
//    8 posts actually published
//
// and, from the whole queue since 2026-08-21, 55 approved growth ideas against
// one queued publish. So the shelf of "things we would try" grows about three
// and a half times faster than the shelf of things we actually did, and with no
// audience data anywhere in this system (X read is 402 on the free tier,
// LinkedIn analytics need an API review that has not happened) not one of those
// 55 has ever been scored. Generating more of them is not a strategy, it is a
// backlog that costs Opus tokens to produce and owner attention to rule on.
//
// So the strategists keep drafting and keep publishing on schedule. What stops
// is proposing NEW directions until the ones already approved have been tried.

/**
 * Why this is two dates in the source rather than a row in `memory`.
 *
 * A freeze is a control, and section 10 records what happens when a control
 * lives behind a database read: `runDue` read the schedule overrides with
 * `.catch(() => ({}))`, Supabase started answering 504, and every paused agent
 * woke up and ran. A freeze stored in `memory` has exactly that shape — one
 * timed-out read and the thing the owner asked for silently stops applying, on
 * the tick where nobody is watching. Dates compiled into the bundle cannot be
 * lifted by a database failure, cost no subrequest from a budget that has
 * already killed two agents here, and are checkable in a test.
 *
 * And it EXPIRES ON ITS OWN. That is the half that matters more than the
 * mechanism. A pause that needs somebody to remember to clear it becomes
 * permanent: `seo_site` carries a note naming an exit condition that was met
 * days before anyone looked, and `finance_watch` has been paused since 27
 * August for a reason nobody wrote down. The owner asked for fourteen days, so
 * fourteen days is what this is — after `UNTIL` it is inert, and deleting it is
 * tidying rather than a decision anybody has to make.
 */
export const IDEATION_FREEZE = {
  /** Inclusive. The day the owner gave the instruction. */
  from: "2026-09-15",
  /**
   * Exclusive. `from` + 14 days.
   *
   * If the deploy carrying this lands later than `from`, the window is shorter
   * rather than shifted, which is the honest reading of "I will do it now".
   */
  until: "2026-09-29",
  reason:
    "The owner froze new growth ideas for 14 days on 2026-09-15. Over the fortnight before it, " +
    "28 growth ideas were approved against 8 posts published, and no post this system has ever " +
    "made has reported an impression back, so none of those ideas has been scored. Until " +
    "2026-09-29 the job is to work the directions already approved, not to add to them.",
} as const;

export interface IdeationFreeze {
  reason: string;
  /** The day it lifts, so a prompt or a dashboard can say when rather than that. */
  until: string;
  /** Whole days remaining, rounded up. 1 on the last day, never 0 while frozen. */
  daysLeft: number;
}

/**
 * The freeze in force at `now`, or null.
 *
 * Compared as ISO dates rather than by parsing into `Date` arithmetic: the
 * boundaries are calendar days in UTC, which is the clock every cron line in
 * this system already runs on, and a string compare cannot drift by an hour.
 */
export function ideationFreeze(now: Date): IdeationFreeze | null {
  const today = now.toISOString().slice(0, 10);
  if (today < IDEATION_FREEZE.from) return null;
  if (today >= IDEATION_FREEZE.until) return null;

  const endMs = Date.parse(`${IDEATION_FREEZE.until}T00:00:00Z`);
  const daysLeft = Math.max(1, Math.ceil((endMs - now.getTime()) / 86400_000));

  return { reason: IDEATION_FREEZE.reason, until: IDEATION_FREEZE.until, daysLeft };
}
