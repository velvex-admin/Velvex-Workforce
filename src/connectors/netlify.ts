// Netlify site writer.
//
// The site is a file deploy — no repository, no build command — so Netlify's
// digest deploy is the mechanism: send a manifest of every path with its SHA1,
// Netlify replies with the digests it does not hold, upload only those. A file
// missing from the manifest is deleted from the site, so the manifest always
// carries every file.
//
// WHERE THE SOURCE COMES FROM, AND WHY IT IS NOT NETLIFY.
//
// The obvious design is read the page from Netlify, edit it, put it back. That
// does not work. Netlify's file endpoints return metadata rather than content
// under every Accept header tried, and the served page differs from the stored
// digest by a few bytes for reasons not visible from outside. Editing a page
// we cannot read exactly is how a live site quietly rots.
//
// So the source of truth is ours: state key `site.source`, a map of path to
// content, seeded from the folder that gets deployed. The agent edits that,
// deploys the whole set, and writes it back. Nothing is ever read back from
// Netlify, so there is nothing to drift against.

import type { Env } from "../env.js";
import { state, type SiteChange } from "../core/state.js";
import { STATE_KEYS } from "../core/state.js";
import type { Supabase } from "../lib/supabase.js";
import type { SiteEditRequest, SiteWriteResult, SiteWriter } from "./site.js";

const API = "https://api.netlify.com/api/v1";

/** The published site, path (with leading slash) to file content. */
export type SiteSource = Record<string, string>;

interface DeployResponse {
  id: string;
  /** SHA1s Netlify does not already hold and wants uploaded. */
  required: string[];
}

/** SHA1 as lowercase hex, the digest Netlify's manifest expects. */
async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call<T>(
  env: Env,
  method: string,
  path: string,
  init: { body?: unknown; raw?: string } = {}
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NETLIFY_AUTH_TOKEN}`,
      ...(init.raw !== undefined
        ? { "Content-Type": "application/octet-stream" }
        : init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
    },
    body:
      init.raw !== undefined
        ? init.raw
        : init.body !== undefined
          ? JSON.stringify(init.body)
          : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Netlify ${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Publish a complete set of files. Every path in `files` becomes the site;
 * anything not listed is removed, which is why callers pass the whole source
 * rather than the one page they changed.
 */
export async function deploySite(env: Env, files: SiteSource): Promise<string> {
  const manifest: Record<string, string> = {};
  const byDigest = new Map<string, { path: string; content: string }>();

  for (const [path, content] of Object.entries(files)) {
    const digest = await sha1(content);
    manifest[path] = digest;
    byDigest.set(digest, { path, content });
  }

  const deploy = await call<DeployResponse>(env, "POST", `/sites/${env.NETLIFY_SITE_ID}/deploys`, {
    body: { files: manifest },
  });

  // Netlify already holds everything unchanged, so this uploads only what moved.
  for (const digest of deploy.required) {
    const file = byDigest.get(digest);
    if (!file) continue;
    await call(env, "PUT", `/deploys/${deploy.id}/files${file.path}`, { raw: file.content });
  }

  return deploy.id;
}

/**
 * Apply one edit to the source we hold.
 *
 * The guards matter more than the substitution, because this runs unattended
 * against a live site and a bad replacement is visible to every visitor until
 * somebody notices:
 *
 *   - the page must be part of the source we hold;
 *   - `before` must appear EXACTLY once. Zero means the page changed after the
 *     edit was proposed, so applying it now would not do what was reviewed.
 *     More than one means we cannot know which occurrence was meant. Both
 *     abort rather than guess;
 *   - the result must differ, so a no-op never burns a deploy.
 */
function applyEdit(source: SiteSource, edit: SiteEditRequest): SiteSource {
  const current = source[edit.path];
  if (current === undefined) {
    throw new Error(
      `${edit.path} is not in the site source. Known paths: ${Object.keys(source).join(", ")}`
    );
  }

  // An empty anchor is refused outright. This previously fell through to
  // replacing the whole file with `after`, which turned a 22kB page into the
  // 134-byte meta description that was meant to be inserted into it. There is
  // no edit in this path for which replacing an entire page is correct: an
  // insertion must name the existing text it goes next to, so the result can
  // be verified before it is published.
  if (!edit.before) {
    throw new Error(
      `This edit gives no anchor text to position against on ${edit.path}. An insertion must name the existing text it sits next to; replacing the whole page is never what is meant.`
    );
  }

  const occurrences = current.split(edit.before).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `The text this edit replaces is no longer on ${edit.path}. The page changed after the edit was proposed.`
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `The text this edit replaces appears ${occurrences} times on ${edit.path}. Which one was meant is ambiguous, so nothing changed.`
    );
  }

  const updated = current.replace(edit.before, edit.after);

  // A substitution should change a page, not rewrite it. Anything that loses
  // most of the document is a malformed edit, whatever the anchor matched.
  if (updated.length < current.length * 0.5) {
    throw new Error(
      `This edit would cut ${edit.path} from ${current.length} to ${updated.length} characters. That is a rewrite, not a fix, so nothing was changed.`
    );
  }
  if (updated === current) {
    throw new Error(`Applying this edit to ${edit.path} would change nothing.`);
  }

  return { ...source, [edit.path]: updated };
}

export const netlifySiteWriter: SiteWriter = {
  name: "netlify",

  available(env: Env): boolean {
    return Boolean(env.NETLIFY_AUTH_TOKEN && env.NETLIFY_SITE_ID);
  },

  async write(edit: SiteEditRequest, db: Supabase, env: Env): Promise<SiteWriteResult> {
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

    const record = async (): Promise<void> => {
      queue.unshift(change);
      await state.saveSiteChangeQueue(db, queue);
    };

    const source = await state.read<SiteSource>(db, STATE_KEYS.siteSource);
    if (!source || Object.keys(source).length === 0) {
      await record();
      return {
        applied: false,
        ref: change.id,
        note:
          "No site source is loaded. Seed it once by PUTting the deployed folder to " +
          "/api/state/site.source, then edits apply automatically.",
      };
    }

    try {
      const updated = applyEdit(source, edit);
      const deployId = await deploySite(env, updated);
      await state.write(db, STATE_KEYS.siteSource, updated, `site source after ${edit.kind} on ${edit.path}`, {
        scope: "seo_site",
        agent: "seo_site",
        salience: 7,
        tags: ["site"],
      });
      change.status = "applied";
      await record();
      return {
        applied: true,
        ref: deployId,
        note: `Applied to ${edit.path} and published. Netlify deploy ${deployId}.`,
      };
    } catch (err) {
      // A refused edit is information: it says the page moved under us, or the
      // match was ambiguous. Losing it would mean rediscovering the same
      // conflict on the next run.
      await record();
      return {
        applied: false,
        ref: change.id,
        note: `Not applied: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
