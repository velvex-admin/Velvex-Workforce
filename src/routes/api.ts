// The API behind the dashboard. Everything here is already inside the
// unguessable path segment; see the auth note in src/index.ts.

import type { Env } from "../env.js";
import { readiness } from "../env.js";
import { Supabase } from "../lib/supabase.js";
import { Claude } from "../lib/claude.js";
import { createJudge, unavailableJudge } from "../lib/judge.js";
import type { RunContext } from "../core/agent.js";
import type { AgentId } from "../core/types.js";
import { AGENTS, executeApproval, runDue, runOne } from "../agents/registry.js";
import { connectorStatuses } from "../connectors/registry.js";
import { STATE_KEYS, state } from "../core/state.js";
import { DEFAULT_VOICE } from "../core/voice.js";
import { resolveTiers } from "../core/models.js";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Nothing here should ever be cached by anything in between.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function buildContext(
  env: Env,
  options: {
    trigger: RunContext["trigger"];
    input?: Record<string, unknown>;
    logs?: string[];
  }
): RunContext {
  const db = new Supabase(env);
  let claude: Claude | null = null;
  try {
    claude = new Claude(env);
  } catch {
    claude = null; // no API key: agents that need the model will report it
  }

  return {
    env,
    db,
    claude: claude ?? (new Proxy({}, {
      get() {
        throw new Error("ANTHROPIC_API_KEY is not set, so no agent can think yet.");
      },
    }) as Claude),
    judge: claude ? createJudge(claude) : unavailableJudge,
    runId: crypto.randomUUID(),
    now: new Date(),
    trigger: options.trigger,
    input: options.input,
    log: (message, detail) => {
      const line = detail ? `${message} ${JSON.stringify(detail)}` : message;
      options.logs?.push(line);
      console.log(line);
    },
  };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(request.url);
  const segments = path.split("/").filter(Boolean);

  // GET /api/status
  if (segments[0] === "status") {
    const ready = readiness(env);
    let dbStatus: { ok: boolean; error?: string } = { ok: false, error: "not checked" };
    if (env.SUPABASE_SERVICE_ROLE_KEY) {
      dbStatus = await new Supabase(env).ping();
    }
    return json({
      environment: env.VX_ENV,
      modelTiers: resolveTiers(env),
      readiness: ready,
      database: dbStatus,
      connectors: connectorStatuses(env),
      voiceProfile: DEFAULT_VOICE.source,
      agents: AGENTS.map((agent) => ({
        id: agent.id,
        name: agent.name,
        batch: agent.batch,
        description: agent.description,
        cadence: agent.cadence,
        model: agent.model,
        effort: agent.model ? agent.effort : null,
        observeOnly: agent.observeOnly ?? false,
        externalBuild: agent.externalBuild ?? false,
        routine: agent.routineRules.map((rule) => ({ id: rule.id, describe: rule.describe })),
        needsApproval: agent.approvalRules.map((rule) => ({ id: rule.id, describe: rule.describe })),
      })),
    });
  }

  // GET /api/reports
  if (segments[0] === "reports" && request.method === "GET") {
    const db = new Supabase(env);
    const rows = await db.listReports({
      limit: Number(url.searchParams.get("limit") ?? 60),
      ...(url.searchParams.get("agent")
        ? { agentId: url.searchParams.get("agent") as AgentId }
        : {}),
    });
    return json({ reports: rows });
  }

  // GET /api/approvals
  if (segments[0] === "approvals" && segments.length === 1 && request.method === "GET") {
    const db = new Supabase(env);
    const status = (url.searchParams.get("status") ?? "pending") as "pending" | "all";
    return json({ approvals: await db.listApprovals(status, 100) });
  }

  // POST /api/approvals/:id/(approve|reject)
  if (segments[0] === "approvals" && segments.length === 3 && request.method === "POST") {
    const id = segments[1]!;
    const decision = segments[2];
    const body = (await request.json().catch(() => ({}))) as { note?: string; by?: string };
    const ctx = buildContext(env, { trigger: "manual" });

    if (decision === "reject") {
      const row = await ctx.db.updateApproval(id, {
        status: "rejected",
        decided_at: ctx.now.toISOString(),
        decided_by: body.by ?? "owner",
        decision_note: body.note ?? null,
      });
      return json({ approval: row });
    }

    if (decision === "approve") {
      await ctx.db.updateApproval(id, {
        status: "approved",
        decided_at: ctx.now.toISOString(),
        decided_by: body.by ?? "owner",
        decision_note: body.note ?? null,
      });
      const result = await executeApproval(id, ctx, body.by ?? "owner");
      const approval = await ctx.db.getApproval(id);
      return json({ result, approval });
    }

    return json({ error: `Unknown decision "${decision}"` }, 400);
  }

  // POST /api/run  or  POST /api/run/:agentId
  if (segments[0] === "run" && request.method === "POST") {
    const logs: string[] = [];
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const ctx = buildContext(env, { trigger: "manual", input: body, logs });

    if (segments[1]) {
      const result = await runOne(segments[1] as AgentId, ctx);
      return json({ runId: ctx.runId, result, logs });
    }

    const cadence = (url.searchParams.get("cadence") ?? "hourly") as "hourly" | "daily" | "weekly";
    const results = await runDue(cadence, ctx);
    return json({ runId: ctx.runId, cadence, results, logs });
  }

  // GET /api/memory
  if (segments[0] === "memory" && request.method === "GET") {
    const db = new Supabase(env);
    return json({
      memory: await db.readMemory({ limit: Number(url.searchParams.get("limit") ?? 60) }),
    });
  }

  // GET|PUT /api/state/:key — how business data gets into the system
  if (segments[0] === "state") {
    const db = new Supabase(env);
    const key = segments.slice(1).join("/");

    if (!key) {
      return json({
        keys: STATE_KEYS,
        note: "PUT a JSON body to /api/state/<key> to feed the agents. GET to read it back.",
      });
    }

    if (request.method === "PUT" || request.method === "POST") {
      const value = await request.json().catch(() => null);
      if (value === null) return json({ error: "Body must be JSON" }, 400);
      await state.write(db, key, value, `state pushed to ${key}`, {
        scope: "global",
        salience: 7,
        tags: ["state"],
      });
      return json({ key, written: true });
    }

    return json({ key, value: await state.read(db, key) });
  }

  return json({ error: "Not found" }, 404);
}
