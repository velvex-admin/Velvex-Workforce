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
    "Reactions and comments from operators, allocators and executives. A post that reads as a considered observation gets shared with intent; a post that reads as marketing is scrolled past.",
  platformGuide: `The LinkedIn company page audience is operators and allocators, not consumers. Write the way an institutional standard writes: declarative, structural, and grounded in a specific mechanism, not aphorisms.

Longer than X is allowed; longer than needed is not. 900 characters is a natural upper bound; five short paragraphs is often the shape. If a thought fits in two paragraphs, use two.

No "excited to share", no numbered "here's what I learned" lists, no motivational close. No hashtag stacks. One trailing hashtag naming a category is acceptable if it is genuinely categorising.

Prefer observations that would still be true if Velvex did not exist. That is what gets reshared.

The page grows when the right person finds a specific observation that names their exact structural problem. Optimise for precision, not for reach.`,
  active: () => true,
  route: "linkedin-partner-queue",
});
