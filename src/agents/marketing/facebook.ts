// Facebook strategist.
//
// Idle by default. The owner does not have a Facebook page yet, so the whole
// strategist stays dormant until they set FACEBOOK_ENABLED="true" in
// wrangler.toml. Only then does it start reading history and drafting posts.
//
// The full logic and connector are in place. Turning it on is a one-line
// change plus the two API secrets.

import { flag, type Env } from "../../env.js";
import { createChannelStrategist } from "./channel-agent.js";
import { ENGLISH_AUDIENCE_WINDOWS_WEEKDAY } from "../../core/schedule.js";

export const facebookAgent = createChannelStrategist({
  id: "facebook",
  name: "Facebook Strategist",
  channel: "facebook",
  description:
    "Idle. Turns on when FACEBOOK_ENABLED is set. Then reads how the page has posted, drafts Facebook-native posts, and proposes growth plays for approval.",
  schedule: {
    channel: "facebook",
    weeklyPosts: 3,
    windows: ENGLISH_AUDIENCE_WINDOWS_WEEKDAY,
    minGapHours: 30,
  },
  audienceLine:
    "Page reactions, comments and shares. A Facebook post is scrolled past unless it lands a specific claim in its first sentence.",
  platformGuide: `The Facebook page audience is less institutional than LinkedIn: business owners and operators who are not necessarily allocators. Adjust register down a notch, but do not adjust down the substance.

Between an X post and a LinkedIn post in length. Two or three short paragraphs. No emoji, no hashtag stacks, no "click the link".

The page grows when a post is specific enough that someone shares it saying "this is us".`,
  active: (env) => flag(env.FACEBOOK_ENABLED),
  // BLOCKING, and the cheapest kind: there is no Facebook page. The agent is
  // built and tested and returns nothing on every tick, which is correct but
  // indistinguishable from an agent that is broken. This says which it is.
  requires: [
    {
      id: "facebook.page",
      summary: "No Facebook page exists for Velvex, so this agent has nowhere to post",
      blocking: true,
      steps: [
        "Decide whether Facebook is a channel worth having at all. The audience for a commercial architecture diagnostic is on LinkedIn and X; this agent exists because the architecture doc listed the channel, not because the buyers are there.",
        "If yes: create the page, then create a Meta developer app with pages_manage_posts and pages_read_engagement.",
        "wrangler secret put FACEBOOK_PAGE_ID and wrangler secret put FACEBOOK_PAGE_ACCESS_TOKEN.",
        "Set FACEBOOK_ENABLED = \"true\" in wrangler.toml and deploy.",
      ],
      note:
        "Nothing is waiting on this and nothing degrades while it stays off. The full strategist and connector are already built, so switching it on later is credentials and a deploy, not development.",
      check: (env: Env) =>
        flag(env.FACEBOOK_ENABLED) && env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN
          ? null
          : "no Facebook page, and no credentials",
    },
  ],
});
