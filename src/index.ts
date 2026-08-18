// VX-03 — Velvex internal operations layer. Worker entry point.
//
// ---------------------------------------------------------------------------
// ACCESS CONTROL — read this before adding a login screen.
//
// As specified: no authentication, an unguessable URL only. Every dashboard and
// API route lives under /x/<APP_PATH_SECRET>/, where APP_PATH_SECRET is a
// random secret you generate. A wrong or missing prefix gets a bare 404 with no
// hint that anything is there, and the comparison is constant-time so the
// secret cannot be recovered a character at a time.
//
// WHERE AUTHENTICATION GOES LATER: in `authorize()` below. It is the single
// choke point every request already passes through, before any handler runs.
// Adding Cloudflare Access in front of the Worker (zero code, an email login,
// and it can sit alongside the path secret) or a session cookie check inside
// authorize() are both drop-in from here. Nothing else in the codebase needs to
// change, because nothing else decides who may call it.
//
// What an unguessable URL does not protect against: the URL appearing in
// browser history, in a shared screenshot, or in a link you paste somewhere.
// Treat it like a password, and rotate it by setting a new APP_PATH_SECRET.
// ---------------------------------------------------------------------------

import type { Env } from "./env.js";
import { readiness } from "./env.js";
import { handleApi, buildContext, json } from "./routes/api.js";
import { handleIntegration } from "./routes/integrations.js";
import { dashboardHtml } from "./ui/dashboard.js";
import { runDue } from "./agents/registry.js";

/** Constant-time string comparison. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function notFound(): Response {
  // Deliberately bare: nothing here should confirm that anything exists.
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

interface Authorized {
  basePath: string;
  rest: string;
}

/**
 * THE ACCESS CHOKE POINT. Everything the dashboard can reach passes through
 * here first. Real authentication belongs in this function.
 */
function authorize(url: URL, env: Env): Authorized | null {
  const secret = env.APP_PATH_SECRET;
  if (!secret || secret.length < 16) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "x" || !parts[1]) return null;
  if (!secretEquals(parts[1], secret)) return null;

  return {
    basePath: `/x/${parts[1]}`,
    rest: "/" + parts.slice(2).join("/"),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The LinkedIn partner reaches its endpoints with a bearer token rather
    // than the private path, so the outside company never holds the URL of the
    // whole application.
    if (url.pathname.startsWith("/integrations/")) {
      return handleIntegration(request, env, url.pathname.slice("/integrations".length));
    }

    // A liveness probe that reveals nothing. Useful for uptime checks, and it
    // keeps the free-tier Supabase project from being the only thing awake.
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
    }

    const authorized = authorize(url, env);
    if (!authorized) return notFound();

    const { basePath, rest } = authorized;

    if (rest === "/" || rest === "") {
      const ready = readiness(env);
      const html = dashboardHtml(basePath);
      return new Response(
        ready.ready
          ? html
          : html.replace(
              "</header>",
              `<div class="chip bad" style="margin-top:14px;display:block">` +
                `<span class="k">Not fully configured</span>` +
                `<span class="v">Waiting on: ${ready.blocking.join(", ")}</span></div></header>`
            ),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
          },
        }
      );
    }

    if (rest.startsWith("/api/")) {
      try {
        return await handleApi(request, env, rest.slice("/api/".length));
      } catch (err) {
        console.error(err);
        return json(
          {
            error: "Request failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          500
        );
      }
    }

    return notFound();
  },

  /**
   * Cron. The schedules are in wrangler.toml:
   *   hourly        agents whose cadence is hourly
   *   07:00 UTC     daily agents, then the Chief-of-Staff roll-up
   *   Mon 08:00 UTC weekly agents
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const ready = readiness(env);
    if (!ready.ready) {
      console.log(`vx03: skipping scheduled run, waiting on ${ready.blocking.join(", ")}`);
      return;
    }

    const cadence =
      event.cron === "0 8 * * 1" ? "weekly" : event.cron === "0 7 * * *" ? "daily" : "hourly";

    const logs: string[] = [];
    const ctx = buildContext(env, { trigger: "cron", logs });

    try {
      const results = await runDue(cadence, ctx);
      const totals = results.reduce(
        (sum, result) => ({
          executed: sum.executed + result.executed,
          queued: sum.queued + result.queued,
          failed: sum.failed + result.failed,
        }),
        { executed: 0, queued: 0, failed: 0 }
      );
      console.log(
        `vx03 ${cadence} run ${ctx.runId}: ${totals.executed} executed, ${totals.queued} queued, ${totals.failed} failed`
      );
    } catch (err) {
      console.error(`vx03 ${cadence} run failed`, err);
    }
  },
} satisfies ExportedHandler<Env>;
