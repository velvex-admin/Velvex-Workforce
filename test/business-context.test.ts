import { describe, expect, it } from "vitest";
import { BUSINESS, BUSINESS_CONTEXT } from "../src/core/business.js";

// Velvex has two prices, and the rule stated on `introPriceUsd` is that an
// agent must never give one without the other. That rule only binds if it
// reaches the model, and BUSINESS_CONTEXT is the only route it takes.
//
// It did not. The price line interpolated `priceUsd` alone, so all eight
// writing agents were told "Price: $999 per engagement" and told never to
// state a price differing from it. On 2026-08-22 the SEO agent duly published
// "$999, delivered in 24 hours" as the live homepage meta description, with no
// mention of the intro rate. It obeyed its prompt exactly.
describe("BUSINESS_CONTEXT pricing", () => {
  const priceLine = BUSINESS_CONTEXT.split("\n").find((line) => line.startsWith("Price:"));

  it("states the intro rate, its cap and the standing price together", () => {
    expect(priceLine).toBeDefined();
    expect(priceLine).toContain(`$${BUSINESS.introPriceUsd}`);
    expect(priceLine).toContain(`$${BUSINESS.priceUsd}`);
    expect(priceLine).toContain(String(BUSINESS.introSeats));
  });

  it("never presents the standing price as the only price", () => {
    // The exact failure: a line naming 999 and nothing else.
    expect(priceLine).not.toMatch(/^Price: \$\d+ per engagement\./);
  });

  it("tells the model to confirm seat availability rather than commit", () => {
    expect(BUSINESS_CONTEXT.toLowerCase()).toContain("confirm");
  });
});

describe("the vocabulary every writing agent is handed", () => {
  // This file was faithfully copied from the site, and the site was two versions
  // behind the product: v0.1 and six differently-named "nodes", while the engine
  // had moved to v1.0 and seven engines. BUSINESS_CONTEXT goes into the system
  // prompt of every agent that writes anything, so the whole system was
  // describing a superseded model of its own product — copy that reads fine and
  // contradicts the page it points at.
  it("names the engine at the version the product actually is", () => {
    expect(BUSINESS.engine.version).toBe("v1.0");
    expect(BUSINESS_CONTEXT).toContain("currently v1.0");
    // v0.1 appears once and only inside the clause marking it superseded.
    // Naming the old version explicitly is worth more than omitting it: the
    // model has seen it on pages of the site that are still being updated.
    expect(BUSINESS_CONTEXT.match(/v0\.1/g) ?? []).toHaveLength(1);
    expect(BUSINESS_CONTEXT).toContain("v0.1 engine is superseded");
  });

  it("carries the seven VDL engines, not the six superseded nodes", () => {
    expect(BUSINESS.engine.engines).toHaveLength(7);
    for (const engine of BUSINESS.engine.engines) {
      expect(BUSINESS_CONTEXT).toContain(engine);
    }
    for (const gone of ["Revenue Mechanics", "Channel Dependency", "Pressure Point Matrix"]) {
      expect(BUSINESS_CONTEXT).not.toContain(gone);
    }
  });

  it("carries the six VSL dimensions", () => {
    expect(BUSINESS.engine.dimensions).toHaveLength(6);
    expect(BUSINESS_CONTEXT).toContain("Growth Leverage");
  });

  it("tells an agent to stop using the old vocabulary rather than just omitting it", () => {
    // Omitting the old names leaves a model free to recall them from anywhere
    // else it saw them, including the pages of the site not yet updated.
    expect(BUSINESS_CONTEXT).toContain("superseded");
  });
});

// Declaring what you are not is table stakes in this category, measured on
// 2026-08-28: For The TECH Of It publishes "The diagnostic is a flat rate
// deliverable not a consulting engagement" at $1,497, and Level Up runs its own
// "This Is Not" list. `isNot` therefore carries nothing a competitor cannot
// copy by lunchtime.
//
// What no provider with delivery revenue can write is that it sells nothing
// downstream, because the finding that recommends more work is the finding that
// pays them. Level Up credits its $2,500 AUD fee against the delivery
// engagement; Value Builder routes its free score into an advisor network.
// That absence is the differentiator, and it only reaches public copy if it is
// in BUSINESS_CONTEXT — the block closes with "if something is not stated here,
// do not invent it", so an agent that cannot read it here is forbidden from
// saying it.
describe("the terminal position", () => {
  const afterLine = BUSINESS_CONTEXT.split("\n").find((line) =>
    line.startsWith("What happens after:")
  );

  it("reaches the model at all", () => {
    expect(afterLine).toBeDefined();
  });

  it("states the structural absence, not only the absence of a consulting title", () => {
    // `isNot` already says "consulting" and "open-ended advisory relationship".
    // Neither is this claim. The delivery arm is the thing that cannot be copied.
    expect(afterLine).toContain("no delivery arm");
    expect(afterLine).toContain("we do not sell the work the Ledger recommends");
  });

  it("names all four things that do not happen downstream", () => {
    for (const absent of [
      "no delivery engagement",
      "no advisor referral",
      "no fee credited toward later work",
      "no retainer",
    ]) {
      expect(afterLine).toContain(absent);
    }
  });

  it("frames the 30/90/180 follow-up as a check rather than a next step", () => {
    // A follow-up that reads as a next step re-opens the relationship the
    // terminal claim just closed, which is the one way this copy defeats itself.
    expect(afterLine).toContain("30, 90 and 180 days is a check on the Ledger");
    expect(afterLine).toContain("rather than a next step");
  });

  it("puts the guarantee on the artefact rather than on downstream work", () => {
    expect(afterLine).toContain("guarantee sits on the Ledger itself");
  });
});
