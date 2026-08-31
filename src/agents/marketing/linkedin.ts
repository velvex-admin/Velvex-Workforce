// LinkedIn strategist for the Velvex company page.
//
// The architecture doc treated LinkedIn as an external build: an outside
// company was going to deliver the whole agent. The owner overrode that: they
// want a strategist we own, that reads how the page posts, writes for the
// LinkedIn register, and proposes growth plays for their approval.
//
// Publishing is a separate question. We do not have LinkedIn API credentials of
// our own, and the doc's partner integration point still exists. So drafts are
// routed to the partner queue: if the partner is wired up, they publish; if
// not, the draft waits there and publishes when the integration goes live.
// Replacing this with direct posting later is a one-line change (drop the
// route: "linkedin-partner-queue" option).

import { createChannelStrategist } from "./channel-agent.js";
import { ENGLISH_AUDIENCE_WINDOWS_MIDWEEK } from "../../core/schedule.js";
import voiceBaseline from "../../../db/seeds/linkedin-voice.json";

export const linkedInAgent = createChannelStrategist({
  id: "linkedin",
  name: "LinkedIn Strategist",
  channel: "linkedin",
  description:
    "Owns the LinkedIn company page. Reads how it has posted before, drafts LinkedIn-native posts, and proposes growth plays for approval. Publishing is routed to the partner queue.",
  // Three posts a week, jittered inside Tue-Thu windows (13:00-21:00 UTC covers
  // the executive-audience window across the UK and the US). Slot times are
  // picked per ISO week so it never reads as a cron on the hour, but stays
  // stable across worker restarts within the week.
  schedule: {
    channel: "linkedin",
    weeklyPosts: 3,
    windows: ENGLISH_AUDIENCE_WINDOWS_MIDWEEK,
    minGapHours: 24,
  },
  audienceLine:
    "Reactions and comments from operators, allocators and executives. A post that reads as a considered observation gets shared with intent; a post that reads as marketing is scrolled past. The page has 339 followers and single-digit reactions, so reach is not yet a signal about anything: write for the reader, not for the number.",
  platformGuide: `The audience is operators, allocators and executives, not consumers. Write the way an institutional standard writes: declarative, structural, and grounded in a specific mechanism.

THE PAGE ALREADY HAS A VOICE. Match it, then sharpen it. What is published there now, read newest first, is the target:

- It opens on a claim, not a hook. "Operational performance under stable conditions is not the same as structural resilience under concurrent pressure." No question, no "Here is what most founders get wrong", no one-line tease followed by a break.
- It names mechanisms and lets them do the work: concurrent load, interaction points, substitution options, load-bearing dependency, single-axis pressure.
- It distinguishes rather than persuades. The strongest posts turn on one distinction: what an accounting audit records versus what a structural evaluation can tell you; performance under sequential pressure versus performance under simultaneous pressure.
- It closes on the consequence, flat, with nothing after it. No call to action. No "message us". No "let us know in the comments". The last sentence is the point of the post, not a door held open.

Four to five paragraphs, most of them two or three sentences. 900 characters is a natural ceiling. If the thought fits in two paragraphs, use two.

At most ONE hashtag, and only when it genuinely names a category. Never a stack. The page used to end on five or six of them; it does not need to, the writing carries the post, and a stack reads as reach-chasing under a register that is claiming rigour.

Never write a call to action. Never end with a question aimed at driving comments. Both are on older posts on this page and both are the thing to move away from, not toward.

Use the Velvex engine names exactly when naming one. Do not invent variants of them.

British spelling throughout, consistently. The page currently mixes "characterises" with "organization"; pick British and hold it.

Prefer an observation that would still be true if Velvex did not exist. That is what an operator forwards to another operator, and forwarding is the only distribution this page has.

Write for the one reader whose exact structural problem the post names. Precision, not reach.`,
  active: () => true,
  route: "linkedin-partner-queue",
  // Every post on this page waits for the owner to read the exact text. The
  // owner's concern is specific and correct: a company page that reads as
  // automated is not repaired by the agent getting better later, because the
  // posts that taught people to scroll past are still on the page. Approving is
  // what publishes; rejecting takes that draft out of the running for this
  // channel and the next run writes something else.
  approveBeforePublish: true,
  // On this channel the learning layer has a better signal than it has on X.
  // Every post waits for the owner, so every post produces a verdict on the
  // COPY — not on an idea about copy, which is all a growth-idea ruling is.
  //
  // What it still does NOT have is audience data. HAS_AUDIENCE_DATA stays false
  // and the prompt says so in words, because a model handed past posts and asked
  // what worked will always find a pattern, and with no engagement signal that
  // pattern is about nothing. r_organization_social is what changes that, and it
  // arrives with the same Community Management API review as posting does.
  learning: true,
  // The page's own posts, read from the public page on 2026-08-30. Used only
  // until this system has published here itself; see `voiceBaseline` for why it
  // carries the "avoid" half as well as the "write like this" half.
  voiceBaseline,
});
