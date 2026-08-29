// Structured-output schemas are sent to the Messages API, which accepts only a
// subset of JSON Schema. A rejected keyword is invisible until an agent runs in
// production: the request 400s before the model is invoked, so it costs nothing
// and produces nothing, and surfaces only as a logged error. That is exactly how
// `maxItems` silently broke drafting on all three channel strategists.
//
// This asserts against the real schema objects, so it cannot drift from what is
// actually sent. When a new schema is added anywhere, add it to SCHEMAS below.

import { describe, expect, it } from "vitest";
import { DRAFT_SCHEMA } from "../src/agents/marketing/channel-agent.js";
import { BRIEF_SCHEMA, DISCOVERY_SCHEMA, SCAN_SCHEMA } from "../src/core/intel.js";

/** Every structured-output schema in the codebase. */
const SCHEMAS: Array<[string, unknown]> = [
  ["DRAFT_SCHEMA", DRAFT_SCHEMA],
  ["BRIEF_SCHEMA", BRIEF_SCHEMA],
  // Both of these were live and unregistered: the discovery pass has been
  // sending DISCOVERY_SCHEMA since the agent shipped and nothing here would
  // have caught a maxItems added to it.
  ["DISCOVERY_SCHEMA", DISCOVERY_SCHEMA],
  ["SCAN_SCHEMA", SCAN_SCHEMA],
];

/** Keywords the API rejects inside an output_config schema. */
const REJECTED = ["maxItems", "minItems", "uniqueItems", "patternProperties"];

/** Every key path present anywhere in a nested object. */
function keyPaths(value: unknown, trail: string[] = []): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => keyPaths(item, [...trail, String(i)]));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    [...trail, key].join("."),
    ...keyPaths(child, [...trail, key]),
  ]);
}

describe("structured-output schemas", () => {
  for (const [name, schema] of SCHEMAS) {
    const paths = keyPaths(schema);

    for (const keyword of REJECTED) {
      it(`${name} does not use "${keyword}", which the API rejects`, () => {
        const offenders = paths.filter((path) => path.split(".").includes(keyword));
        expect(offenders).toEqual([]);
      });
    }

    it(`${name} is a non-empty object schema`, () => {
      expect(paths.length).toBeGreaterThan(0);
    });
  }
});
