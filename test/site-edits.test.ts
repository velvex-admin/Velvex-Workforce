// These exist because of a real failure. The SEO agent proposed adding a meta
// description to a page that had none, which it expressed as before:"" — and
// the writer's fallback replaced the whole file with the description. A 22kB
// page became 134 bytes and went live.
//
// The tests that passed beforehand used a hand-written non-empty anchor, so
// they exercised the mechanism as imagined rather than the input the agent
// actually produces. These use the real shape.

import { describe, expect, it } from "vitest";
import { altTextEdit, escapeAttribute, metaDescriptionEdit } from "../src/core/site-edits.js";

const page = (head: string, body = "<p>content</p>") =>
  `<!DOCTYPE html>\n<html><head>${head}</head><body>${body}</body></html>`;

describe("meta description edits", () => {
  it("anchors on the closing title tag when no description exists", () => {
    const html = page("<title>Velvex</title>");
    const edit = metaDescriptionEdit(html, "A diagnostic standard.");
    expect(edit).not.toBeNull();
    expect(edit!.before).toBe("</title>");
    expect(edit!.after).toContain("</title>");
    expect(edit!.after).toContain('content="A diagnostic standard."');
  });

  it("produces an anchor that is never empty", () => {
    const edit = metaDescriptionEdit(page("<title>V</title>"), "Text.");
    expect(edit!.before.length).toBeGreaterThan(0);
  });

  it("applying it keeps the whole page and adds one tag", () => {
    const html = page("<title>Velvex</title>");
    const edit = metaDescriptionEdit(html, "A diagnostic standard.")!;
    const out = html.replace(edit.before, edit.after);
    expect(out.length).toBeGreaterThan(html.length);
    expect(out).toContain("<body>");
    expect(out).toContain("</html>");
    expect((out.match(/name="description"/g) ?? []).length).toBe(1);
  });

  it("replaces an existing description rather than adding a second", () => {
    const html = page('<title>V</title><meta name="description" content="Old.">');
    const edit = metaDescriptionEdit(html, "New.")!;
    const out = html.replace(edit.before, edit.after);
    expect((out.match(/name="description"/g) ?? []).length).toBe(1);
    expect(out).toContain("New.");
    expect(out).not.toContain("Old.");
  });

  it("escapes quotes so the attribute cannot be broken out of", () => {
    const edit = metaDescriptionEdit(page("<title>V</title>"), 'He said "scale" first')!;
    expect(edit.after).toContain("&quot;scale&quot;");
    expect(edit.after.match(/content="/g)?.length).toBe(1);
  });

  it("refuses when there is no title to anchor against", () => {
    expect(metaDescriptionEdit("<html><body>no head</body></html>", "Text.")).toBeNull();
  });

  it("refuses when the anchor is ambiguous", () => {
    const html = "<title>A</title><title>B</title>";
    expect(metaDescriptionEdit(html, "Text.")).toBeNull();
  });
});

describe("alt text edits", () => {
  it("anchors on the whole img tag", () => {
    const html = page("<title>V</title>", '<img src="/chart.png">');
    const edit = altTextEdit(html, "/chart.png", "A revenue chart")!;
    expect(edit.before).toBe('<img src="/chart.png">');
    expect(edit.after).toContain('alt="A revenue chart"');
  });

  it("leaves an image that already has alt text alone", () => {
    const html = page("<title>V</title>", '<img src="/a.png" alt="existing">');
    expect(altTextEdit(html, "/a.png", "new")).toBeNull();
  });

  it("targets the right image when several are present", () => {
    const html = page("<title>V</title>", '<img src="/a.png"><img src="/b.png">');
    const edit = altTextEdit(html, "/b.png", "B")!;
    const out = html.replace(edit.before, edit.after);
    expect(out).toContain('<img src="/a.png">');
    expect(out).toContain('alt="B"');
    expect((out.match(/alt=/g) ?? []).length).toBe(1);
  });

  it("handles a self-closing tag without mangling it", () => {
    const html = page("<title>V</title>", '<img src="/a.png" />');
    const edit = altTextEdit(html, "/a.png", "A")!;
    expect(edit.after).toContain('alt="A"');
    expect(edit.after.endsWith("/>")).toBe(true);
  });
});

describe("attribute escaping", () => {
  it("neutralises quotes and angle brackets", () => {
    expect(escapeAttribute('a "b" <c>')).toBe("a &quot;b&quot; &lt;c&gt;");
  });

  it("escapes ampersands first so entities are not doubled", () => {
    expect(escapeAttribute("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });
});
