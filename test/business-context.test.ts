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
