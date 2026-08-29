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

  it("starts a run rather than waiting for it", () => {
    // Holding the request open until the agent finished is what produced a 524
    // while the Worker kept spending. The button starts the work and the status
    // board reports it.
    expect(body).toContain("Started ");
    expect(body).not.toContain("'Fired '");
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

describe("a run that stopped reporting", () => {
  const body = scriptBody(html);

  /** Pull the two pure staleness helpers out of the emitted page and run them. */
  function staleness() {
    const start = body.indexOf("const STALE_AFTER_MS");
    const end = body.indexOf("function nodeCard");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(
      body.slice(start, end) + "\nreturn { runIsStale, lastSignOfLife, STALE_AFTER_MS };"
    )() as {
      runIsStale: (rt: unknown) => boolean;
      lastSignOfLife: (rt: unknown) => number;
      STALE_AFTER_MS: number;
    };
  }

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("calls a heartbeating run live", () => {
    const { runIsStale } = staleness();
    expect(
      runIsStale({ status: "running", startedAt: ago(40 * 60_000), heartbeatAt: ago(3_000) })
    ).toBe(false);
  });

  it("calls a run with a long-dead heartbeat stalled", () => {
    // The real incident: a Worker killed thirty seconds in left a row reading
    // "running" for half an hour, and the dot pulsed amber the whole time.
    const { runIsStale } = staleness();
    expect(
      runIsStale({ status: "running", startedAt: ago(30 * 60_000), heartbeatAt: ago(29 * 60_000) })
    ).toBe(true);
  });

  it("falls back to the last thought when a row predates heartbeats", () => {
    const { runIsStale } = staleness();
    const old = { status: "running", startedAt: ago(60 * 60_000), thoughts: [{ at: ago(20 * 60_000), text: "x" }] };
    const fresh = { status: "running", startedAt: ago(60 * 60_000), thoughts: [{ at: ago(2_000), text: "x" }] };
    expect(runIsStale(old)).toBe(true);
    expect(runIsStale(fresh)).toBe(false);
  });

  it("never calls a finished run stalled", () => {
    const { runIsStale } = staleness();
    expect(runIsStale({ status: "idle", startedAt: ago(99 * 60_000) })).toBe(false);
    expect(runIsStale({ status: "failed", startedAt: ago(99 * 60_000) })).toBe(false);
    expect(runIsStale(undefined)).toBe(false);
  });

  it("stops a dead row from holding the page on the fast poll", () => {
    // Otherwise one zombie makes the dashboard poll every three seconds forever.
    expect(body).toContain("r.status === 'running' && !runIsStale(r)");
  });
});

describe("sections that outgrow their authored box", () => {
  const body = scriptBody(html);

  // The behaviour itself needs a browser: Marketing renders 391px tall against
  // an authored 300, so the Sales box was painted over Social Engagement's
  // cadence label. Verified with Playwright against a real Chromium, where
  // elementFromPoint at the label's centre returned "section sales" before this
  // and the label itself after. What is asserted here is that the measuring
  // step still exists and still runs before the wires are drawn.
  it("restacks from measured heights rather than authored ones", () => {
    expect(body).toContain("function restackSections");
    expect(body).toContain("el.offsetHeight + SECTION_GAP");
  });

  it("restacks before drawing wires, so the lines land on moved nodes", () => {
    expect(body).toMatch(/restackSections\(\);\s*renderWires\(\)/);
  });

  it("carries the library with the section it hangs off", () => {
    expect(body).toContain('document.querySelector(\'[data-kind="library"]\')');
  });
});
