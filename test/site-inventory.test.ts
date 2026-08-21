// The inventory tells the SEO agent what each page currently has. If it reads a
// page wrong the agent proposes the wrong fix, so the parsing is worth pinning
// down — particularly the path keys, which must match the ones the writer edits.

import { describe, expect, it } from "vitest";
import { inventoryFromSource } from "../src/core/site-inventory.js";

const site = {
  "/index.html": `<html><head><title>Velvex — System Evaluation</title></head>
    <body><p>One two three</p><a href="/faq.html">pricing</a>
    <img src="/a.png" alt="A chart"><img src="/b.png"></body></html>`,
  "/faq.html": `<html><head><title>FAQ</title>
    <meta name="description" content="Common questions."></head>
    <body><p>Answer</p><a href="/index.html">home</a></body></html>`,
  "/styles.css": "body{color:red}",
};

describe("building the inventory from source", () => {
  const pages = inventoryFromSource(site);

  it("keys pages by the same paths the writer edits", () => {
    expect(pages.map((p) => p.path)).toEqual(["/faq.html", "/index.html"]);
  });

  it("skips non-HTML files, which are deployed but not pages", () => {
    expect(pages.find((p) => p.path === "/styles.css")).toBeUndefined();
  });

  it("reads the title", () => {
    expect(pages.find((p) => p.path === "/index.html")?.title).toBe("Velvex — System Evaluation");
  });

  it("reports a missing meta description as absent, not empty", () => {
    const index = pages.find((p) => p.path === "/index.html");
    expect(index?.metaDescription).toBeUndefined();
    expect(pages.find((p) => p.path === "/faq.html")?.metaDescription).toBe("Common questions.");
  });

  it("distinguishes an image with no alt from one with empty alt", () => {
    const imgs = pages.find((p) => p.path === "/index.html")?.images ?? [];
    expect(imgs).toHaveLength(2);
    expect(imgs[0]?.alt).toBe("A chart");
    // Absent, not "" — an empty alt marks an image decorative on purpose.
    expect(imgs[1]?.alt).toBeUndefined();
  });

  it("counts visible words, ignoring markup", () => {
    const index = pages.find((p) => p.path === "/index.html");
    expect(index?.wordCount).toBeGreaterThan(0);
    expect(index?.wordCount).toBeLessThan(12);
  });

  it("counts inbound internal links per page", () => {
    expect(pages.find((p) => p.path === "/faq.html")?.inboundInternalLinks).toBe(1);
    expect(pages.find((p) => p.path === "/index.html")?.inboundInternalLinks).toBe(1);
  });

  it("ignores anchors and external links when counting", () => {
    const out = inventoryFromSource({
      "/a.html": '<a href="#top">x</a><a href="https://example.com">y</a><a href="/b.html">z</a>',
      "/b.html": "<p>b</p>",
    });
    expect(out.find((p) => p.path === "/b.html")?.inboundInternalLinks).toBe(1);
  });

  it("returns nothing for an empty source rather than throwing", () => {
    expect(inventoryFromSource({})).toEqual([]);
  });
});
