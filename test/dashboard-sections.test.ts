import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/agents/registry.js";
import { dashboardHtml } from "../src/ui/dashboard.js";

// The canvas groups agents into three section boxes by batch. The box keys and
// the batch values agents declare are not the same word for Sales: agents say
// "sales_management", the box was keyed "sales". Matching on the key alone
// rendered "no agents in this batch" over Lead/Pipeline and Objection/FAQ, and
// did so silently for as long as the dashboard had existed.
//
// Any batch an agent declares must therefore appear in the page, or its agents
// are invisible on the map whatever else is true of them.
describe("dashboard sections cover every batch", () => {
  const html = dashboardHtml("/x/test");
  const batches = [...new Set(AGENTS.map((agent) => agent.batch))];

  it("has at least one agent in every batch it renders", () => {
    expect(batches.length).toBeGreaterThan(0);
  });

  /** The SECTION_LAYOUT literal alone, so unrelated mentions of a batch elsewhere
   *  in the page (Chief-of-Staff carries its own fallback object) cannot make a
   *  missing section look present. */
  const layout = html.slice(
    html.indexOf("const SECTION_LAYOUT"),
    html.indexOf("const COS_POS")
  );

  it.each(batches.filter((batch) => batch !== "orchestration"))(
    "gives batch %s a section box on the canvas",
    (batch) => {
      expect(layout).toContain(`batch: '${batch}'`);
    }
  );

  it("places Chief-of-Staff on its own rather than in a section", () => {
    expect(layout).not.toContain("orchestration");
    expect(html).toContain("chief_of_staff");
  });
});
