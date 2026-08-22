// Site write access.
//
// The architecture doc granted the SEO / Site agent write access but never
// named the platform, which is why this is an interface rather than a single
// implementation: a Webflow write, a WordPress write and a static file deploy
// are three different integrations, and guessing would have been wrong.
//
// The site turned out to be a Netlify file deploy, and netlifySiteWriter
// implements it. When its credentials are absent the queued writer still
// records every edit in full — exact page, exact before, exact after — so the
// agent's work is never lost, only deferred.

import type { Env } from "../env.js";
import { state, type SiteChange } from "../core/state.js";
import type { Supabase } from "../lib/supabase.js";
// Type-only in the other direction, so this pair does not form a runtime cycle.
import { netlifySiteWriter } from "./netlify.js";

export interface SiteEditRequest {
  path: string;
  kind: string;
  before: string;
  after: string;
  approvalRef?: string;
}

export interface SiteWriteResult {
  applied: boolean;
  ref: string;
  note: string;
}

export interface SiteWriter {
  name: string;
  available(env: Env): boolean;
  write(edit: SiteEditRequest, db: Supabase, env: Env): Promise<SiteWriteResult>;
}

/** Fallback when no platform is connected: record the edit, apply nothing. */
export const queuedSiteWriter: SiteWriter = {
  name: "queued",

  available(): boolean {
    return false;
  },

  async write(edit: SiteEditRequest, db: Supabase): Promise<SiteWriteResult> {
    const queue = await state.siteChangeQueue(db);
    const change: SiteChange = {
      id: crypto.randomUUID(),
      path: edit.path,
      kind: edit.kind,
      before: edit.before,
      after: edit.after,
      proposedAt: new Date().toISOString(),
      status: "waiting_for_site_connection",
      approvalRef: edit.approvalRef,
    };
    queue.unshift(change);
    await state.saveSiteChangeQueue(db, queue);

    return {
      applied: false,
      ref: change.id,
      note:
        "Edit written in full and queued. It applies as soon as NETLIFY_AUTH_TOKEN and " +
        "NETLIFY_SITE_ID are set.",
    };
  },
};

/**
 * The best writer the current credentials allow. Netlify when it is wired up,
 * otherwise the queue — which is a real fallback, not a failure: the edit is
 * preserved exactly and applies once a platform is connected.
 */
export function getSiteWriter(env: Env): SiteWriter {
  return netlifySiteWriter.available(env) ? netlifySiteWriter : queuedSiteWriter;
}
