// Facebook connector — INACTIVE.
//
// The publishing code below is complete and is what will run. Nothing fires
// until FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN are set as Worker
// secrets and FACEBOOK_ENABLED is "true" in wrangler.toml.
//
// Graph API v21.0. Page access token, page-scoped.

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

const GRAPH = "https://graph.facebook.com/v21.0";

function credentials(env: Env): { pageId: string; token: string } {
  const missing: string[] = [];
  if (!flag(env.FACEBOOK_ENABLED)) missing.push('FACEBOOK_ENABLED="true"');
  if (!env.FACEBOOK_PAGE_ID) missing.push("FACEBOOK_PAGE_ID");
  if (!env.FACEBOOK_PAGE_ACCESS_TOKEN) missing.push("FACEBOOK_PAGE_ACCESS_TOKEN");
  if (missing.length > 0) throw new ConnectorInactiveError("facebook", missing);
  return { pageId: env.FACEBOOK_PAGE_ID!, token: env.FACEBOOK_PAGE_ACCESS_TOKEN! };
}

async function graph<T>(
  path: string,
  init: { method?: string; body?: URLSearchParams; token: string }
): Promise<T> {
  const url = new URL(`${GRAPH}/${path}`);
  const headers: Record<string, string> = { Authorization: `Bearer ${init.token}` };
  if (init.body) headers["Content-Type"] = "application/x-www-form-urlencoded";

  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers,
    body: init.body?.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new ConnectorRequestError("facebook", res.status, text);
  return JSON.parse(text) as T;
}

export const facebookConnector: Connector = {
  channel: "facebook",

  status(env: Env): ConnectorStatus {
    const missing: string[] = [];
    if (!flag(env.FACEBOOK_ENABLED)) missing.push('FACEBOOK_ENABLED="true"');
    if (!env.FACEBOOK_PAGE_ID) missing.push("FACEBOOK_PAGE_ID");
    if (!env.FACEBOOK_PAGE_ACCESS_TOKEN) missing.push("FACEBOOK_PAGE_ACCESS_TOKEN");
    return {
      channel: "facebook",
      active: missing.length === 0,
      missing,
      note:
        missing.length === 0
          ? "Live."
          : "Agent logic built and tested. Publishing blocked until credentials are supplied.",
    };
  },

  async publish(input: PublishInput, env: Env): Promise<PublishResult> {
    const { pageId, token } = credentials(env);

    const body = new URLSearchParams({ message: input.text });

    if (input.mediaUrls?.length) {
      // Single-image posts go to /photos; the caption rides along with the image.
      body.set("url", input.mediaUrls[0]!);
    }

    if (input.scheduledFor) {
      const when = Math.floor(new Date(input.scheduledFor).getTime() / 1000);
      const now = Math.floor(Date.now() / 1000);
      // Graph rejects anything under 10 minutes or over 6 months out.
      if (when < now + 600 || when > now + 60 * 60 * 24 * 30 * 6) {
        throw new ConnectorRequestError(
          "facebook",
          400,
          "scheduled_publish_time must be between 10 minutes and 6 months from now"
        );
      }
      body.set("published", "false");
      body.set("scheduled_publish_time", String(when));
    }

    const edge = input.mediaUrls?.length ? "photos" : "feed";
    const result = await graph<{ id: string; post_id?: string }>(`${pageId}/${edge}`, {
      method: "POST",
      body,
      token,
    });

    const ref = result.post_id ?? result.id;
    return {
      externalRef: ref,
      url: `https://www.facebook.com/${ref}`,
      scheduled: Boolean(input.scheduledFor),
    };
  },

  async reply(input: ReplyInput, env: Env): Promise<PublishResult> {
    const { token } = credentials(env);

    if (input.kind === "dm") {
      // Messenger send API: reply inside the 24-hour window on an existing thread.
      const body = new URLSearchParams({
        recipient: JSON.stringify({ id: input.inReplyTo }),
        message: JSON.stringify({ text: input.text }),
        messaging_type: "RESPONSE",
      });
      const { pageId } = credentials(env);
      const result = await graph<{ message_id: string }>(`${pageId}/messages`, {
        method: "POST",
        body,
        token,
      });
      return { externalRef: result.message_id, scheduled: false };
    }

    const body = new URLSearchParams({ message: input.text });
    const result = await graph<{ id: string }>(`${input.inReplyTo}/comments`, {
      method: "POST",
      body,
      token,
    });
    return { externalRef: result.id, scheduled: false };
  },

  async fetchInbound(env: Env, sinceIso?: string): Promise<InboundMessage[]> {
    const { pageId, token } = credentials(env);
    const since = sinceIso ? Math.floor(new Date(sinceIso).getTime() / 1000) : undefined;

    const params = new URLSearchParams({
      fields: "id,created_time,comments.limit(50){id,message,created_time,from}",
      limit: "25",
    });
    if (since) params.set("since", String(since));

    const feed = await graph<{
      data: Array<{
        id: string;
        comments?: {
          data: Array<{
            id: string;
            message: string;
            created_time: string;
            from?: { name?: string };
          }>;
        };
      }>;
    }>(`${pageId}/feed?${params}`, { token });

    const messages: InboundMessage[] = [];
    for (const post of feed.data) {
      for (const comment of post.comments?.data ?? []) {
        messages.push({
          id: comment.id,
          channel: "facebook",
          kind: "comment",
          authorHandle: comment.from?.name,
          text: comment.message,
          createdAt: comment.created_time,
          parentRef: post.id,
        });
      }
    }
    return messages;
  },

  async fetchMetrics(env: Env, windowDays: number): Promise<ChannelMetrics> {
    const { pageId, token } = credentials(env);
    const params = new URLSearchParams({
      metric: "page_impressions,page_post_engagements,page_fans",
      period: "day",
      since: String(Math.floor((Date.now() - windowDays * 86400_000) / 1000)),
      until: String(Math.floor(Date.now() / 1000)),
    });

    const insights = await graph<{
      data: Array<{ name: string; values: Array<{ value: number }> }>;
    }>(`${pageId}/insights?${params}`, { token });

    const sum = (name: string) =>
      insights.data
        .find((metric) => metric.name === name)
        ?.values.reduce((total, point) => total + (point.value ?? 0), 0);

    return {
      channel: "facebook",
      windowDays,
      impressions: sum("page_impressions"),
      engagements: sum("page_post_engagements"),
      followers: insights.data.find((m) => m.name === "page_fans")?.values.at(-1)?.value,
      collectedAt: new Date().toISOString(),
    };
  },
};
