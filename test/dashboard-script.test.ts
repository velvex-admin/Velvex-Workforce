// The dashboard is a ~1100 line page emitted from a single TypeScript template
// literal, which means every backtick, `${` and backslash in the browser code
// has to be escaped for the TypeScript compiler first and the browser second.
//
// Getting that wrong does not fail the build and does not fail a typecheck. It
// compiles cleanly and ships a page whose script block dies on the first line
// the browser parses, so the canvas is simply blank. That happened while the
// library panel was being added: an `onclick` handler written with `\'` inside
// the outer template literal emitted a bare quote and closed the string early.
//
// So the emitted script is parsed here, as a browser would parse it. It is not
// executed, because there is no DOM: parsing is what catches the escaping
// mistakes, and executing would only test vitest's environment.

import { describe, expect, it } from "vitest";
import { dashboardHtml } from "../src/ui/dashboard.js";

const html = dashboardHtml("/x/test-secret");

/** Everything between the last <script> and its closing tag. */
function scriptBody(page: string): string {
  const open = page.lastIndexOf("<script>");
  const close = page.lastIndexOf("</script>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return page.slice(open + "<script>".length, close);
}

describe("the emitted dashboard script", () => {
  const body = scriptBody(html);

  it("is syntactically valid JavaScript", () => {
    // new Function parses without running. A SyntaxError here is a page that
    // renders nothing in a browser.
    expect(() => new Function(body)).not.toThrow();
  });

  it("carries the base path through to the API helper", () => {
    expect(body).toContain('const BASE = "/x/test-secret"');
  });

  it("still has no unescaped template placeholder left in the browser code", () => {
    // A `${...}` that reached the emitted page means a value the server was
    // meant to substitute was written as a literal instead.
    expect(body).not.toMatch(/\$\{\s*(basePath|JSON\.stringify)/);
  });
});

describe("the intelligence library on the page", () => {
  const body = scriptBody(html);

  it("draws the library as its own node rather than as an agent", () => {
    expect(body).toContain('data-kind="library"');
    expect(body).toContain("LIBRARY_POS");
  });

  it("routes a click on the library to the library panel", () => {
    expect(body).toContain("kind === 'library'");
    expect(body).toContain("function openLibrary");
  });

  it("runs the cyan feed from the intelligence agent into the library", () => {
    expect(body).toContain('.node[data-id="competitive_intel"]');
    expect(body).toContain('class="ecg intel"');
    expect(body).toContain('class="ecg-node');
  });

  it("offers both ways of taking a brief out of the system", () => {
    expect(body).toContain("/markdown");
    expect(body).toContain("/page");
  });

  it("loads the library alongside everything else, not on demand only", () => {
    expect(body).toContain("/intel/briefs?limit=");
  });

  it("puts the answer box on the question the brief asked", () => {
    expect(body).toContain("function sendAnswer");
    expect(body).toContain("answer-box");
    expect(body).toContain("/intel/answer");
  });

  it("shows what has been ruled on and what is still in cooldown", () => {
    expect(body).toContain("function showVerdicts");
    expect(body).toContain("/intel/candidates");
    expect(body).toContain("cooldownDaysLeft");
  });

  it("shows what the agent has been told about Velvex", () => {
    expect(body).toContain("function showPosition");
    expect(body).toContain("/intel/position");
  });

  it("says the migration is missing rather than showing an empty shelf", () => {
    expect(body).toContain("function migrationNote");
    expect(body).toContain("0002_intelligence_layer.sql");
  });
});

// Everything on the canvas is absolutely positioned, so .canvas-inner collapses
// to 0x0 and the wires SVG inside it inherits that through inset:0. Until this
// was found, every ECG line in the page was being written into the DOM and then
// clipped away to nothing: the paths were correct, the box they drew into had no
// size. It is invisible to a typecheck and invisible to a test that only checks
// the paths exist, which is why the fix is asserted directly.
describe("the wires have somewhere to draw", () => {
  const body = scriptBody(html);

  it("measures the extent rather than assuming one", () => {
    expect(body).toContain("function canvasExtent");
    expect(body).toContain("getBoundingClientRect");
  });

  it("gives the canvas a real size before sizing the SVG to it", () => {
    const wires = body.slice(body.indexOf("function renderWires"));
    expect(wires).toContain("canvas.style.width");
    expect(wires).toContain("canvas.style.height");
    expect(wires.indexOf("canvas.style.width")).toBeLessThan(
      wires.indexOf("wires.setAttribute('width'")
    );
  });

  it("draws wires to a node's dot rather than to its label stack", () => {
    expect(body).toContain("function dotCentre");
    const wires = body.slice(body.indexOf("function renderWires"));
    expect(wires).not.toContain("nodeCentre(");
  });
});

describe("the page's own styling", () => {
  it("defines the intelligence colour before anything uses it", () => {
    const head = html.slice(0, html.indexOf("</style>"));
    expect(head).toContain("--intel:");
    expect(head).toContain(".node.library .dot");
    expect(head).toContain(".wires .ecg.intel");
  });
});
