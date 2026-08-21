// Structured-output schemas go to the Messages API, which rejects a subset of
// JSON Schema keywords. Getting one wrong is invisible until an agent runs in
// production and fails with a 400 — exactly how the X strategist broke on
// `maxItems`. This test reads the actual source and fails the build instead.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Keywords the API rejects inside an output_config schema. */
const REJECTED = ["maxItems", "minItems", "uniqueItems", "patternProperties"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("structured-output schemas", () => {
  const files = sourceFiles("src");

  for (const keyword of REJECTED) {
    it(`never uses "${keyword}", which the API rejects`, () => {
      const offenders = files.filter((file) => {
        const text = readFileSync(file, "utf8");
        // Only count real usage, not a comment explaining why we avoid it.
        return text
          .split("\n")
          .some((line) => line.includes(`${keyword}:`) && !line.trimStart().startsWith("//"));
      });
      expect(offenders).toEqual([]);
    });
  }
});
