#!/usr/bin/env node
//
// What still needs doing after this branch is deployed, plus the check that
// says the deploy did not break the site.
//
//   usage: node scripts/post-deploy-check.mjs <worker-base> <app-path-secret>
//
// The two pauses were cleared live on 2026-08-29 and need nothing here. What
// remains is the LinkedIn partner queue: it holds one post repeated 131 times,
// written before the handover fix, and the route that collapses them ships in
// this branch. Nothing can collect that queue while the partner integration is
// off, so the repeats are inert rather than urgent -- but they are still work
// waiting to be published twice over the moment it is switched on.
//
// It also re-checks the site source and the verified restore point, because a
// deploy is exactly when it is worth knowing that both are intact.

const [base, secret] = process.argv.slice(2);

if (!base || !secret) {
  console.error("usage: node scripts/post-deploy-check.mjs <worker-base> <app-path-secret>");
  process.exit(2);
}

const api = `${base.replace(/\/+$/, "")}/x/${secret}/api`;

async function call(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json" } : {},
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

/** Mirrors checkStoredSource() in src/core/site-integrity.ts. */
function critical(source) {
  const problems = [];
  for (const [path, content] of Object.entries(source ?? {})) {
    if (!/\.html?$/i.test(path)) continue;
    const text = String(content ?? "");
    if (text.length < 1000) problems.push(`${path}: only ${text.length} characters`);
    else if (!/<\/html\s*>/i.test(text) || !/<\/title\s*>/i.test(text)) {
      problems.push(`${path}: ${text.length} characters but not a whole document`);
    }
  }
  return problems;
}

try {
  console.log("── Site source");
  const { value: source } = await call("/state/site.source");
  const sourceProblems = critical(source);
  for (const [path, content] of Object.entries(source ?? {})) {
    console.log(`   ${String(String(content).length).padStart(7)}  ${path}`);
  }
  if (sourceProblems.length) {
    console.error(`   DAMAGED:\n     ${sourceProblems.join("\n     ")}`);
  } else {
    console.log("   whole");
  }

  console.log("\n── Verified restore point (site.source.last_good)");
  const { value: lastGood } = await call("/state/site.source.last_good");
  if (!lastGood?.files) {
    console.error("   NOT SET. Site-Integrity promotes it on its next clean hourly pass.");
  } else {
    const stale = critical(lastGood.files);
    console.log(`   saved ${lastGood.savedAt}, ${Object.keys(lastGood.files).length} paths, ${stale.length ? "DAMAGED" : "whole"}`);
  }

  console.log("\n── LinkedIn partner queue");
  const compact = await call("/linkedin/queue/compact", { method: "POST", body: "{}" });
  console.log(`   ${compact.note}`);

  console.log("\n── Schedule overrides");
  const { schedules, stale } = await call("/schedules");
  const entries = Object.entries(schedules ?? {});
  if (!entries.length) console.log("   (none — every agent is on its cadence in code)");
  for (const [agentId, override] of entries) {
    console.log(
      `   ${agentId.padEnd(20)} ${override.cadence}` +
        (override.builtInCadence ? `   (code cadence when set: ${override.builtInCadence})` : "")
    );
  }
  for (const entry of stale ?? []) {
    console.log(
      `   ! ${entry.agentId}: this override outranks a cadence changed since it was set ` +
        `(${entry.override.builtInCadence} -> ${entry.builtInCadence})`
    );
  }

  process.exit(sourceProblems.length ? 1 : 0);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
}
