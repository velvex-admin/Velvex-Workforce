// robots.txt and sitemap.xml, and the agent pass that keeps them current.
//
// Both files answered 404 on the live site on 2026-09-03 while the SEO agent
// reported "no issues found" every day, which was true of every page and false
// of the site. These tests fix the shape of that answer.

import { describe, expect, it, vi } from "vitest";
import {
  ROBOTS_PATH,
  SITEMAP_PATH,
  buildRobots,
  buildSitemap,
  canonicalPath,
} from "../src/core/site-files.js";
import { seoSiteAgent } from "../src/agents/marketing/seo-site.js";
import { evaluate } from "../src/core/autonomy.js";
import type { RunContext } from "../src/core/agent.js";
import { STATE_KEYS } from "../src/core/state.js";
import { BUSINESS } from "../src/core/business.js";

const SITE = BUSINESS.site;

const goodDesc =
  "A third-party structural diagnostic showing where architecture breaks under load, delivered as an Executive Ledger within 24 hours.";

/** A page shaped like the real ones: nav links to every sibling, real bulk. */
const page = (title: string) =>
  `<html><head><title>${title}</title>` +
  `<meta name="description" content="${goodDesc}">` +
  `</head><body>` +
  `<a href="index.html">Home</a><a href="proof-of-concept.html">PoC</a><a href="faq.html">FAQ</a>` +
  `${"filler ".repeat(400)}</body></html>`;

const PAGES: Record<string, string> = {
  "/index.html": page("Velvex — System Evaluation"),
  "/faq.html": page("Velvex — FAQ"),
  "/proof-of-concept.html": page("Velvex — Proof of Concept"),
  "/styles.css": "body{}",
  "/site.js": "//",
};

describe("canonical URLs", () => {
  it("maps a stored file name to the URL the site is actually served at", () => {
    // Netlify's Pretty URLs serves /faq and rewrites the links in the served
    // HTML to match, so /faq is the URL a crawler ever sees.
    expect(canonicalPath("/faq.html")).toBe("/faq");
    expect(canonicalPath("/proof-of-concept.html")).toBe("/proof-of-concept");
    expect(canonicalPath("/index.html")).toBe("/");
    expect(canonicalPath("/styles.css")).toBe("/styles.css");
  });
});

describe("the sitemap", () => {
  const xml = buildSitemap(PAGES, SITE);

  it("lists every page once, and nothing that is not a page", () => {
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      `${SITE}/`,
      `${SITE}/faq`,
      `${SITE}/proof-of-concept`,
    ]);
    expect(xml).not.toContain("styles.css");
    expect(xml).not.toContain(".html");
  });

  it("is well-formed and declares the sitemap namespace", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("carries no date, because it does not know one", () => {
    // A generated timestamp would be today's date on every page every day,
    // which Google discounts and which would make the file differ from itself
    // on every run — proposing the same edit and redeploying the site daily.
    expect(xml).not.toContain("<lastmod>");
  });

  it("is byte-identical when rebuilt, whatever order the source came in", () => {
    const reversed = Object.fromEntries(Object.entries(PAGES).reverse());
    expect(buildSitemap(reversed, SITE)).toBe(xml);
    expect(buildSitemap(PAGES, `${SITE}/`)).toBe(xml);
  });
});

describe("robots.txt", () => {
  it("points at the sitemap, which is the only part that does any work", () => {
    const robots = buildRobots(SITE);
    expect(robots).toContain(`Sitemap: ${SITE}${SITEMAP_PATH}`);
    expect(robots).toContain("User-agent: *");
    expect(robots).not.toMatch(/Disallow:\s*\/\s*$/m);
  });
});

// --- the agent -------------------------------------------------------------

function ctxWith(): RunContext {
  return {
    now: new Date("2026-09-03T07:00:00Z"),
    log: () => {},
    db: { read: async () => null, listReports: async () => [] },
    claude: { complete: async () => ({ text: "unused" }) },
    env: {},
  } as unknown as RunContext;
}

async function propose(source: Record<string, string>) {
  const mod = await import("../src/core/state.js");
  const original = mod.state.read;
  (mod.state as { read: unknown }).read = async (_db: unknown, key: string) =>
    key === STATE_KEYS.siteSource ? source : null;
  try {
    return await seoSiteAgent.propose(ctxWith());
  } finally {
    (mod.state as { read: unknown }).read = original;
  }
}

describe("the SEO agent's site-level pass", () => {
  it("proposes both files on a site that has neither, with every page clean", async () => {
    // This is the state the live site was actually in: nothing wrong with any
    // page, and the agent logging "no issues found this pass" every day.
    const actions = await propose(PAGES);
    const paths = actions.filter((a) => a.type === "site_edit").map((a) => a.payload["path"]);
    expect(paths).toEqual([SITEMAP_PATH, ROBOTS_PATH]);
  });

  it("writes them whole rather than as an anchored substitution", async () => {
    const [sitemap] = await propose(PAGES);
    expect(sitemap?.payload["mode"]).toBe("generated");
    expect(sitemap?.payload["before"]).toBe("");
    expect(String(sitemap?.payload["after"])).toContain("<urlset");
  });

  it("says nothing once both files are correct", async () => {
    const withFiles = {
      ...PAGES,
      [SITEMAP_PATH]: buildSitemap(PAGES, SITE),
      [ROBOTS_PATH]: buildRobots(SITE),
    };
    expect(await propose(withFiles)).toEqual([]);
  });

  it("notices when a page is added and the sitemap no longer covers it", async () => {
    const stale = {
      ...PAGES,
      [SITEMAP_PATH]: buildSitemap(PAGES, SITE),
      [ROBOTS_PATH]: buildRobots(SITE),
      "/method.html": page("Velvex — Method"),
    };
    const actions = await propose(stale);
    const sitemap = actions.find((a) => a.payload["path"] === SITEMAP_PATH);
    expect(sitemap).toBeDefined();
    expect(String(sitemap?.payload["after"])).toContain(`${SITE}/method`);
  });

  it("classifies both as routine, so a crawler file never waits for a person", async () => {
    const actions = await propose(PAGES);
    // Without this the loop body never runs and the test passes on a version
    // that proposes nothing at all, which is exactly the bug it is guarding.
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      const verdict = await evaluate({
        action,
        approvedChannels: seoSiteAgent.approvedChannels,
        approvalRules: seoSiteAgent.approvalRules,
        routineRules: seoSiteAgent.routineRules,
        ctx: {} as never,
      });
      expect(verdict.classification, `${action.payload["path"]} was queued`).toBe("routine");
    }
  });
});

// --- the writer's refusals -------------------------------------------------

describe("the generated-file writer refuses everything that is not one", () => {
  const env = { NETLIFY_AUTH_TOKEN: "t", NETLIFY_SITE_ID: "s" } as never;

  /** Drive netlifySiteWriter.write against a real state layer over a stub db. */
  async function write(source: Record<string, string>, edit: Record<string, unknown>) {
    const rows: Record<string, unknown> = { [STATE_KEYS.siteSource]: source };
    const db = {
      readMemory: async ({ keys }: { keys?: string[] }) =>
        (keys ?? [])
          .filter((k) => rows[k] !== undefined)
          .map((k) => ({ key: k, detail: { value: rows[k] } })),
      writeMemory: async ({ key, detail }: { key: string; detail?: { value?: unknown } }) => {
        rows[key] = detail?.value;
      },
      listReports: async () => [],
    } as never;

    // Any deploy attempt is a test failure in these cases, so the stub answers
    // with an error rather than a success nobody asked for.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 500 })) as never;
    try {
      const { netlifySiteWriter } = await import("../src/connectors/netlify.js");
      return await netlifySiteWriter.write(
        { before: "", mode: "generated", ...edit } as never,
        db,
        env
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("refuses a path that is not on the allowlist", async () => {
    const result = await write(PAGES, {
      path: "/index.html",
      kind: "structural_seo",
      after: "<html>whatever</html>",
    });
    expect(result.applied).toBe(false);
    expect(result.note).toMatch(/not a generated file|is a page/i);
    // The page is untouched: this is the empty-anchor shape, refused.
    expect(PAGES["/index.html"]).toContain("Velvex");
  });

  it("refuses empty content rather than publishing an empty file", async () => {
    const result = await write(PAGES, { path: SITEMAP_PATH, kind: "structural_seo", after: "  " });
    expect(result.applied).toBe(false);
    expect(result.note).toMatch(/empty/i);
  });

  it("refuses a rewrite that would change nothing", async () => {
    const xml = buildSitemap(PAGES, SITE);
    const result = await write(
      { ...PAGES, [SITEMAP_PATH]: xml },
      { path: SITEMAP_PATH, kind: "structural_seo", after: xml }
    );
    expect(result.applied).toBe(false);
    expect(result.note).toMatch(/already exactly this/i);
  });
});
