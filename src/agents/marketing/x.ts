// X / Twitter Agent — Marketing.
//
// Doc: same publishing role, on X. Also a stubbed connector until credentials
// are supplied. X posts more often than a Facebook page and has a hard 280
// character limit, so the schedule and the length guard differ; everything else
// is the shared channel behaviour.

import { createChannelAgent } from "./channel-agent.js";

export const xAgent = createChannelAgent({
  id: "x",
  name: "X / Twitter Agent",
  channel: "x",
  description:
    "Publishes content-agent drafts to X on a schedule it decides. Connector inactive until API credentials are supplied.",
  schedule: {
    hours: [9, 13, 17],
    days: [1, 2, 3, 4, 5],
    minGapHours: 5,
  },
  maxLength: 280,
});
