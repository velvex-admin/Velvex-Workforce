// The LinkedIn company-page connector, before it has ever been switched on.
//
// This is the point of writing it now rather than on the day the token arrives:
// a publishing path that has never been exercised is a publishing path nobody
// knows the shape of, and the first thing it would do is post to a real company
// page. So the request it builds, the failures it refuses to paper over, and
// the escaping it applies are all pinned here while it is safe to get wrong.

import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeCommentary, linkedInDirectConnector } from "../src/connectors/linkedin-direct.js";
import { ConnectorInactiveError, ConnectorRequestError } from "../src/connectors/types.js";
import type { Env } from "../src/env.js";

const LIVE = {
  LINKEDIN_DIRECT_ENABLED: "true",
  LINKEDIN_ORG_ID: "1234567",
  LINKEDIN_ACCESS_TOKEN: "token-abc",
} as unknown as Env;

const DORMANT = {} as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Captures the request without letting it leave the process. */
function stubFetch(response: { status?: number; headers?: Record<string, string>; body?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(response.body ?? "", {
      status: response.status ?? 201,
      headers: response.headers ?? {},
    });
  });
  return calls;
}

describe("while the credentials do not exist", () => {
  it("reports inactive and names every missing piece", () => {
    const status = linkedInDirectConnector.status(DORMANT);
    expect(status.active).toBe(false);
    expect(status.missing).toEqual([
      'LINKEDIN_DIRECT_ENABLED="true"',
      "LINKEDIN_ORG_ID",
      "LINKEDIN_ACCESS_TOKEN",
    ]);
  });

  it("refuses to publish rather than failing somewhere further in", async () => {
    await expect(
      linkedInDirectConnector.publish({ text: "anything" }, DORMANT)
    ).rejects.toBeInstanceOf(ConnectorInactiveError);
  });

  it("stays inactive if the flag is on but a secret is missing", () => {
    const half = { LINKEDIN_DIRECT_ENABLED: "true" } as unknown as Env;
    expect(linkedInDirectConnector.status(half).active).toBe(false);
    expect(linkedInDirectConnector.status(half).missing).toContain("LINKEDIN_ORG_ID");
  });
});

describe("the request it builds", () => {
  it("posts as the organisation, not as a person", async () => {
    const calls = stubFetch({ headers: { "x-restli-id": "urn:li:share:7100" } });
    await linkedInDirectConnector.publish({ text: "A structural observation." }, LIVE);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.author).toBe("urn:li:organization:1234567");
    expect(body.visibility).toBe("PUBLIC");
    expect(body.lifecycleState).toBe("PUBLISHED");
    expect(calls[0]?.url).toBe("https://api.linkedin.com/rest/posts");
  });

  it("sends the dated version header LinkedIn requires", async () => {
    // An unrecognised LinkedIn-Version is rejected outright, so this is not
    // decoration — and it is dated, so it is a thing to review rather than set.
    const calls = stubFetch({ headers: { "x-restli-id": "urn:li:share:1" } });
    await linkedInDirectConnector.publish({ text: "text" }, LIVE);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["LinkedIn-Version"]).toMatch(/^\d{6}$/);
    expect(headers["Authorization"]).toBe("Bearer token-abc");
  });

  it("carries a timeout, because a hung fetch is how this repo lost an agent", async () => {
    const calls = stubFetch({ headers: { "x-restli-id": "urn:li:share:1" } });
    await linkedInDirectConnector.publish({ text: "text" }, LIVE);
    expect(calls[0]?.init.signal).toBeDefined();
  });

  it("returns the post reference from the header, where LinkedIn puts it", async () => {
    // A successful POST returns 201 with an EMPTY body. Parsing the body for an
    // id gets nothing and would look like a silent failure.
    stubFetch({ status: 201, body: "", headers: { "x-restli-id": "urn:li:share:7100" } });
    const result = await linkedInDirectConnector.publish({ text: "text" }, LIVE);

    expect(result.externalRef).toBe("urn:li:share:7100");
    expect(result.url).toContain("urn:li:share:7100");
    expect(result.scheduled).toBe(false);
  });
});

describe("the failures it refuses to paper over", () => {
  it("will not silently post now when asked to schedule", async () => {
    // LinkedIn's Posts API has no scheduling field. Publishing immediately
    // instead would put a post out hours early with nothing saying so.
    stubFetch({ headers: { "x-restli-id": "urn:li:share:1" } });
    await expect(
      linkedInDirectConnector.publish(
        { text: "text", scheduledFor: "2026-09-10T14:00:00Z" },
        LIVE
      )
    ).rejects.toThrow(/no scheduling field/i);
  });

  it("does not invent a reference when LinkedIn returns none", async () => {
    // The post may well have gone out. A made-up ref would read for ever after
    // as a successful publish nobody can find, and a retry would post twice.
    stubFetch({ status: 201, body: "", headers: {} });
    await expect(linkedInDirectConnector.publish({ text: "text" }, LIVE)).rejects.toThrow(
      /returned no x-restli-id/
    );
  });

  it("surfaces an API error with its status and body", async () => {
    stubFetch({ status: 422, body: '{"message":"invalid commentary"}' });
    await expect(
      linkedInDirectConnector.publish({ text: "text" }, LIVE)
    ).rejects.toBeInstanceOf(ConnectorRequestError);
  });

  it("says plainly that a page cannot send a DM", async () => {
    await expect(
      linkedInDirectConnector.reply({ kind: "dm", inReplyTo: "x", text: "hi" }, LIVE)
    ).rejects.toThrow(/cannot send a DM/i);
  });
});

describe("commentary escaping", () => {
  // This is the one part written against documentation rather than against a
  // real response, so it is pinned tightly and flagged in the source: too wide
  // and backslashes appear in the published post, too narrow and an ordinary
  // sentence 422s on a bracket.
  it("escapes the brackets that appear in ordinary prose", () => {
    expect(escapeCommentary("channel concentration (one or two pathways)")).toBe(
      "channel concentration \\(one or two pathways\\)"
    );
  });

  it("escapes the other reserved characters", () => {
    expect(escapeCommentary("a|b{c}d@e[f]g<h>i*j_k~l")).toBe(
      "a\\|b\\{c\\}d\\@e\\[f\\]g\\<h\\>i\\*j\\_k\\~l"
    );
  });

  it("leaves a hashtag alone, because escaping it would kill the tag", () => {
    // The guide allows at most one hashtag. Escaping "#" would publish a visible
    // backslash in front of it and stop LinkedIn parsing it as a tag at all.
    expect(escapeCommentary("#StructuralDiagnostics")).toBe("#StructuralDiagnostics");
  });

  it("leaves ordinary sentences untouched", () => {
    const plain = "Operational performance under stable conditions is not structural resilience.";
    expect(escapeCommentary(plain)).toBe(plain);
  });

  it("is applied to what is actually sent", () => {
    const calls = stubFetch({ headers: { "x-restli-id": "urn:li:share:1" } });
    return linkedInDirectConnector
      .publish({ text: "dependency (measurable) exposure" }, LIVE)
      .then(() => {
        const body = JSON.parse(String(calls[0]?.init.body));
        expect(body.commentary).toBe("dependency \\(measurable\\) exposure");
      });
  });
});

describe("metrics", () => {
  it("reads share statistics as the first real audience signal in this system", async () => {
    // X's free tier 402s on every read, so nothing this system publishes has
    // ever reported an impression. LinkedIn's r_organization_social is the
    // first place a number could come back at all.
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("organizationalEntityShareStatistics")) {
        return new Response(
          JSON.stringify({
            elements: [
              {
                totalShareStatistics: {
                  impressionCount: 812,
                  likeCount: 7,
                  commentCount: 2,
                  shareCount: 1,
                  clickCount: 19,
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ firstDegreeSize: 339 }), { status: 200 });
    });

    const metrics = await linkedInDirectConnector.fetchMetrics(LIVE, 30);
    expect(metrics.impressions).toBe(812);
    expect(metrics.engagements).toBe(10);
    expect(metrics.clicks).toBe(19);
    expect(metrics.followers).toBe(339);
  });

  it("still returns metrics when the follower call fails", async () => {
    // Two calls, and the follower count is the less important one. Losing the
    // whole read because a secondary endpoint 403'd would be the wrong trade.
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("networkSizes")) return new Response("nope", { status: 403 });
      return new Response(
        JSON.stringify({ elements: [{ totalShareStatistics: { impressionCount: 5 } }] }),
        { status: 200 }
      );
    });

    const metrics = await linkedInDirectConnector.fetchMetrics(LIVE, 30);
    expect(metrics.impressions).toBe(5);
    expect(metrics.followers).toBeUndefined();
  });
});
