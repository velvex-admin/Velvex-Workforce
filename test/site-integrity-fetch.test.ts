// The hourly integrity check reaches the live site over the network, and a
// network call with no timeout is not a slow call — it is a call that may never
// return.
//
// This one is sequential and it is the whole agent: the restore point is only
// promoted after the loop finishes, and findings are only filed after it
// finishes. So one page that never answers freezes the safety net that clearing
// the SEO pause depends on, and does it silently, because the agent that would
// report the problem is the one that hung.
//
// Observed 2026-08-29: the 20:00 run logged "5 stored paths, 0 problem(s)" and
// then produced nothing for over half an hour while site.source.last_good
// stayed frozen at its 15:17 copy.

import { afterEach, describe, expect, it, vi } from "vitest";
import { siteIntegrityAgent } from "../src/agents/executive/site-integrity.js";
import { STATE_KEYS, state } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
import type { Supabase } from "../src/lib/supabase.js";

const wholePage = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>` +
  `${"<p>Real page content, at length.</p>".repeat(40)}</body></html>`;

function fakeDb(): Supabase {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async writeMemory(row: { key: string }) {
      rows.set(row.key, row as Record<string, unknown>);
      return row;
    },
    async readMemory(opts: { keys?: string[] } = {}) {
      const key = opts.keys?.[0];
      const row = key ? rows.get(key) : undefined;
      return row ? [row] : [];
    },
  } as unknown as Supabase;
}

async function ctxWithSource(): Promise<RunContext> {
  const db = fakeDb();
  await state.write(
    db,
    STATE_KEYS.siteSource,
    { "/index.html": wholePage("Velvex"), "/faq.html": wholePage("FAQ") },
    "seed"
  );
  return {
    db,
    env: {} as never,
    now: new Date("2026-08-29T20:00:00Z"),
    log: () => {},
  } as unknown as RunContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchServed", () => {
  it("passes an abort signal, so a page that never answers cannot hang the run", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(wholePage("Velvex"), { status: 200 });
    });

    await siteIntegrityAgent.propose(await ctxWithSource());

    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("carries on to the remaining pages when one of them aborts", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(String(url));
      if (String(url).endsWith("/index.html")) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response(wholePage("FAQ"), { status: 200 });
    });

    const proposals = await siteIntegrityAgent.propose(await ctxWithSource());

    // Both pages were asked for. That is the assertion that separates "carried
    // on" from "stopped at the first failure" — checking only which paths were
    // reported cannot tell those apart, since the page that answered is
    // reported either way by being absent.
    expect(asked.filter((url) => url.endsWith("/index.html"))).toHaveLength(1);
    expect(asked.filter((url) => url.endsWith("/faq.html"))).toHaveLength(1);

    const paths = proposals.map((p) => String(p.payload["path"]));
    expect(paths).toContain("/index.html");
    expect(paths).not.toContain("/faq.html");
  });

  it("reports a timed-out page as unreachable at status 0, not as damage", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const proposals = await siteIntegrityAgent.propose(await ctxWithSource());

    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      // Every one of these is an observation. A page we could not fetch must
      // never become a restore: status 0 is our side failing.
      expect(proposal.type).toBe("observation");
    }
  });
});
