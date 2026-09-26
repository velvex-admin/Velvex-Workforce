// What the dashboard says is wrong, and what is actually wrong, must be the
// same list.
//
// They were not. On 2026-09-03 the board showed three red "failed" dots:
// finance_watch, marketing_analytics and growth_strategy. The reports table
// held exactly three failures in the same window, and all three were already
// fixed in code or were a spend cap doing its job. Not one red dot on the
// canvas corresponded to a live fault, and two of them could never clear,
// because the agents wearing them are paused and a paused agent never runs
// again to correct its own row.
//
// A dashboard that cries wolf is worse than no dashboard: it teaches the owner
// to stop reading red. So these tests execute the real nodeCard against the
// real board rows that were on the live system, rather than asserting that some
// substring appears somewhere in the page — a substring test passes happily on
// the bug it was written for.

import { describe, expect, it } from "vitest";
import { dashboardHtml } from "../src/ui/dashboard.js";

const html = dashboardHtml("/x/test-secret");
const body = html.slice(
  html.lastIndexOf("<script>") + "<script>".length,
  html.lastIndexOf("</script>")
);

/**
 * The source of one top-level function, sliced between its own declaration and
 * the next one. Brace counting would be fooled by the template literals inside
 * these functions; two known anchors cannot be.
 */
function sourceBetween(from: string, to: string): string {
  const start = body.indexOf(from);
  const end = body.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

const helpers = [
  sourceBetween("function lastSignOfLife(rt) {", "function nodeCard(a) {"),
  sourceBetween("function nodeCard(a) {", "function initialsOf(name) {"),
  sourceBetween("function initialsOf(name) {", "function nodeHtml(a"),
].join("\n");

/** Render one agent card with the production code, against a given board. */
function card(
  agent: Record<string, unknown>,
  runtime: Record<string, unknown>,
  schedules: Record<string, unknown> = {}
): string {
  const render = new Function(
    "SCHEDULES",
    "RUNTIME",
    "SELECTED",
    "esc",
    "ago",
    "a",
    `${helpers}\nreturn nodeCard(a);`
  );
  return render(
    schedules,
    runtime,
    null,
    (s: unknown) => String(s ?? ""),
    (iso: unknown) =>
      iso ? `${Math.round((Date.now() - Date.parse(String(iso))) / 86_400_000)}d ago` : "",
    agent
  ) as string;
}

const anAgent = (id: string) => ({
  id,
  name: "Finance Watch",
  batch: "executive",
  cadence: "daily",
  description: "d",
  requirements: [],
});

describe("what the dashboard calls a failure", () => {
  it("does not call a paused agent failed, however its last run ended", () => {
    // finance_watch, exactly as it was on the live board: paused since
    // 2026-08-27, and carrying a `failed` row from a run on 2026-08-26 that
    // nothing can ever replace.
    const html = card(
      anAgent("finance_watch"),
      {
        finance_watch: {
          status: "failed",
          phase: "failed",
          endedAt: "2026-08-29T15:17:00.000Z",
          error: "This run stopped reporting and never recorded an ending.",
        },
      },
      { finance_watch: { cadence: "paused" } }
    );

    expect(html).not.toContain("status-tag failed");
    expect(html).not.toContain("failed-status");
    // Nothing is hidden: the card still says, in its own cadence line, that
    // somebody stopped this agent on purpose.
    expect(html).toContain("paused");
  });

  it("still calls an unpaused agent failed, and says how long ago", () => {
    // growth_strategy is the one red dot that was telling the truth. It must
    // stay red — but "failed" and "failed 4d ago" are different sentences, and
    // only the second one lets the owner tell a live fire from a fixed bug
    // waiting on next Monday's tick.
    const html = card(anAgent("growth_strategy"), {
      growth_strategy: {
        status: "failed",
        phase: "failed",
        endedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
        error: "Ran out of output budget on claude-opus-5 (max_tokens 4000).",
      },
    });

    expect(html).toContain("status-tag failed");
    expect(html).toContain("failed-status");
    expect(html).toContain("4d ago");
  });

  it("does not call a lost ending a failure", () => {
    // reconcileStale closes a row it can prove is not running. It cannot prove
    // the run went badly — the evidence in the one case anybody investigated
    // was that the agent had finished — so the row reads "no ending", in slate,
    // and points at the reports for what the run actually did.
    const html = card(anAgent("marketing_analytics"), {
      marketing_analytics: {
        status: "unknown",
        phase: "unknown",
        endedAt: new Date(Date.now() - 86_400_000).toISOString(),
        error: "This run never recorded an ending.",
      },
    });

    expect(html).toContain("status-tag unknown");
    expect(html).toContain("no ending");
    expect(html).not.toContain("status-tag failed");
    expect(html).not.toContain("failed-status");
  });

  it("lets a blocking requirement outrank both, since it says why", () => {
    // facebook is paused AND blocked. "blocked" carries a reason and a list of
    // steps; "paused" is already on the cadence line. The more informative one
    // wins the badge.
    const html = card(
      { ...anAgent("facebook"), requirements: [{ blocking: true, summary: "no page" }] },
      { facebook: { status: "failed", phase: "failed" } },
      { facebook: { cadence: "paused" } }
    );

    expect(html).toContain("status-tag blocked");
    expect(html).not.toContain("status-tag failed");
  });
});
