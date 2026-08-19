import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE, scanForTells, softenTells } from "../src/core/voice.js";

describe("the voice profile", () => {
  it("is the doc's Option B default, in one swappable place", () => {
    expect(DEFAULT_VOICE.source).toBe("default-option-b");
  });

  it("catches em dashes, which the profile bans outright", () => {
    expect(scanForTells("We looked at the process — it stalls at invoicing.")).toHaveLength(1);
    expect(scanForTells("We looked at the process. It stalls at invoicing.")).toHaveLength(0);
  });

  it("catches the stock AI cadences", () => {
    expect(scanForTells("This isn't about software. It's about how work moves.").length).toBeGreaterThan(0);
    expect(scanForTells("It is not just a tool, it's a way of working.").length).toBeGreaterThan(0);
  });

  it("catches banned phrases and comment bait", () => {
    expect(scanForTells("In today's fast-paced world, speed wins.").length).toBeGreaterThan(0);
    expect(scanForTells("That is how we found it. Thoughts?").length).toBeGreaterThan(0);
  });

  it("passes copy that reads like a person wrote it", () => {
    const text =
      "A client lost two days a week chasing invoices nobody owned. " +
      "We found it in an afternoon. The fix was a shared inbox and one name against each account.";
    expect(scanForTells(text)).toHaveLength(0);
  });

  it("repairs the mechanical tells rather than throwing the draft away", () => {
    expect(softenTells("Two days a week — gone.")).toBe("Two days a week, gone.");
    expect(scanForTells(softenTells("Two days a week — gone."))).toHaveLength(0);
  });
});
