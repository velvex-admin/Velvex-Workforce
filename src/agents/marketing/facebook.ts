// Facebook Agent — Marketing.
//
// Doc: same publishing role as the LinkedIn agent, on Facebook. Built as a
// stubbed connector — the agent logic here is complete and runs; the connector
// it calls is inactive until credentials are supplied.

import { createChannelAgent } from "./channel-agent.js";

export const facebookAgent = createChannelAgent({
  id: "facebook",
  name: "Facebook Agent",
  channel: "facebook",
  description:
    "Publishes content-agent drafts to Facebook on a schedule it decides. Connector inactive until API credentials are supplied.",
  schedule: {
    // Weekday late mornings, which is when a page post gets read rather than scrolled past.
    hours: [10, 15],
    days: [1, 2, 3, 4, 5],
    minGapHours: 20,
  },
});
