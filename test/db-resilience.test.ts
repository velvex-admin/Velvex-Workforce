// A database that is briefly busy must not look like fifteen broken agents,
// and must never lift a pause.
//
// On 2026-09-14 Supabase started answering 504 on the memory table. Forty runs
// failed over three days across x, linkedin, site_integrity and chief_of_staff.
// Two separate faults turned one slow database into that:
//
//   - the client had no timeout and no retry at all, so a single slow answer
//     was a dead agent; and
//   - runDue read the schedule overrides with `.catch(() => ({}))`, and an
//     empty override map does not mean "nothing is paused", it means every
//     agent falls back to its built-in cadence and RUNS. linkedin, facebook,
//     ops_health and social_engagement all woke up on ticks where the owner
//     had paused them, with the pauses still sitting in the database.
//
// The second is the one that had to be fixed in the safe direction rather than
// the convenient one.

import { describe, expect, it } from "vitest";
import {
  Supabase,
  SupabaseError,
  retryableRequest,
  transientDbFailure,
} from "../src/lib/supabase.js";
import type { Env } from "../src/env.js";
import registry from "../src/agents/registry.ts?raw";
import api from "../src/routes/api.ts?raw";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
} as unknown as Env;

describe("which database failures are worth another attempt", () => {
  it("retries the gateway timeouts that actually happened", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(transientDbFailure(new SupabaseError("busy", status, ""))).toBe(true);
    }
  });

  it("does not retry a request the database refused on its merits", () => {
    // Re-sending a 400 buys the same rejection twice and spends a subrequest
    // from a budget that has already killed two agents in this system.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(transientDbFailure(new SupabaseError("nope", status, ""))).toBe(false);
    }
  });

  it("retries a call that never came back", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "TimeoutError";
    expect(transientDbFailure(aborted)).toBe(true);
  });
});

describe("which requests are SAFE to send twice", () => {
  // A 504 is a gateway giving up, not a transaction rolling back: the statement
  // may have committed before the timeout was reported. This is the half that
  // matters more than the backoff.
  it("re-sends reads, which change nothing", () => {
    expect(retryableRequest("GET", "reports?select=*&limit=200")).toBe(true);
  });

  it("re-sends an upsert, because the second write lands on the same key", () => {
    expect(retryableRequest("POST", "memory?on_conflict=key")).toBe(true);
  });

  it("never re-sends a plain insert", () => {
    // Two copies of a failure report is the quiet version of the bug that put
    // 131 copies of one post in the LinkedIn partner queue.
    expect(retryableRequest("POST", "reports")).toBe(false);
    expect(retryableRequest("POST", "pending_approvals")).toBe(false);
    expect(retryableRequest("PATCH", "pending_approvals?id=eq.1")).toBe(false);
    expect(retryableRequest("DELETE", "memory?key=eq.x")).toBe(false);
  });
});

/** A Supabase whose transport is replaced and whose waiting is removed. */
function stubbed(outcomes: Array<number | "ok">) {
  const db = new Supabase(ENV, { retryDelaysMs: [0, 0] });
  let calls = 0;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const outcome = outcomes[calls] ?? "ok";
    calls += 1;
    seen.push(String(url));
    if (outcome === "ok") {
      return new Response(JSON.stringify([{ key: "k", detail: { value: 1 } }]), { status: 200 });
    }
    return new Response("gateway timeout", { status: outcome });
  }) as unknown as typeof fetch;
  return { db, calls: () => calls, seen };
}

describe("what the client does with a busy database", () => {
  const original = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = original;
  };

  it("sends a read again and returns the answer", async () => {
    const { db, calls } = stubbed([504, 504, "ok"]);
    try {
      const rows = await db.readMemory({ keys: ["k"] });
      expect(rows).toHaveLength(1);
      expect(calls()).toBe(3);
    } finally {
      restore();
    }
  });

  it("gives up after the schedule is spent, and says how hard it tried", async () => {
    const { db, calls } = stubbed([504, 504, 504]);
    try {
      await expect(db.readMemory({ keys: ["k"] })).rejects.toThrow(/after 3 attempts/);
      expect(calls()).toBe(3);
    } finally {
      restore();
    }
  });

  it("does not send an insert again", async () => {
    const { db, calls } = stubbed([504, "ok"]);
    try {
      await expect(
        db.insertReport({ agent_id: "x", agent_batch: "marketing", action_type: "t", summary: "s" })
      ).rejects.toBeInstanceOf(SupabaseError);
      expect(calls()).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("a pause survives a database failure", () => {
  it("fails closed rather than running everything", () => {
    // The whole bug in one line. An empty override map is not "nothing is
    // paused" — it is every agent falling back to its built-in cadence.
    expect(registry).not.toMatch(/readSchedules\(ctx\.db\)\.catch/);
    expect(registry).toMatch(/could not read the schedule overrides/);
    expect(registry).toMatch(/return \[\];/);
  });
});

describe("what gets pushed into memory by hand", () => {
  it("is written below the broadcast floor", () => {
    // Growth-Strategy and Chief-of-Staff sweep untagged at minSalience 6. This
    // route writes whatever anybody pushes, and what gets pushed is big: six
    // ~100KB copies of the site source sorted straight to the top of both.
    const block = api.slice(api.indexOf("state pushed to") - 1400, api.indexOf("state pushed to") + 300);
    const salience = /salience:\s*(\d+)/.exec(block.slice(block.indexOf("state pushed to")));
    expect(salience).not.toBeNull();
    expect(Number(salience?.[1])).toBeLessThan(6);
  });
});
