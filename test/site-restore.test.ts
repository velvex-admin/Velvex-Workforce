// Putting the site back without waiting for a person.
//
// Reporting a ruined site is worth nothing at 3am. The SEO agent deploys the
// whole manifest, so between one hourly check and the next the live site can
// become a set of stubs with nobody reading the alert. This restores the last
// copy that was verified sound, and it does so immediately.
//
// The danger is the mirror image of the one it fixes. An agent that reverted a
// redesign because it did not recognise it would destroy more work than the
// failure it guards against — so the rule is DAMAGE, never DIFFERENCE. A page
// that was rewritten is not damage. A page that collapsed to a fragment is.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/core/autonomy.js";
import { ruleContext } from "./helpers.js";
import { siteIntegrityAgent } from "../src/agents/executive/site-integrity.js";
import type { ProposedAction } from "../src/core/types.js";
import {
  assessDamage,
  isPromotable,
  MAX_RESTORES_PER_DAY,
  restoresToday,
  type KnownGoodSource,
  type ServedPage,
  type StoredPage,
} from "../src/core/site-integrity.js";

const page = (path: string, body: string): StoredPage => ({ path, content: body });
const realPage = (marker: string) =>
  `<!DOCTYPE html><html><head><title>${marker}</title></head><body>` +
  "x".repeat(4000) +
  "</body></html>";

const good: KnownGoodSource = {
  savedAt: "2026-08-28T00:00:00Z",
  files: {
    "/index.html": realPage("Velvex"),
    "/faq.html": realPage("FAQ"),
  },
};

const served = (paths: string[], overrides: Partial<ServedPage> = {}): ServedPage[] =>
  paths.map((path) => ({ path, ok: true, status: 200, bytes: 4000, ...overrides }));

describe("telling damage apart from difference", () => {
  it("does not call a rewritten page damage", () => {
    // The owner is allowed to change their own site. Every page here is
    // different from the verified copy and every one is a real document.
    const rewritten = [
      page("/index.html", realPage("Completely New Homepage")),
      page("/faq.html", realPage("Rewritten FAQ")),
    ];
    expect(assessDamage(rewritten, served(["/index.html", "/faq.html"]), good).ruined).toBe(false);
  });

  it("calls a page that collapsed to a fragment damage", () => {
    // The real incident: a 22kB page went live as a 134-byte meta description.
    const ruined = [
      page("/index.html", "A structural diagnostic for businesses approaching scale."),
      page("/faq.html", realPage("FAQ")),
    ];
    const verdict = assessDamage(ruined, served(["/index.html", "/faq.html"]), good);
    expect(verdict.ruined).toBe(true);
    expect(verdict.reasons[0]).toContain("/index.html");
    expect(verdict.reasons[0]).toContain("fragment");
  });

  it("calls a page that lost most of its body damage", () => {
    const halved = [
      page("/index.html", `<!DOCTYPE html><html><head><title>V</title></head><body>${"x".repeat(1200)}</body></html>`),
      page("/faq.html", realPage("FAQ")),
    ];
    expect(assessDamage(halved, served(["/index.html", "/faq.html"]), good).ruined).toBe(true);
  });

  it("calls a page that stopped being a document damage", () => {
    const broken = [page("/index.html", "x".repeat(5000)), page("/faq.html", realPage("FAQ"))];
    const verdict = assessDamage(broken, served(["/index.html", "/faq.html"]), good);
    expect(verdict.ruined).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("complete HTML document");
  });

  it("treats a live page that stopped answering as damage", () => {
    const fine = [page("/index.html", realPage("Velvex")), page("/faq.html", realPage("FAQ"))];
    const down: ServedPage[] = [
      { path: "/index.html", ok: false, status: 500, bytes: 0 },
      { path: "/faq.html", ok: true, status: 200, bytes: 4000 },
    ];
    expect(assessDamage(fine, down, good).ruined).toBe(true);
  });

  it("does not treat OUR network failing as the site failing", () => {
    // Status 0 is this Worker unable to reach the page, which is not evidence
    // about the page. Acting on it would redeploy a site over a blip.
    const fine = [page("/index.html", realPage("Velvex"))];
    const unreachable: ServedPage[] = [{ path: "/index.html", ok: false, status: 0, bytes: 0 }];
    expect(assessDamage(fine, unreachable, good).ruined).toBe(false);
  });

  it("ignores a path the owner deliberately removed", () => {
    const fine = [page("/index.html", realPage("Velvex"))];
    const gone: ServedPage[] = [{ path: "/retired.html", ok: false, status: 404, bytes: 0 }];
    expect(assessDamage(fine, gone, good).ruined).toBe(false);
  });

  it("does nothing at all when there is no verified copy to go back to", () => {
    // Restoring to something never checked is just choosing a different way to
    // be broken. Saying so is the honest outcome.
    const ruined = [page("/index.html", "tiny")];
    expect(assessDamage(ruined, served(["/index.html"]), null).ruined).toBe(false);
  });

  it("ignores non-HTML assets, which have no size floor worth guessing", () => {
    const withCss = [page("/styles.css", "body{}"), page("/index.html", realPage("Velvex"))];
    expect(assessDamage(withCss, served(["/index.html"]), good).ruined).toBe(false);
  });
});

describe("what may become the copy we go back to", () => {
  it("promotes a sound source", () => {
    expect(isPromotable([page("/index.html", realPage("Velvex"))])).toBe(true);
  });

  it("never promotes a source that is already broken", () => {
    expect(isPromotable([page("/index.html", "tiny")])).toBe(false);
  });

  it("never promotes nothing", () => {
    expect(isPromotable([])).toBe(false);
  });
});

describe("the stop that prevents a deploy loop", () => {
  const now = new Date("2026-08-29T12:00:00Z");

  it("counts only the last day", () => {
    const ledger = { at: ["2026-08-29T11:00:00Z", "2026-08-27T11:00:00Z"] };
    expect(restoresToday(ledger, now)).toBe(1);
  });

  it("stops once the day's allowance is used", () => {
    const at = Array.from({ length: MAX_RESTORES_PER_DAY }, () => "2026-08-29T10:00:00Z");
    expect(restoresToday({ at }, now)).toBeGreaterThanOrEqual(MAX_RESTORES_PER_DAY);
  });

  it("copes with no ledger and with junk timestamps", () => {
    expect(restoresToday(null, now)).toBe(0);
    expect(restoresToday({ at: ["not-a-date"] }, now)).toBe(0);
  });
});

describe("what the autonomy boundary lets this agent do", () => {
  const decide = (action: ProposedAction) =>
    evaluate({
      action,
      ctx: ruleContext(),
      routineRules: siteIntegrityAgent.routineRules,
      approvalRules: siteIntegrityAgent.approvalRules,
      approvedChannels: siteIntegrityAgent.approvedChannels,
    });

  it("lets a restore run without waiting for approval", async () => {
    // The whole point. A restore that queues is a restore that happens after
    // the owner wakes up, which is the failure this was built to remove.
    const decision = await decide({
      type: "site_restore",
      summary: "Restoring the site",
      channel: "site",
      payload: { files: { "/index.html": "<html></html>" } },
    });
    expect(decision.classification).toBe("routine");
  });

  it("still refuses to let it write anything new to the site", async () => {
    const decision = await decide({
      type: "site_edit",
      summary: "Improve the homepage meta description",
      channel: "site",
      payload: {},
    });
    expect(decision.classification).toBe("needs_approval");
  });

  it("keeps plain reporting routine", async () => {
    const decision = await decide({
      type: "observation",
      summary: "Site drift on /faq.html",
      payload: {},
    });
    expect(decision.classification).toBe("routine");
  });
});
