// Site write access.
//
// UNRESOLVED IN THE ARCHITECTURE DOC. The SEO / Site agent is given write
// access — "can make changes directly rather than only suggesting them" — but
// the doc never names the platform the site runs on, and no site credentials
// exist in the Credentials & Build Scope table. There is no way to guess that
// correctly: a Webflow write, a WordPress write and a static-repo commit are
// three different integrations.
//
// So the agent is built complete, its rules are enforced, and every edit it
// makes is written out in full — exact page, exact before, exact after — into
// the site change queue, where it waits for a site connection. Wiring a real
// platform means implementing SiteWriter once; nothing else changes.

import type { Env } from "../env.js";
import { state, type SiteChange } from "../core/state.js";
import type { Supabase } from "../lib/supabase.js";

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

/** The only writer available today: record the edit, apply nothing. */
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
        "Edit written in full and queued. It applies as soon as a site platform is connected; " +
        "the architecture doc grants write access but does not say what the site runs on.",
    };
  },
};

export function getSiteWriter(): SiteWriter {
  return queuedSiteWriter;
}
