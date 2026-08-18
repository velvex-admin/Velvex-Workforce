// Worker environment: what is configured, what is a secret, and what is
// deliberately missing.

export interface Env {
  // --- vars (wrangler.toml) ------------------------------------------------
  VX_ENV: string;
  SUPABASE_URL: string;
  MODEL_ID: string;
  FACEBOOK_ENABLED: string;
  X_ENABLED: string;
  LINKEDIN_INTEGRATION_ENABLED: string;
  OPS_PIPELINE_MONITOR_ENABLED: string;

  // --- secrets (wrangler secret put) --------------------------------------
  /** The unguessable path segment every route lives under. */
  APP_PATH_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;

  // --- inactive integrations: unset on purpose ----------------------------
  FACEBOOK_PAGE_ID?: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  LINKEDIN_PARTNER_TOKEN?: string;
  OPS_PIPELINE_STATUS_URL?: string;
  OPS_PIPELINE_STATUS_TOKEN?: string;
}

export function flag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function requireSecret(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      `${String(name)} is not set. Set it with: wrangler secret put ${String(name)}`
    );
  }
  return value;
}

/**
 * A readiness picture the dashboard can render. Nothing here throws — the point
 * is to show what is live and what is waiting on a credential.
 */
export interface Readiness {
  ready: boolean;
  blocking: string[];
  detail: Record<string, { status: "live" | "inactive" | "missing"; note: string }>;
}

export function readiness(env: Env): Readiness {
  const detail: Readiness["detail"] = {};
  const blocking: string[] = [];

  const secret = (name: keyof Env, note: string, required: boolean) => {
    const present = typeof env[name] === "string" && (env[name] as string).length > 0;
    detail[String(name)] = {
      status: present ? "live" : required ? "missing" : "inactive",
      note,
    };
    if (required && !present) blocking.push(String(name));
  };

  secret("ANTHROPIC_API_KEY", "Claude Opus 5 — every agent's reasoning", true);
  secret("SUPABASE_SERVICE_ROLE_KEY", "reports, memory, pending_approvals", true);
  secret("APP_PATH_SECRET", "the unguessable URL segment", true);

  detail["facebook"] = {
    status:
      flag(env.FACEBOOK_ENABLED) && env.FACEBOOK_PAGE_ACCESS_TOKEN ? "live" : "inactive",
    note: "agent logic built; publishing blocked until FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN are set and FACEBOOK_ENABLED=true",
  };
  detail["x"] = {
    status: flag(env.X_ENABLED) && env.X_ACCESS_TOKEN ? "live" : "inactive",
    note: "agent logic built; publishing blocked until the four X_* secrets are set and X_ENABLED=true",
  };
  detail["linkedin"] = {
    status: flag(env.LINKEDIN_INTEGRATION_ENABLED) && env.LINKEDIN_PARTNER_TOKEN ? "live" : "inactive",
    note: "integration point only — the agent itself is an external build",
  };
  detail["ops_pipeline_monitor"] = {
    status: flag(env.OPS_PIPELINE_MONITOR_ENABLED) && env.OPS_PIPELINE_STATUS_URL ? "live" : "inactive",
    note: "read-only ops-pipeline monitoring; no Phase 0 credentials are wired into this project",
  };

  return { ready: blocking.length === 0, blocking, detail };
}
