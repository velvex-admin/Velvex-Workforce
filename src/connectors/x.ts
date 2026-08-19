// X / Twitter connector — INACTIVE.
//
// Complete implementation against X API v2 with OAuth 1.0a user-context
// signing, which is what posting on behalf of an account requires. Nothing
// fires until the four X_* secrets are set and X_ENABLED is "true".
//
// One real platform limit worth knowing: X API v2 has no server-side
// scheduling. Timing is handled by the agent holding a post until its slot and
// publishing then, which is the same behaviour from the outside.

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

const API = "https://api.x.com";

interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function missingCredentials(env: Env): string[] {
  const missing: string[] = [];
  if (!flag(env.X_ENABLED)) missing.push('X_ENABLED="true"');
  if (!env.X_API_KEY) missing.push("X_API_KEY");
  if (!env.X_API_SECRET) missing.push("X_API_SECRET");
  if (!env.X_ACCESS_TOKEN) missing.push("X_ACCESS_TOKEN");
  if (!env.X_ACCESS_TOKEN_SECRET) missing.push("X_ACCESS_TOKEN_SECRET");
  return missing;
}

function credentials(env: Env): XCredentials {
  const missing = missingCredentials(env);
  if (missing.length > 0) throw new ConnectorInactiveError("x", missing);
  return {
    apiKey: env.X_API_KEY!,
    apiSecret: env.X_API_SECRET!,
    accessToken: env.X_ACCESS_TOKEN!,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET!,
  };
}

/** RFC 3986 percent-encoding. encodeURIComponent leaves four characters alone. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message)
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * OAuth 1.0a signature over the request. Query parameters take part in the
 * signature; a JSON body does not, which is why v2 endpoints sign cleanly.
 */
async function authorizationHeader(
  method: string,
  url: string,
  queryParams: Record<string, string>,
  creds: XCredentials
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const signatureParams = { ...oauth, ...queryParams };
  const parameterString = Object.keys(signatureParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(signatureParams[key]!)}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(parameterString),
  ].join("&");

  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = await hmacSha1(signingKey, baseString);

  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(header)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(header[key]!)}"`)
      .join(", ")
  );
}

async function call<T>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {}
): Promise<T> {
  const creds = credentials(env);
  const url = `${API}${path}`;
  const query = options.query ?? {};
  const auth = await authorizationHeader(method, url, query, creds);

  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);

  const res = await fetch(target.toString(), {
    method,
    headers: {
      Authorization: auth,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new ConnectorRequestError("x", res.status, text);
  return JSON.parse(text) as T;
}

const MAX_POST_LENGTH = 280;

async function ownUserId(env: Env): Promise<string> {
  const me = await call<{ data: { id: string } }>(env, "GET", "/2/users/me");
  return me.data.id;
}

export const xConnector: Connector = {
  channel: "x",

  status(env: Env): ConnectorStatus {
    const missing = missingCredentials(env);
    return {
      channel: "x",
      active: missing.length === 0,
      missing,
      note:
        missing.length === 0
          ? "Live."
          : "Agent logic built and tested. Publishing blocked until credentials are supplied.",
    };
  },

  async publish(input: PublishInput, env: Env): Promise<PublishResult> {
    credentials(env);

    if (input.scheduledFor && new Date(input.scheduledFor).getTime() > Date.now() + 60_000) {
      throw new ConnectorRequestError(
        "x",
        400,
        "X API v2 cannot schedule. The agent holds the post until its slot and publishes then."
      );
    }
    if (input.text.length > MAX_POST_LENGTH) {
      throw new ConnectorRequestError(
        "x",
        400,
        `Post is ${input.text.length} characters; the limit is ${MAX_POST_LENGTH}.`
      );
    }

    const result = await call<{ data: { id: string } }>(env, "POST", "/2/tweets", {
      body: { text: input.text },
    });

    return {
      externalRef: result.data.id,
      url: `https://x.com/i/web/status/${result.data.id}`,
      scheduled: false,
    };
  },

  async reply(input: ReplyInput, env: Env): Promise<PublishResult> {
    credentials(env);

    if (input.kind === "dm") {
      const result = await call<{ data: { dm_event_id: string } }>(
        env,
        "POST",
        `/2/dm_conversations/with/${encodeURIComponent(input.inReplyTo)}/messages`,
        { body: { text: input.text } }
      );
      return { externalRef: result.data.dm_event_id, scheduled: false };
    }

    if (input.text.length > MAX_POST_LENGTH) {
      throw new ConnectorRequestError(
        "x",
        400,
        `Reply is ${input.text.length} characters; the limit is ${MAX_POST_LENGTH}.`
      );
    }

    const result = await call<{ data: { id: string } }>(env, "POST", "/2/tweets", {
      body: { text: input.text, reply: { in_reply_to_tweet_id: input.inReplyTo } },
    });
    return {
      externalRef: result.data.id,
      url: `https://x.com/i/web/status/${result.data.id}`,
      scheduled: false,
    };
  },

  async fetchInbound(env: Env, sinceIso?: string): Promise<InboundMessage[]> {
    const userId = await ownUserId(env);
    const query: Record<string, string> = {
      max_results: "50",
      "tweet.fields": "created_at,conversation_id,author_id",
    };
    if (sinceIso) query["start_time"] = new Date(sinceIso).toISOString();

    const mentions = await call<{
      data?: Array<{
        id: string;
        text: string;
        created_at: string;
        conversation_id?: string;
        author_id?: string;
      }>;
    }>(env, "GET", `/2/users/${userId}/mentions`, { query });

    return (mentions.data ?? []).map((item) => ({
      id: item.id,
      channel: "x" as const,
      kind: "mention" as const,
      authorHandle: item.author_id,
      text: item.text,
      createdAt: item.created_at,
      parentRef: item.conversation_id,
    }));
  },

  async fetchMetrics(env: Env, windowDays: number): Promise<ChannelMetrics> {
    const userId = await ownUserId(env);
    const start = new Date(Date.now() - windowDays * 86400_000).toISOString();

    const timeline = await call<{
      data?: Array<{
        public_metrics?: {
          impression_count?: number;
          like_count?: number;
          reply_count?: number;
          retweet_count?: number;
        };
      }>;
    }>(env, "GET", `/2/users/${userId}/tweets`, {
      query: { max_results: "100", start_time: start, "tweet.fields": "public_metrics" },
    });

    const posts = timeline.data ?? [];
    const total = (pick: (m: NonNullable<(typeof posts)[number]["public_metrics"]>) => number | undefined) =>
      posts.reduce((sum, post) => sum + (post.public_metrics ? (pick(post.public_metrics) ?? 0) : 0), 0);

    return {
      channel: "x",
      windowDays,
      posts: posts.length,
      impressions: total((m) => m.impression_count),
      engagements:
        total((m) => m.like_count) + total((m) => m.reply_count) + total((m) => m.retweet_count),
      collectedAt: new Date().toISOString(),
    };
  },
};
