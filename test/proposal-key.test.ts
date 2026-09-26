import { describe, expect, it } from "vitest";
import {
  MAX_KEY_LENGTH,
  contentHash,
  dedupeKey,
  proposalContent,
} from "../src/core/proposal-key.js";
import type { ProposedAction } from "../src/core/types.js";

const metaEdit = (after: string): ProposedAction => ({
  type: "site_edit",
  summary: "meta_description on /faq.html: no meta description",
  channel: "site",
  target: "/faq.html",
  payload: {
    path: "/faq.html",
    kind: "meta_description",
    before: "</title>",
    after,
    fullRestructure: false,
  },
  dedupeKey: "seo:meta_description:/faq.html",
});

const wrongPrice = "</title>\n<meta name=\"description\" content=\"A diagnostic. $999, delivered in 24 hours.\">";
const rightPrice = "</title>\n<meta name=\"description\" content=\"A diagnostic. $149 for the first 10 clients, then $999.\">";

describe("dedupeKey", () => {
  // The failure this fixes: /faq.html has no meta description. The agent
  // proposed one quoting $999 alone, it was rejected, and the rejected row
  // held the key forever — so the corrected draft could never be queued.
  it("lets corrected wording through after the original was rejected", () => {
    expect(dedupeKey("seo_site", metaEdit(wrongPrice)))
      .not.toBe(dedupeKey("seo_site", metaEdit(rightPrice)));
  });

  it("still suppresses the very same proposal", () => {
    expect(dedupeKey("seo_site", metaEdit(wrongPrice)))
      .toBe(dedupeKey("seo_site", metaEdit(wrongPrice)));
  });

  it("keeps the finding readable in the key, so the queue stays diagnosable", () => {
    expect(dedupeKey("seo_site", metaEdit(wrongPrice)))
      .toContain("seo_site:seo:meta_description:/faq.html:");
  });

  it("separates the same wording proposed by different agents", () => {
    expect(dedupeKey("seo_site", metaEdit(wrongPrice)))
      .not.toBe(dedupeKey("content", metaEdit(wrongPrice)));
  });

  it("falls back to type, target and summary when no dedupeKey is given", () => {
    const bare: ProposedAction = { type: "observation", summary: "something", payload: {} };
    expect(dedupeKey("x", bare)).toContain("x:observation||something:");
  });

  // A long basis must shorten the basis, never the hash. Truncating the whole
  // string would drop the hash exactly when the basis is long, and two long
  // proposals about the same finding would collide back into one row - the
  // very bug this key exists to prevent.
  it("fits the column", () => {
    const long = metaEdit("x".repeat(5000));
    long.dedupeKey = "y".repeat(400);
    expect(dedupeKey("seo_site", long).length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
  });

  it("keeps the hash when the basis is far too long to fit", () => {
    const a = metaEdit("x".repeat(5000));
    const b = metaEdit("z".repeat(5000));
    a.dedupeKey = "y".repeat(400);
    b.dedupeKey = "y".repeat(400);
    const ka = dedupeKey("seo_site", a);
    const kb = dedupeKey("seo_site", b);
    expect(ka).not.toBe(kb);
    expect(ka.slice(-8)).toBe(contentHash(proposalContent(a)));
  });
});

describe("proposalContent", () => {
  it("does not depend on the order payload keys were built in", () => {
    const a: ProposedAction = { type: "site_edit", summary: "s", payload: { a: 1, b: 2 } };
    const b: ProposedAction = { type: "site_edit", summary: "s", payload: { b: 2, a: 1 } };
    expect(proposalContent(a)).toBe(proposalContent(b));
  });
});

describe("contentHash", () => {
  it("is stable across calls", () => {
    expect(contentHash("velvex")).toBe(contentHash("velvex"));
  });
  it("separates near-identical text", () => {
    expect(contentHash("$999")).not.toBe(contentHash("$149"));
  });
});
