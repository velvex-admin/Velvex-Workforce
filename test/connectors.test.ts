// Connectors without credentials must refuse loudly. A silent success would
// show up in the reports table as a post that never existed.

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { readiness } from "../src/env.js";
import { facebookConnector } from "../src/connectors/facebook.js";
import { xConnector } from "../src/connectors/x.js";
import { linkedInStatus, partnerTokenMatches } from "../src/connectors/linkedin.js";
import { connectorStatuses } from "../src/connectors/registry.js";
import { ConnectorInactiveError } from "../src/connectors/types.js";

const bareEnv = {
  VX_ENV: "test",
  SUPABASE_URL: "https://example.supabase.co",
  MODEL_ID: "claude-opus-5",
  FACEBOOK_ENABLED: "false",
  X_ENABLED: "false",
  LINKEDIN_INTEGRATION_ENABLED: "false",
  OPS_PIPELINE_MONITOR_ENABLED: "false",
  INTEL_WEB_RESEARCH_ENABLED: "false",
} as Env;

describe("Facebook connector", () => {
  it("reports itself inactive and says exactly what it needs", () => {
    const status = facebookConnector.status(bareEnv);
    expect(status.active).toBe(false);
    expect(status.missing).toContain("FACEBOOK_PAGE_ID");
    expect(status.missing).toContain("FACEBOOK_PAGE_ACCESS_TOKEN");
  });

  it("refuses to publish rather than pretending to", async () => {
    await expect(facebookConnector.publish({ text: "hello" }, bareEnv)).rejects.toBeInstanceOf(
      ConnectorInactiveError
    );
  });

  it("stays inactive if the flag is on but the credentials are missing", () => {
    const status = facebookConnector.status({ ...bareEnv, FACEBOOK_ENABLED: "true" } as Env);
    expect(status.active).toBe(false);
  });
});

describe("X connector", () => {
  it("reports itself inactive and lists all four secrets", () => {
    const status = xConnector.status(bareEnv);
    expect(status.active).toBe(false);
    expect(status.missing).toEqual(
      expect.arrayContaining(["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"])
    );
  });

  it("refuses to publish and to reply", async () => {
    await expect(xConnector.publish({ text: "hello" }, bareEnv)).rejects.toBeInstanceOf(
      ConnectorInactiveError
    );
    await expect(
      xConnector.reply({ inReplyTo: "1", text: "hello", kind: "comment" }, bareEnv)
    ).rejects.toBeInstanceOf(ConnectorInactiveError);
  });
});

describe("LinkedIn integration point", () => {
  it("is an external build, not an agent we run", () => {
    const status = linkedInStatus(bareEnv);
    expect(status.active).toBe(false);
    expect(status.note).toContain("External build");
  });

  it("rejects a wrong or absent partner token", () => {
    const env = { ...bareEnv, LINKEDIN_PARTNER_TOKEN: "correct-token-value" } as Env;
    expect(partnerTokenMatches(env, "correct-token-value")).toBe(true);
    expect(partnerTokenMatches(env, "wrong-token-value!")).toBe(false);
    expect(partnerTokenMatches(env, "correct")).toBe(false);
    expect(partnerTokenMatches(env, null)).toBe(false);
    expect(partnerTokenMatches(bareEnv, "anything")).toBe(false);
  });
});

describe("readiness", () => {
  it("names the three secrets that block the whole app", () => {
    const ready = readiness(bareEnv);
    expect(ready.ready).toBe(false);
    expect(ready.blocking).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_PATH_SECRET"])
    );
  });

  it("covers every channel, and both of LinkedIn's two routes", () => {
    // LinkedIn appears twice, and that is the decision rather than an oversight.
    // There are genuinely two ways to that page — the partner queue an outside
    // agent drains, and direct posting through our own connector — and they go
    // live independently. One row would hide the difference between a draft
    // handed to a queue and a draft that reached LinkedIn.
    const statuses = connectorStatuses(bareEnv);
    expect(statuses.map((status) => status.channel).sort()).toEqual([
      "facebook",
      "linkedin",
      "linkedin",
      "x",
    ]);
    expect(statuses.every((status) => status.active === false)).toBe(true);
  });

  it("says which LinkedIn route each row is, since the channel name cannot", () => {
    const linkedin = connectorStatuses(bareEnv).filter((s) => s.channel === "linkedin");
    expect(linkedin).toHaveLength(2);
    const notes = linkedin.map((s) => s.note ?? "").join(" | ");
    expect(notes).toMatch(/partner|queue/i);
    expect(notes).toMatch(/Community Management API|direct/i);
  });

  it("names exactly what direct LinkedIn posting is waiting on", () => {
    // The owner reads connectors[].missing off /api/status to find out what to
    // set. A vague entry there means a support conversation instead.
    const direct = connectorStatuses(bareEnv).find(
      (s) => s.channel === "linkedin" && /Community Management API|direct/i.test(s.note ?? "")
    );
    expect(direct?.missing).toEqual(
      expect.arrayContaining([
        'LINKEDIN_DIRECT_ENABLED="true"',
        "LINKEDIN_ORG_ID",
        "LINKEDIN_ACCESS_TOKEN",
      ])
    );
  });
});
