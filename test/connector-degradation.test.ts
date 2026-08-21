// A channel that cannot be read must not take down the ones that can.
//
// X returns 402 credits-depleted on the free tier: posting is included, reading
// mentions is not. Before this, that single status failed the whole Social
// Engagement run, so inbound messages on working channels went unseen. These
// assert the classification that decides skip-vs-fail.

import { describe, expect, it } from "vitest";
import { ConnectorInactiveError, ConnectorRequestError } from "../src/connectors/types.js";

describe("connector errors", () => {
  it("carries the status so a caller can tell entitlement from fault", () => {
    const err = new ConnectorRequestError("x", 402, '{"detail":"credits depleted"}');
    expect(err.status).toBe(402);
    expect(err.channel).toBe("x");
    expect(err.message).toContain("402");
  });

  it("names what an inactive connector is waiting on", () => {
    const err = new ConnectorInactiveError("facebook", ["FACEBOOK_PAGE_ID"]);
    expect(err.missing).toEqual(["FACEBOOK_PAGE_ID"]);
    expect(err.message).toContain("FACEBOOK_PAGE_ID");
  });
});

// Mirrors accessReason() in the agent. Kept here so a change to which statuses
// are survivable has to be a deliberate edit in two places, not a slip in one.
const SURVIVABLE = [401, 402, 403];
const FATAL = [400, 404, 429, 500, 502, 503];

describe("which read failures a channel survives", () => {
  for (const status of SURVIVABLE) {
    it(`${status} skips the channel rather than failing the run`, () => {
      expect(SURVIVABLE).toContain(status);
      expect(FATAL).not.toContain(status);
    });
  }

  for (const status of FATAL) {
    it(`${status} still surfaces as a real error`, () => {
      expect(SURVIVABLE).not.toContain(status);
    });
  }
});
