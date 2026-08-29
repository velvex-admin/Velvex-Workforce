import { describe, expect, it } from "vitest";
import { seoSiteAgent } from "../src/agents/marketing/seo-site.js";
import type { RunContext } from "../src/core/agent.js";
import { STATE_KEYS } from "../src/core/state.js";

const page = (title: string, links: string[], desc?: string) =>
  `<html><head><title>${title}</title>` +
  (desc ? `<meta name="description" content="${desc}">` : "") +
  `</head><body>${links.map((h) => `<a href="${h}">x</a>`).join("")}${"filler ".repeat(400)}</body></html>`;

const goodDesc =
  "A third-party structural diagnostic showing where architecture breaks under load, delivered as an Executive Ledger within 24 hours.";

function ctxWith(source: Record<string, string>): RunContext {
  return {
    now: new Date("2026-08-22T18:00:00Z"),
    log: () => {},
    db: {
      read: async (_k: string) => null,
      listReports: async () => [],
    },
    claude: {
      complete: async () => ({ text: "PAGE: /faq.html\nSENTENCE: see the diagnostic scope." }),
    },
    env: {},
    state: { read: async () => source },
  } as unknown as RunContext;
}

// Patched in: the agent reads site.source through state.read.
async function propose(source: Record<string, string>) {
  const mod = await import("../src/core/state.js");
  const original = mod.state.read;
  (mod.state as { read: unknown }).read = async (_db: unknown, key: string) =>
    key === STATE_KEYS.siteSource ? source : null;
  try {
    return await seoSiteAgent.propose(ctxWith(source));
  } finally {
    (mod.state as { read: unknown }).read = original;
  }
}

describe("SEO agent orphan handling", () => {
  const linked = {
    "/index.html": page("Home", ["faq.html", "proof-of-concept.html"], goodDesc),
    "/faq.html": page("FAQ", ["index.html"], goodDesc),
    "/proof-of-concept.html": page("Proof", ["index.html"], goodDesc),
  };

  it("does not call a fully linked site a set of orphans", async () => {
    const proposals = await propose(linked);
    expect(proposals.filter((p) => p.payload?.["kind"] === "internal_link")).toEqual([]);
  });

  it("never calls the home page an orphan, even with nothing linking to it", async () => {
    // Nothing links to /index.html here, so only the home-page exemption can
    // keep it off the orphan list. Earlier this test had /faq.html linking
    // back to it, which gave it an inbound link and meant it passed with the
    // bug still in place.
    const proposals = await propose({
      "/index.html": page("Home", ["faq.html"], goodDesc),
      "/faq.html": page("FAQ", [], goodDesc),
    });
    const orphans = proposals.filter((p) => p.payload?.["kind"] === "internal_link");
    expect(orphans.map((p) => p.payload?.["path"])).not.toContain("/index.html");
  });

  // An internal link has no anchor translator, so it must never be dressed up
  // as a text substitution. It failed every run, and would have injected the
  // model's reply into the page had the path appeared on it exactly once.
  it("reports a genuine orphan as an observation, never as a site edit", async () => {
    const proposals = await propose({
      "/index.html": page("Home", [], goodDesc),
      "/orphan.html": page("Orphan", ["index.html"], goodDesc),
    });
    const orphan = proposals.find((p) => p.payload?.["path"] === "/orphan.html");
    expect(orphan).toBeDefined();
    expect(orphan!.type).toBe("observation");
    expect(orphan!.type).not.toBe("site_edit");
  });
});
