// LinkedIn company-page connector — INACTIVE until credentials exist.
//
// Built to the same shape as the Facebook connector: the code below is what
// will run, and nothing fires until LINKEDIN_DIRECT_ENABLED is "true" and both
// secrets are set. That is deliberate — an agent whose publishing path only
// gets written on the day the token arrives is an agent nobody has tested.
//
// WHAT IT COSTS TO TURN ON, honestly: this is not a paste-a-secret job like X
// was. Posting as an organisation needs the Community Management API product on
// a LinkedIn developer app, which is an application LinkedIn reviews, and the
// page must have the app's owner as an admin. Reading per-post statistics needs
// r_organization_social from the same review. Tokens are 60-day and refreshable;
// there is no permanent one.
//
// Two things this connector deliberately does NOT do:
//
//   - It does not schedule. LinkedIn's Posts API publishes immediately; the
//     scheduling in their UI is not exposed here. `scheduledFor` therefore
//     fails loudly rather than silently posting now, which would put a post out
//     hours early with nothing saying so.
//   - It does not carry a platform idempotency key, because the API has no
//     field for one. The guard against a double post is ours: the approval row,
//     `publishedOn` and `declinedOn`. That is worth stating plainly given this
//     repo has already put 131 copies of one post into a queue.

import { flag, type Env } from "../env.js";
import {
  ConnectorInactiveError,
  ConnectorRequestError,
  type ChannelMetrics,
  type Connector,
  type ConnectorStatus,
  type InboundMessage,
  type PublishInput,
  type PublishResult,
  type ReplyInput,
} from "./types.js";

const API = "https://api.linkedin.com/rest";

/**
 * The LinkedIn-Version header is mandatory and dated. An unrecognised value is
 * rejected outright, and a stale one is eventually withdrawn, so this is a
 * thing to review rather than set once.
 */
const VERSION = "202508";

/** Every outbound call gets a timeout. A hung fetch is the failure this repo has already paid for. */
const TIMEOUT_MS = 10_000;

const MISSING = (env: Env): string[] => {
  const missing: string[] = [];
  if (!flag(env.LINKEDIN_DIRECT_ENABLED)) missing.push('LINKEDIN_DIRECT_ENABLED="true"');
  if (!env.LINKEDIN_ORG_ID) missing.push("LINKEDIN_ORG_ID");
  if (!env.LINKEDIN_ACCESS_TOKEN) missing.push("LINKEDIN_ACCESS_TOKEN");
  return missing;
};

function credentials(env: Env): { author: string; token: string } {
  const missing = MISSING(env);
  if (missing.length > 0) throw new ConnectorInactiveError("linkedin", missing);
  return {
    author: `urn:li:organization:${env.LINKEDIN_ORG_ID!}`,
    token: env.LINKEDIN_ACCESS_TOKEN!,
  };
}

/**
 * Escape the characters LinkedIn's "little text" commentary format reserves.
 *
 * An unescaped `(` or `)` is the common cause of a 422 on an otherwise ordinary
 * sentence, and a post about "channel concentration (one or two pathways)" has
 * two of them. `#` is deliberately NOT escaped: escaping it would publish a
 * visible backslash in front of the one hashtag the guide allows and kill the
 * tag itself.
 *
 * VERIFY THIS ON THE FIRST REAL POST. If backslashes appear in the published
 * text, this set is too wide; if a post 422s on punctuation, it is too narrow.
 * It is one function and one test, which is why it is written as one.
 */
export function escapeCommentary(text: string): string {
  return text.replace(/[\\|{}@\[\]()<>*_~]/g, (char) => `\\${char}`);
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; token: string }
): Promise<{ body: T; headers: Headers }> {
  const res = await fetch(`${API}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${init.token}`,
      "LinkedIn-Version": VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) throw new ConnectorRequestError("linkedin", res.status, text);
  // A successful POST /posts returns 201 with an empty body; the id is a header.
  return { body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
}

export const linkedInDirectConnector: Connector = {
  channel: "linkedin",

  status(env: Env): ConnectorStatus {
    const missing = MISSING(env);
    return {
      channel: "linkedin",
      active: missing.length === 0,
      missing,
      note:
        missing.length === 0
          ? "Live. Posts still wait for the owner's approval before they are sent."
          : "Agent logic built and tested. Direct posting blocked until the Community Management API app is approved and a token is supplied; drafts route to the partner queue meanwhile.",
    };
  },

  async publish(input: PublishInput, env: Env): Promise<PublishResult> {
    const { author, token } = credentials(env);

    if (input.scheduledFor) {
      // Failing here is the point. Posting now when the caller asked for later
      // puts a post out hours early with nothing anywhere saying it happened.
      throw new ConnectorRequestError(
        "linkedin",
        400,
        "LinkedIn's Posts API publishes immediately; it has no scheduling field. The weekly plan decides when to call this, so do not pass scheduledFor."
      );
    }

    const { headers } = await call<unknown>("posts", {
      method: "POST",
      token,
      body: {
        author,
        commentary: escapeCommentary(input.text),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      },
    });

    const ref = headers.get("x-restli-id") ?? headers.get("x-linkedin-id");
    if (!ref) {
      // The post may well have gone out. Saying so is better than inventing a
      // reference that later reads as a successful publish nobody can find.
      throw new ConnectorRequestError(
        "linkedin",
        502,
        "LinkedIn accepted the post but returned no x-restli-id, so it cannot be referenced. Check the page before retrying: a retry would publish it twice."
      );
    }

    return {
      externalRef: ref,
      url: `https://www.linkedin.com/feed/update/${ref}/`,
      scheduled: false,
    };
  },

  async reply(input: ReplyInput, env: Env): Promise<PublishResult> {
    const { author, token } = credentials(env);

    if (input.kind === "dm") {
      throw new ConnectorInactiveError("linkedin", [
        "LinkedIn has no organisation-level messaging API; a page cannot send a DM",
      ]);
    }

    const { body } = await call<{ $URN?: string; object?: string }>(
      `socialActions/${encodeURIComponent(input.inReplyTo)}/comments`,
      {
        method: "POST",
        token,
        body: { actor: author, message: { text: escapeCommentary(input.text) } },
      }
    );

    return { externalRef: body.$URN ?? body.object ?? input.inReplyTo, scheduled: false };
  },

  async fetchInbound(): Promise<InboundMessage[]> {
    // Comments on a page's own posts are readable, but only per post, and the
    // agent that would use them does not exist yet. Returning nothing is honest;
    // inventing an empty inbox from an endpoint never called is not.
    return [];
  },

  async fetchMetrics(env: Env, windowDays: number): Promise<ChannelMetrics> {
    const { author, token } = credentials(env);

    const stats = await call<{
      elements?: Array<{
        totalShareStatistics?: {
          impressionCount?: number;
          likeCount?: number;
          commentCount?: number;
          shareCount?: number;
          clickCount?: number;
        };
      }>;
    }>(
      `organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(author)}`,
      { token }
    );

    const totals = stats.body.elements?.[0]?.totalShareStatistics ?? {};
    const followers = await call<{ firstDegreeSize?: number }>(
      `networkSizes/${encodeURIComponent(author)}?edgeType=CompanyFollowedByMember`,
      { token }
    ).catch(() => ({ body: {} as { firstDegreeSize?: number }, headers: new Headers() }));

    return {
      channel: "linkedin",
      windowDays,
      impressions: totals.impressionCount,
      engagements:
        (totals.likeCount ?? 0) + (totals.commentCount ?? 0) + (totals.shareCount ?? 0),
      clicks: totals.clickCount,
      followers: followers.body.firstDegreeSize,
      collectedAt: new Date().toISOString(),
    };
  },
};
