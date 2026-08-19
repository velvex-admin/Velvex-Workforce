// X / Twitter strategist.
//
// Drafts posts in the X register, publishes them on schedule via the X
// connector, and proposes growth ideas for approval. Posting is inactive until
// the four X_* secrets are set; the drafting side runs regardless, so a shelf
// of ready posts is waiting the moment the connector goes live.

import { createChannelStrategist } from "./channel-agent.js";
import { ENGLISH_AUDIENCE_WINDOWS_WEEKDAY } from "../../core/schedule.js";

export const xAgent = createChannelStrategist({
  id: "x",
  name: "X Strategist",
  channel: "x",
  description:
    "Reads how the account has posted before, drafts posts written for X, and proposes growth plays for approval. Publishing is inactive until API credentials are supplied.",
  // Three posts a week, jittered inside weekday windows tuned to English-speaking
  // audiences (12:00-21:00 UTC covers UK afternoon to US morning-through-midday).
  // The actual times are picked deterministically per ISO week so the same
  // schedule stays put across worker restarts, but they vary each week and
  // never land at fixed hour-on-the-hour marks that read as automated.
  schedule: {
    channel: "x",
    weeklyPosts: 3,
    windows: ENGLISH_AUDIENCE_WINDOWS_WEEKDAY,
    minGapHours: 30,
  },
  maxLength: 280,
  audienceLine:
    "Replies, reposts and quote-posts. Threads perform when the first post lands a specific claim; single posts perform when they are a hard sentence, not a summary.",
  platformGuide: `Post as one specific claim. If the point needs three sentences, it is probably a thread; propose format "thread" and write the opening post.

Do not start with a hook line and drop a blank line for drama; that is a format tell. Do not end with a question aimed at driving comments unless the question is real.

Numbers, states, mechanics: use them. "Wholesale and DTC share the same roasting capacity" is an X post; "operational challenges" is not.

280 characters, hard. Write to that, do not run up to it.

The Velvex account is small and institutional. It grows when a specific operator finds one post that names their exact problem, not when a post goes viral. Optimise for precision.`,
  active: () => true,
});
