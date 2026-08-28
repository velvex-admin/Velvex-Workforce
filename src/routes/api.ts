// The API behind the dashboard. Everything here is already inside the
// unguessable path segment; see the auth note in src/index.ts.

import type { Env } from "../env.js";
import { readiness } from "../env.js";
import { Supabase } from "../lib/supabase.js";
import { Claude } from "../lib/claude.js";
import { createJudge, unavailableJudge } from "../lib/judge.js";
import type { RunContext } from "../core/agent.js";
import type { AgentId } from "../core/types.js";
import {
  AGENTS,
  executeApproval,
  readSchedules,
  runDue,
  runOne,
} from "../agents/registry.js";
import type { AgentRuntimeStatusMap, AgentScheduleOverride } from "../core/state.js";
import { connectorStatuses } from "../connectors/registry.js";
import { STATE_KEYS, state } from "../core/state.js";
import { DEFAULT_VOICE } from "../core/voice.js";
import { resolveTiers } from "../core/models.js";
import {
  briefFilename,
  cooldownRemainingDays,
  emptyPosition,
  recordAnswer,
  REJECTION_COOLDOWN_DAYS,
  renderBriefHtml,
  renderBriefMarkdown,
  type CandidateLedger,
  type IntelBrief,
  type IntelSource,
  type IntelWatchlist,
  type PositionStatement,
} from "../core/intel.js";
import { assessAnswer, competitiveIntelAgent } from "../agents/intelligence/competitive-intel.js";
import { dedupeKey } from "../core/proposal-key.js";
import { flag } from "../env.js";

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
    /** Called with every line as it is logged, so a caller can stream it out. */
    onLog?: (line: string) => void;
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
      options.onLog?.(line);
      console.log(line);
    },
  };
}

/**
 * A run, delivered as the response body it lives inside.
 *
 * `begin` is handed a `send` and returns the summary line's payload. Everything
 * it writes reaches the caller as it happens, and the stream stays open until
 * the work settles, which is the point: a Worker survives past thirty seconds
 * only while it is streaming to a connected client.
 *
 * The heartbeat is load-bearing rather than cosmetic. A research pass can think
 * for minutes without logging anything, and a connection carrying nothing is
 * exactly what the edge cuts at around a hundred seconds.
 */
export function runStream(
  begin: (send: (line: string) => void) => Promise<string>,
  heartbeatMs = 15_000
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let open = true;

  const stopBeating = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${line}\n`));
        } catch {
          // The client hung up between the check and the write.
          open = false;
        }
      };

      const startedAt = Date.now();
      heartbeat = setInterval(() => {
        send(`... ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }, heartbeatMs);

      void begin(send)
        .then((summary) => {
          send(`done ${summary}`);
        })
        .catch((err: unknown) => {
          // A failed run still has to end the stream. Left hanging, the caller
          // waits on a Worker that has stopped working.
          send(`failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .then(() => {
          stopBeating();
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by a cancelled client */
          }
        });
    },
    cancel() {
      // The client hung up. Stop the heartbeat rather than let it tick forever
      // against a stream nobody is reading.
      stopBeating();
      open = false;
    },
  });
}

export async function handleApi(
  request: Request,
  env: Env,
  path: string,
  execCtx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const segments = path.split("/").filter(Boolean);

  // GET /api/status
  if (segments[0] === "status") {
    const ready = readiness(env);
    let dbStatus: { ok: boolean; error?: string } = { ok: false, error: "not checked" };
    // The intelligence library is a fourth table added in migration 0002. If it
    // is missing the agent stops before spending anything, and the dashboard
    // has to be able to say why rather than showing an agent that does nothing.
    const intelligence = {
      migrationApplied: false,
      migrationHint: "Apply db/migrations/0002_intelligence_layer.sql.",
      webResearch: flag(env.INTEL_WEB_RESEARCH_ENABLED),
      watchedSources: 0,
      briefs: 0,
      error: "not checked" as string | undefined,
    };

    if (env.SUPABASE_SERVICE_ROLE_KEY) {
      const db = new Supabase(env);
      dbStatus = await db.ping();

      const intelReady = await db.intelReady();
      intelligence.migrationApplied = intelReady.ok;
      intelligence.error = intelReady.error;

      const watchlist = await state
        .read<IntelWatchlist>(db, STATE_KEYS.intelWatchlist)
        .catch(() => null);
      intelligence.watchedSources = watchlist?.sources?.length ?? 0;

      if (intelReady.ok) {
        intelligence.briefs = (await db.listIntelBriefs(200).catch(() => [])).length;
      }
    }

    return json({
      environment: env.VX_ENV,
      modelTiers: resolveTiers(env),
      readiness: ready,
      database: dbStatus,
      intelligence,
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
  //
  // The run happens INSIDE this response, and the response is a stream.
  //
  // Three shapes got here. Holding the run in an ordinary request meant the
  // caller got a 524 at the edge after ~100 seconds while the Worker carried on
  // spending. Handing it to waitUntil() and returning 202 fixed the caller and
  // broke the run: waitUntil extends a Worker for at most THIRTY SECONDS past
  // the response, which is ample for every agent here except the only one that
  // needed it. Competitive Intelligence was killed half a minute in, mid
  // research call, leaving a status board reading "started" that was
  // indistinguishable from an agent still thinking.
  //
  // An HTTP-triggered Worker has no duration limit at all while it is streaming
  // a response body to a connected client. So the work lives inside the stream:
  // the Worker stays alive because it is still writing, and the edge never
  // times out because bytes keep moving. Same reason the model calls stream,
  // one layer out.
  //
  // The cost of this shape is that the run belongs to the connection. Hang up
  // and it dies. That is the honest trade for a run that can take ten minutes,
  // and it is why every line is echoed to the caller as it happens rather than
  // being something to go and poll for.
  if (segments[0] === "run" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = segments[1];
    const cadence = (url.searchParams.get("cadence") ?? "hourly") as "hourly" | "daily" | "weekly";

    return new Response(
      runStream(async (send) => {
        const ctx = buildContext(env, { trigger: "manual", input: body, onLog: send });
        send(`run ${ctx.runId} started: ${agentId ?? `${cadence} tick`}`);
        return agentId
          ? JSON.stringify(await runOne(agentId as AgentId, ctx))
          : JSON.stringify({ agents: (await runDue(cadence, ctx)).length });
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          // Ask anything in the middle not to buffer, so a line written now is
          // a line read now. Buffering would reintroduce the silence this fixes.
          "x-accel-buffering": "no",
        },
      }
    );
  }

  // GET /api/runtime
  //   returns the live status board written by the agent runner.
  if (segments[0] === "runtime" && request.method === "GET") {
    const db = new Supabase(env);
    const value = (await state.read<AgentRuntimeStatusMap>(db, STATE_KEYS.agentRuntime)) ?? {};
    return json({ runtime: value });
  }

  // GET /api/schedules
  //   returns { [agentId]: {cadence, updatedAt, note} } for the dashboard.
  // PUT /api/schedules/:agentId  { cadence, note? }
  //   valid cadences: "hourly" | "daily" | "weekly" | "paused" | "default"
  //   "default" clears the override so the built-in cadence applies again.
  if (segments[0] === "schedules") {
    const db = new Supabase(env);

    if (request.method === "GET" && segments.length === 1) {
      return json({ schedules: await readSchedules(db) });
    }

    if (request.method === "PUT" && segments.length === 2) {
      const agentId = segments[1]!;
      const agent = AGENTS.find((a) => a.id === agentId);
      if (!agent) return json({ error: `Unknown agent "${agentId}"` }, 404);

      const body = (await request.json().catch(() => ({}))) as {
        cadence?: string;
        note?: string;
      };
      const cadence = body.cadence;
      const valid = ["hourly", "daily", "weekly", "paused", "default"];
      if (!cadence || !valid.includes(cadence)) {
        return json({ error: `cadence must be one of ${valid.join(", ")}` }, 400);
      }

      const current = await readSchedules(db);
      if (cadence === "default") {
        delete current[agentId];
      } else {
        const override: AgentScheduleOverride = {
          cadence: cadence as AgentScheduleOverride["cadence"],
          updatedAt: new Date().toISOString(),
          ...(body.note ? { note: body.note } : {}),
        };
        current[agentId] = override;
      }
      await state.write(db, STATE_KEYS.agentSchedules, current, `agent schedules updated`, {
        scope: "global",
        salience: 6,
        tags: ["schedule"],
      });
      return json({ schedules: current });
    }
  }

  // ---------------------------------------------------------------------
  // The intelligence library. The briefs are documents, so this surface is
  // built to hand one back as something readable rather than only as JSON:
  //   GET  /api/intel/briefs                    the index
  //   GET  /api/intel/briefs/:handle            one brief, whole (JSON)
  //   GET  /api/intel/briefs/:handle/markdown   the same brief as a .md file
  //   GET  /api/intel/briefs/:handle/page       the same brief as a page
  //   GET  /api/intel/watchlist                 what is being watched
  //   PUT  /api/intel/watchlist                 replace it, validated
  // `handle` is either the brief's uuid or the date it covers (YYYY-MM-DD).
  // ---------------------------------------------------------------------
  if (segments[0] === "intel") {
    const db = new Supabase(env);

    if (segments[1] === "briefs" && request.method === "GET") {
      if (segments.length === 2) {
        const ready = await db.intelReady();
        if (!ready.ok) {
          return json(
            {
              briefs: [],
              migrationApplied: false,
              error:
                "The intel_briefs table does not exist yet. Apply " +
                "db/migrations/0002_intelligence_layer.sql, then run the agent.",
              detail: ready.error,
            },
            200
          );
        }
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return json({ migrationApplied: true, briefs: await db.listIntelBriefs(limit) });
      }

      const handle = segments[2]!;
      const row = await db.getIntelBrief(handle);
      if (!row) return json({ error: `No brief for "${handle}"` }, 404);

      const brief = row.document as unknown as IntelBrief | undefined;
      const format = segments[3];

      // Without a document there is nothing to render. Saying so beats
      // rendering an empty page that looks like a brief with nothing in it.
      if ((format === "markdown" || format === "page") && !brief?.meta) {
        return json({ error: `Brief "${handle}" has no stored document to render.` }, 409);
      }

      if (format === "markdown") {
        return new Response(renderBriefMarkdown(brief!), {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${briefFilename(brief!, "md")}"`,
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
          },
        });
      }

      if (format === "page") {
        return new Response(renderBriefHtml(brief!), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      return json({ brief: row });
    }

    // GET|PUT /api/intel/position
    //   The owner's standing statement of what is true about Velvex now. The
    //   agent reads it before it reads anything the web says about Velvex, and
    //   it wins where the two disagree.
    if (segments[1] === "position") {
      if (request.method === "GET") {
        const position = await state.read<PositionStatement>(db, STATE_KEYS.intelPosition);
        return json({
          position: position ?? emptyPosition(new Date()),
          note:
            "PUT { standing: \"...\" } to replace the standing statement. Answered questions " +
            "are appended by POST /api/intel/answer and are not overwritten by a PUT here.",
        });
      }

      if (request.method === "PUT" || request.method === "POST") {
        const body = (await request.json().catch(() => null)) as { standing?: unknown } | null;
        if (!body || typeof body.standing !== "string") {
          return json({ error: 'Body must be JSON: { standing: "..." }' }, 400);
        }

        // Answers are appended by the answer route and are the record of a
        // conversation. Rewriting the standing prose must not silently discard
        // them, so they are carried across rather than replaced.
        const current = await state.read<PositionStatement>(db, STATE_KEYS.intelPosition);
        const next: PositionStatement = {
          updatedAt: new Date().toISOString(),
          standing: body.standing,
          answers: current?.answers ?? [],
        };
        await state.write(
          db,
          STATE_KEYS.intelPosition,
          next,
          `Velvex standing position updated (${next.answers.length} answered questions held)`,
          { scope: "competitive_intel", salience: 8, tags: ["intel", "positioning"] }
        );
        return json({ position: next });
      }
    }

    // POST /api/intel/answer  { briefDate, answer }
    //   Answering the question a brief asked. Two things happen: the answer
    //   becomes permanent context every future brief reads, and the agent
    //   reads it now and says what it changes. That assessment goes to the
    //   approvals queue, so the owner can take it or reject it.
    if (segments[1] === "answer" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as
        | { briefDate?: string; answer?: string }
        | null;

      if (!body?.briefDate || typeof body.answer !== "string" || !body.answer.trim()) {
        return json({ error: "Body must be JSON: { briefDate, answer }" }, 400);
      }

      const row = await db.getIntelBrief(body.briefDate);
      if (!row) return json({ error: `No brief for "${body.briefDate}"` }, 404);

      const brief = (row.document ?? null) as unknown as IntelBrief | null;
      const question = brief?.openQuestion?.question;
      if (!question) {
        return json({ error: `The ${body.briefDate} brief did not ask a question.` }, 409);
      }

      // Record it first. If the assessment call fails, the answer is still
      // kept: losing what the owner told us because a model call errored would
      // be the worst outcome here, and it is the easy one to get wrong.
      const current = await state.read<PositionStatement>(db, STATE_KEYS.intelPosition);
      const updated = recordAnswer(
        current,
        { askedOn: body.briefDate, question, answer: body.answer.trim() },
        new Date()
      );
      await state.write(
        db,
        STATE_KEYS.intelPosition,
        updated,
        `Velvex standing position: ${updated.answers.length} answered question(s)`,
        { scope: "competitive_intel", salience: 8, tags: ["intel", "positioning"] }
      );

      const ctx = buildContext(env, { trigger: "manual" });
      let assessment: string;
      let costUsd = 0;
      try {
        const result = await assessAnswer(
          { briefDate: body.briefDate, question, answer: body.answer.trim(), brief },
          ctx
        );
        assessment = result.assessment;
        costUsd = result.costUsd;
      } catch (err) {
        return json({
          recorded: true,
          assessed: false,
          position: updated,
          error: `The answer was recorded, but reading it failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      // Straight to the queue rather than executed. What Velvex claims about
      // itself is the owner's decision; this agent researches and argues.
      const action = {
        type: "recommendation" as const,
        summary: `What your answer changes: ${question.slice(0, 90)}`,
        channel: "internal" as const,
        payload: {
          kind: "answer_assessment",
          briefDate: body.briefDate,
          question,
          answer: body.answer.trim(),
          analysis: assessment,
          changesPositioning: true,
        },
        rationale: "You answered the question the brief asked. This is what it changes.",
        dedupeKey: `intel:answer:${body.briefDate}`,
      };

      const queued = await db.queueApproval({
        agent_id: "competitive_intel",
        agent_batch: "intelligence",
        title: action.summary,
        rationale: action.rationale,
        action,
        trigger_rule: "competitive_intel.acts_on_nothing",
        trigger_reason:
          "An assessment is a case, not a change. Approving it records the direction; " +
          "rejecting it drops it. Nothing publishes either way.",
        risk: "medium",
        dedupe_key: dedupeKey(competitiveIntelAgent.id, action),
      });

      return json({
        recorded: true,
        assessed: true,
        assessment,
        costUsd,
        queued: Boolean(queued),
        approvalId: queued?.id ?? null,
        position: updated,
      });
    }

    // GET /api/intel/candidates
    //   What has been ruled on, and when a rejection stops applying. Nothing is
    //   fetched until it appears here as accepted.
    if (segments[1] === "candidates" && request.method === "GET") {
      const ledger = (await state.read<CandidateLedger>(db, STATE_KEYS.intelCandidates)) ?? {};
      const now = new Date();
      const entries = Object.values(ledger)
        .map((verdict) => ({
          ...verdict,
          cooldownDaysLeft: cooldownRemainingDays(verdict, now),
        }))
        .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));

      return json({
        candidates: entries,
        accepted: entries.filter((entry) => entry.verdict === "accepted").length,
        rejected: entries.filter((entry) => entry.verdict === "rejected").length,
        cooldownDays: REJECTION_COOLDOWN_DAYS,
        note:
          "A rejection is suppressed for " + REJECTION_COOLDOWN_DAYS + " days and then the " +
          "candidate can be proposed again. A market moves, so a rejection expires.",
      });
    }

    if (segments[1] === "watchlist") {
      if (request.method === "GET") {
        const watchlist = await state.read<IntelWatchlist>(db, STATE_KEYS.intelWatchlist);
        return json({
          watchlist: watchlist ?? { updatedAt: null, sources: [] },
          note:
            "PUT { sources: [{ id, label, url, kind }] } here to replace it. " +
            "kind is one of: competitor, category, adjacent_tooling, buyer_language.",
        });
      }

      if (request.method === "PUT" || request.method === "POST") {
        const body = (await request.json().catch(() => null)) as
          | { sources?: unknown }
          | null;
        if (!body || !Array.isArray(body.sources)) {
          return json({ error: "Body must be JSON: { sources: [...] }" }, 400);
        }

        // Validated rather than stored as-is. A malformed watchlist would not
        // fail here, it would fail weekly inside an agent run, and the reason
        // would be several layers away from the person who typed it.
        const kinds = ["competitor", "category", "adjacent_tooling", "buyer_language"];
        const problems: string[] = [];
        const seen = new Set<string>();
        const sources: IntelSource[] = [];

        body.sources.forEach((raw, index) => {
          const item = raw as Record<string, unknown>;
          const where = `sources[${index}]`;
          const id = String(item?.["id"] ?? "").trim();
          const label = String(item?.["label"] ?? "").trim();
          const link = String(item?.["url"] ?? "").trim();
          const kind = String(item?.["kind"] ?? "").trim();

          if (!id) problems.push(`${where}: "id" is required and is the snapshot key.`);
          else if (seen.has(id)) problems.push(`${where}: duplicate id "${id}".`);
          if (!label) problems.push(`${where}: "label" is required.`);
          if (!kind || !kinds.includes(kind)) {
            problems.push(`${where}: "kind" must be one of ${kinds.join(", ")}.`);
          }
          if (!/^https?:\/\//i.test(link)) {
            problems.push(`${where}: "url" must be an http(s) URL.`);
          }

          if (id) seen.add(id);
          if (id && label && link && kinds.includes(kind)) {
            sources.push({
              id,
              label,
              url: link,
              kind: kind as IntelSource["kind"],
              ...(item["note"] ? { note: String(item["note"]) } : {}),
            });
          }
        });

        if (problems.length > 0) return json({ error: "Watchlist rejected", problems }, 400);

        const watchlist: IntelWatchlist = {
          updatedAt: new Date().toISOString(),
          sources,
        };
        await state.write(
          db,
          STATE_KEYS.intelWatchlist,
          watchlist,
          `${sources.length} sources on the competitive intelligence watchlist`,
          { scope: "competitive_intel", salience: 7, tags: ["intel"] }
        );
        return json({ watchlist });
      }
    }

    return json({ error: "Not found" }, 404);
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
