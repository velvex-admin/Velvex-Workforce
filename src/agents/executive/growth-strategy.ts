// Growth-Strategy Agent — Executive. CMO-style.
//
// Doc: reads the marketing and sales agents' reports and proposes strategy
// shifts — the one place where marketing and sales performance get looked at
// together instead of separately.
//
//   Routine        advisory only — proposes, never acts
//   Needs approval everything it proposes, by definition
//
// So this agent has an empty routine set on purpose. Every proposal it makes
// goes to the queue, caught by an explicit rule rather than by the default, so
// the reason recorded on each queued item says why rather than "no rule
// matched".

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";

import { MODELS } from "../../core/models.js";
import { BUSINESS_CONTEXT } from "../../core/business.js";
import { STATE_KEYS, state } from "../../core/state.js";
import { ideationFreeze } from "../../core/ideation.js";

const MODEL = MODELS.reasoning;

const SYSTEM = `You are the growth strategist for Velvex. You are the only place where marketing performance and sales pipeline performance are read together.

${BUSINESS_CONTEXT}

You are given the last two weeks of agent reports, the standing notes, and the newest competitive intelligence brief if there is one. Propose at most three strategy shifts. For each one:

- Name the shift in a sentence.
- Say what in the data made you propose it. Quote the actual figure. If the data is too thin to support a shift, say that instead of proposing one.
- Say what you would expect to change, and by when.

Where a shift is prompted by the intelligence brief rather than by our own numbers, say so, and say which of the two you would trust more if they disagreed. Category movement and our own performance are different kinds of evidence.

If the owner has written notes back to you, they are the highest-ranking thing in this prompt. They outrank the reports, the standing notes and the brief, and where a note contradicts what the data appears to show, the note is right and the data is being misread. The owner is describing their own business from inside it; you are inferring it from activity logs. Say plainly when a note has changed your reading, and never repeat a conclusion a note has already corrected.

Nothing you propose happens without the owner approving it, so be direct rather than hedged. No em dashes. No filler.`;

/**
 * How many of the owner's notes to carry, newest first.
 *
 * Bounded for the reason section 12c bounds carried questions: an additive
 * memory costs more every cycle and grows more confident while it does it.
 * Five is roughly a quarter of a year at this agent's weekly cadence, which is
 * long enough that a standing fact is still in front of the model and short
 * enough that a note about a channel that has since changed falls out.
 */
const MAX_OWNER_NOTES = 5;

interface OwnerNote {
  at: string;
  about: string;
  text: string;
}

/**
 * What the owner wrote in the note box when they ruled on this agent's
 * recommendations.
 *
 * This existed and nothing read it. `decision_note` is written by
 * `POST /api/approvals/:id/(approve|reject)` and, before this, exactly one
 * agent in the system ever read it back: competitive-intel, and only for
 * candidate rejections. So the owner had been answering a weekly strategy memo
 * into a field with no reader. Measured on 2026-09-15, two notes were sitting
 * there:
 *
 *   2026-09-04  "LinkedIn is currently paused as it still needs proper set-up
 *                and the same goes to Facebook. The only operational channel is
 *                X. If you also noticed any sales we have done they were only
 *                tests not real sales..."
 *   2026-09-15  "LinkedIn will be paused for 30 days minimum... We have not
 *                filled any seats from the first 10 clients offer..."
 *
 * The first one is the shape of the cost. The agent had read fourteen sales
 * entries and reasoned about conversion from them; the owner replied that they
 * were tests, not sales; and the next run read the same fourteen rows and made
 * the same mistake, because the correction was never anywhere it could see.
 *
 * Failures here are swallowed. A note is context, and an agent that refuses to
 * think because it could not read one is worse than one that thinks without it
 * — which is the permissive direction, and it is the safe one HERE for the
 * reason section 10 gives: the empty value means "the owner has said nothing",
 * and an agent proposing a strategy shift the owner then declines costs a
 * rejection, not a publish, a deploy or a dollar.
 */
async function ownerNotes(ctx: RunContext): Promise<OwnerNote[]> {
  const rows = await ctx.db
    .listApprovals("all", 40, "growth_strategy")
    .catch(() => []);

  return rows
    .filter((row) => (row.decision_note ?? "").trim().length > 0)
    .sort((a, b) => ((a.decided_at ?? "") < (b.decided_at ?? "") ? 1 : -1))
    .slice(0, MAX_OWNER_NOTES)
    .map((row) => ({
      at: (row.decided_at ?? row.created_at ?? "").slice(0, 10),
      about: row.title ?? "(untitled)",
      text: (row.decision_note ?? "").trim(),
    }));
}

export const growthStrategyAgent: AgentDefinition = {
  id: "growth_strategy",
  name: "Growth-Strategy Agent",
  batch: "executive",
  description:
    "Reads the marketing and sales reports together and proposes strategy shifts. Advisory only: everything it proposes needs approval by definition.",
  // Weekly, and its entire output is a judgement read across two departments at
  // once. Four calls a month is the cheapest place in the system to buy depth.
  model: MODEL,
  effort: "max",
  cadence: "weekly",
  approvedChannels: ["internal"],

  // Empty by design. See the approval rule below.
  routineRules: [],

  approvalRules: [
    {
      id: "growth_strategy.everything_it_proposes",
      describe: "Everything this agent proposes needs approval, by definition.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) =>
        `Growth-Strategy is advisory: it proposes, it never acts. "${action.type}" goes to you by definition.`,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const since = new Date(ctx.now.getTime() - 14 * 86400_000).toISOString();

    const marketing = await ctx.db.listReports({ batch: "marketing", limit: 120 });
    const sales = await ctx.db.listReports({ batch: "sales_management", limit: 80 });
    const memory = await ctx.db.readMemory({ minSalience: 6, limit: 30 });
    const ownersNotes = await ownerNotes(ctx);

    // Logged because the owner asked the question directly: "I am putting
    // optional notes... and am not sure if it reads them". A trail line naming
    // the date of the newest note is a checkable answer on the dashboard,
    // where the question was asked. Silence would have been the old behaviour.
    ctx.log(
      ownersNotes.length === 0
        ? "no notes from the owner on file"
        : `read ${ownersNotes.length} note(s) from the owner, newest ${ownersNotes[0]!.at}`,
      { notes: ownersNotes.map((note) => note.at) }
    );

    // The newest intelligence brief, as a pointer rather than the document: the
    // whole brief is in intel_briefs and reading it here would put several pages
    // of category research into a prompt that is about our own numbers. The
    // headline and the gaps are what a strategist needs to know it exists.
    const intel = await state
      .read<{ briefDate: string; title: string; headline: string; gaps: string[] }>(
        ctx.db,
        STATE_KEYS.intelLatest
      )
      .catch(() => null);

    const inWindow = (row: { created_at?: string | null }) => (row.created_at ?? "") >= since;
    const marketingWindow = marketing.filter(inWindow);
    const salesWindow = sales.filter(inWindow);
    const window = [...marketingWindow, ...salesWindow];

    if (window.length === 0) {
      return [
        {
          type: "observation",
          summary: "Not enough activity yet to propose a strategy shift",
          payload: {
            note: "Two weeks of marketing and sales reports are needed before this is worth reading.",
          },
          dedupeKey: `growth:thin:${ctx.now.toISOString().slice(0, 10)}`,
        },
      ];
    }

    const activity = window
      .map((row) => `- [${row.agent_id}] ${row.summary} (${row.outcome})`)
      .join("\n");
    const notes = memory.map((row) => `- ${row.key}: ${row.content}`).join("\n");
    const category = intel
      ? `Newest competitive intelligence brief (${intel.briefDate}): ${intel.title}\n${intel.headline}\n` +
        `Positioning gaps it named:\n${(intel.gaps ?? []).map((gap) => `- ${gap}`).join("\n") || "- (none)"}`
      : "(no competitive intelligence brief has been filed yet)";

    // What this read CANNOT see, said out loud.
    //
    // The window is never empty in practice — fifteen agents file reports and
    // most of them are about their own activity — so counting entries answers
    // "did anything happen" and not "is there anything to learn from". This
    // agent's whole premise is reading marketing and sales together, and with
    // sales empty it is reading one department while being told it is reading
    // two. A strategist handed only activity logs will find a pattern in them,
    // because that is what it is for; naming the gap is what lets it decline.
    const blindSpots: string[] = [];
    if (salesWindow.length === 0) {
      blindSpots.push(
        "There are no sales or pipeline reports at all in this window, so nothing below is evidence about conversion, " +
          "lead quality or pipeline movement. Do not infer any of those. This is marketing activity read on its own."
      );
    }
    blindSpots.push(
      "No audience response data exists anywhere in this system yet: the X read endpoints are not on a paid tier and " +
        "LinkedIn analytics need an API review that has not happened. A report saying a post was published is not " +
        "evidence that it was read. Treat published counts as effort, never as performance."
    );

    // Highest-ranking block in the prompt, and placed FIRST for that reason:
    // this is the owner correcting the agent in their own words, and the two
    // notes on file are both corrections of things the reports made it believe.
    const fromOwner =
      ownersNotes.length === 0
        ? "(the owner has not written anything back yet)"
        : ownersNotes
            .map(
              (note) =>
                `- ${note.at}, ruling on "${note.about}":\n  "${note.text}"`
            )
            .join("\n");

    // The freeze is the owner's instruction too, and it changes what a useful
    // answer looks like this fortnight rather than merely informing it.
    const freeze = ideationFreeze(ctx.now);
    if (freeze) {
      ctx.log(`new growth ideas are frozen until ${freeze.until}`, {
        daysLeft: freeze.daysLeft,
      });
    }
    const freezeLine = freeze
      ? `NEW GROWTH IDEAS ARE FROZEN until ${freeze.until} (${freeze.daysLeft} day(s) left).\n${freeze.reason}\n` +
        `The channel strategists have stopped proposing them and will keep drafting and publishing on their existing slots. ` +
        `So do not propose new campaigns, new formats, new series or new channels this run. What is useful instead: read the ` +
        `directions already approved and say which of them is actually being carried out, which has quietly lapsed, and what ` +
        `would have to be true to tell whether any of them worked. A shift that reduces the number of open directions counts ` +
        `as a shift.`
      : "";

    const analysis = await ctx.claude.complete({
      system: SYSTEM,
      user:
        `What the owner has told you, newest first. This outranks everything below it:\n${fromOwner}\n\n` +
        (freezeLine ? `${freezeLine}\n\n` : "") +
        `Marketing and sales activity, last 14 days (${window.length} entries: ` +
        `${marketingWindow.length} marketing, ${salesWindow.length} sales):\n${activity}\n\n` +
        `What this read cannot see:\n${blindSpots.map((line) => `- ${line}`).join("\n")}\n\n` +
        `Standing notes and figures:\n${notes || "(none)"}\n\n` +
        `Category read:\n${category}`,
      model: MODEL,
      effort: growthStrategyAgent.effort,
      // 4000 failed in production: "Ran out of output budget on claude-opus-5".
      // max_tokens covers THINKING as well as the answer on this generation, and
      // this is Opus reading fourteen days of activity and writing a strategy
      // memo. max_tokens is a ceiling rather than a spend, so raising it costs
      // nothing unless the tokens are generated.
      //
      // 16000 was the repair for that failure and was never proven, because
      // this agent is WEEKLY and has not had a turn since. That is the argument
      // for the larger number rather than against it: one truncation costs a
      // whole week, the largest pass in this system is budgeted at 32000 (the
      // intelligence agent's, at effort "high" since it was measured), and the
      // untaken half of a ceiling is free. Note that this is the ONLY call in
      // the system running at effort "max", so it has no sibling to copy.
      //
      // 64000 since 2026-09-24, when the reasoning tier moved to Opus 5.5.
      // At the same effort level Opus 5.5 thinks MORE per turn than Opus 5,
      // most of all at max, so a budget sized on Opus 5 is spent sooner. The
      // model allows 128K and every call is streamed, so the ceiling has room.
      maxTokens: 64000,
    });

    return [
      {
        type: "recommendation",
        summary: `Strategy read, week of ${ctx.now.toISOString().slice(0, 10)}`,
        payload: {
          analysis: analysis.text,
          reportsConsidered: window.length,
          marketingReports: marketingWindow.length,
          salesReports: salesWindow.length,
          windowDays: 14,
          intelBriefDate: intel?.briefDate ?? null,
          // So a later run, and the owner, can tell whether a given memo was
          // written with a note in front of it or before one existed.
          ownerNotesRead: ownersNotes.length,
          ideationFrozenUntil: freeze?.until ?? null,
        },
        rationale: `Read across ${marketing.length} marketing and ${sales.length} sales reports together.`,
        dedupeKey: `growth:${ctx.now.toISOString().slice(0, 10)}`,
      },
    ];
  },

  /**
   * Only ever reached after you approve the recommendation, and even then all
   * it does is record it: acting on a strategy shift is work for the agents
   * that own those channels, under their own rules.
   */
  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    await ctx.db.writeMemory({
      key: `strategy.${ctx.now.toISOString().slice(0, 10)}`,
      scope: "growth_strategy",
      kind: "decision",
      content: action.summary,
      detail: action.payload,
      salience: 9,
      source_agent: "growth_strategy",
      tags: ["strategy"],
    });

    return {
      outcome: "executed",
      detail: {
        note: "Recorded as an approved strategy direction. Carrying it out stays with the agents that own those channels.",
      },
    };
  },
};
