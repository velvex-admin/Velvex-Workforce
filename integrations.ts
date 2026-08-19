// The LinkedIn integration point.
//
// These routes sit outside the unguessable dashboard path on purpose: the
// outside company gets a bearer token, not the private URL of the whole
// application. The token is checked in constant time and nothing here works
// until it is set.
//
//   GET  /integrations/linkedin/queue      collect approved drafts to publish
//   POST /integrations/linkedin/published  report back what was published
//   POST /integrations/linkedin/inbound    hand us comments and DMs
//   POST /integrations/linkedin/metrics    report channel performance
//   GET  /integrations/linkedin/health     confirm the seam is wired up

import { flag, type Env } from "../env.js";
import { Supabase } from "../lib/supabase.js";
import {
  collectQueue,
  markPublished,
  partnerTokenMatches,
  receiveInbound,
  receiveMetrics,
} from "../connectors/linkedin.js";
import type { ChannelMetrics, InboundMessage } from "../connectors/types.js";
import { json } from "./api.js";

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

export async function handleIntegration(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  const segments = path.split("/").filter(Boolean); // e.g. ["linkedin","queue"]

  if (segments[0] !== "linkedin") return json({ error: "Not found" }, 404);

  if (!flag(env.LINKEDIN_INTEGRATION_ENABLED) || !env.LINKEDIN_PARTNER_TOKEN) {
    return json(
      {
        error: "LinkedIn integration is not switched on yet",
        detail:
          "Set LINKEDIN_PARTNER_TOKEN as a Worker secret and LINKEDIN_INTEGRATION_ENABLED to " +
          '"true" when the external agent is ready to connect.',
      },
      503
    );
  }

  if (!partnerTokenMatches(env, bearer(request))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const db = new Supabase(env);
  const endpoint = segments[1];

  if (endpoint === "health") {
    return json({ ok: true, integration: "linkedin", ready: true });
  }

  if (endpoint === "queue" && request.method === "GET") {
    const items = await collectQueue(db);
    return json({
      items: items.map((item) => ({
        id: item.id,
        text: item.text,
        pillar: item.pillar ?? null,
        format: item.format ?? null,
        createdAt: item.createdAt,
      })),
      note:
        "Everything returned here has already cleared this system's approval rules. " +
        "Post it as-is; the voice is deliberate.",
    });
  }

  if (endpoint === "published" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      id?: string;
      publishedRef?: string;
      publishedAt?: string;
    } | null;

    if (!body?.id || !body.publishedRef) {
      return json({ error: "Body needs { id, publishedRef, publishedAt? }" }, 400);
    }

    const updated = await markPublished(db, {
      id: body.id,
      publishedRef: body.publishedRef,
      ...(body.publishedAt ? { publishedAt: body.publishedAt } : {}),
    });
    if (!updated) return json({ error: `No queued item with id "${body.id}"` }, 404);

    await db.insertReport({
      agent_id: "linkedin",
      agent_batch: "marketing",
      action_type: "publish_post",
      summary: `LinkedIn partner agent published ${updated.publishedRef}`,
      detail: { queueItemId: updated.id, text: updated.text.slice(0, 300) },
      classification: "routine",
      outcome: "executed",
      channel: "linkedin",
      external_ref: updated.publishedRef ?? null,
    });

    return json({ item: updated });
  }

  if (endpoint === "inbound" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | { messages?: InboundMessage[] }
      | null;
    if (!Array.isArray(body?.messages)) {
      return json({ error: "Body needs { messages: InboundMessage[] }" }, 400);
    }

    const accepted = body.messages
      .filter((message) => message && typeof message.id === "string" && typeof message.text === "string")
      .map((message) => ({ ...message, channel: "linkedin" as const }));

    const stored = await receiveInbound(db, accepted);
    return json({
      accepted: accepted.length,
      new: stored,
      note: "Our social engagement agent picks these up on its next run, under its own rules.",
    });
  }

  if (endpoint === "metrics" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Partial<ChannelMetrics> | null;
    if (!body || typeof body.windowDays !== "number") {
      return json({ error: "Body needs at least { windowDays }" }, 400);
    }

    await receiveMetrics(db, {
      ...body,
      channel: "linkedin",
      windowDays: body.windowDays,
      collectedAt: body.collectedAt ?? new Date().toISOString(),
    } as ChannelMetrics);

    return json({ stored: true });
  }

  return json({ error: "Not found" }, 404);
}
