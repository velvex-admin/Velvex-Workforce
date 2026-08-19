// Facebook strategist.
//
// Idle by default. The owner does not have a Facebook page yet, so the whole
// strategist stays dormant until they set FACEBOOK_ENABLED="true" in
// wrangler.toml. Only then does it start reading history and drafting posts.
//
// The full logic and connector are in place. Turning it on is a one-line
// change plus the two API secrets.

import { flag } from "../../env.js";
import { createChannelStrategist } from "./channel-agent.js";

export const facebookAgent = createChannelStrategist({
  id: "facebook",
  name: "Facebook Strategist",
  channel: "facebook",
  description:
    "Idle. Turns on when FACEBOOK_ENABLED is set. Then reads how the page has posted, drafts Facebook-native posts, and proposes growth plays for approval.",
  schedule: {
    hours: [10, 15],
    days: [1, 2, 3, 4, 5],
    minGapHours: 20,
  },
  audienceLine:
    "Page reactions, comments and shares. A Facebook post is scrolled past unless it lands a specific claim in its first sentence.",
  platformGuide: `The Facebook page audience is less institutional than LinkedIn: business owners and operators who are not necessarily allocators. Adjust register down a notch, but do not adjust down the substance.

Between an X post and a LinkedIn post in length. Two or three short paragraphs. No emoji, no hashtag stacks, no "click the link".

The page grows when a post is specific enough that someone shares it saying "this is us".`,
  active: (env) => flag(env.FACEBOOK_ENABLED),
});
