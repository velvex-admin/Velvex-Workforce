// The connector interface every publishing channel implements.
//
// Facebook and X implement this fully — the publishing code is real, the
// request shapes are real, the error handling is real. What is missing is the
// credentials, and a connector without credentials refuses to fire rather than
// pretending to succeed. That distinction matters: a silent no-op would show up
// in the reports table as a published post that never existed.

import type { Env } from "../env.js";
import type { Channel } from "../core/types.js";

export interface ConnectorStatus {
  channel: Channel;
  active: boolean;
  /** Secrets or flags that would make this connector live. */
  missing: string[];
  note: string;
}

export interface PublishInput {
  text: string;
  /** ISO timestamp. When set and the platform supports it, the post is scheduled. */
  scheduledFor?: string;
  mediaUrls?: string[];
  /** Guards against a retry publishing the same thing twice. */
  idempotencyKey?: string;
}

export interface ReplyInput {
  /** Platform id of the comment, post or conversation being replied to. */
  inReplyTo: string;
  text: string;
  kind: "comment" | "dm";
}

export interface PublishResult {
  externalRef: string;
  url?: string;
  scheduled: boolean;
}

export interface InboundMessage {
  id: string;
  channel: Channel;
  kind: "comment" | "dm" | "mention";
  authorHandle?: string;
  text: string;
  createdAt: string;
  /** The post or thread it belongs to, when there is one. */
  parentRef?: string;
}

export interface ChannelMetrics {
  channel: Channel;
  windowDays: number;
  impressions?: number;
  engagements?: number;
  clicks?: number;
  followers?: number;
  posts?: number;
  /** Signups attributed to this channel, when the source can supply them. */
  signups?: number;
  collectedAt: string;
}

export interface Connector {
  channel: Channel;
  status(env: Env): ConnectorStatus;
  publish(input: PublishInput, env: Env): Promise<PublishResult>;
  reply(input: ReplyInput, env: Env): Promise<PublishResult>;
  fetchInbound(env: Env, sinceIso?: string): Promise<InboundMessage[]>;
  fetchMetrics(env: Env, windowDays: number): Promise<ChannelMetrics>;
}

/** Thrown whenever a connector is asked to act without live credentials. */
export class ConnectorInactiveError extends Error {
  constructor(
    readonly channel: Channel,
    readonly missing: string[]
  ) {
    super(
      `${channel} connector is inactive. Waiting on: ${missing.join(", ")}. ` +
        `Agent logic is built and will run as soon as these are set.`
    );
    this.name = "ConnectorInactiveError";
  }
}

export class ConnectorRequestError extends Error {
  constructor(
    readonly channel: Channel,
    readonly status: number,
    readonly body: string
  ) {
    super(`${channel} API returned ${status}: ${body.slice(0, 300)}`);
    this.name = "ConnectorRequestError";
  }
}
