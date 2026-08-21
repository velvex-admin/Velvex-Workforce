#!/usr/bin/env node
// Seed the site source the SEO agent edits.
//
// The site is deployed by dragging a folder into Netlify, which means the only
// copy of its source is that folder. This uploads it once, so the agent has a
// known-good source to edit and deploy from. Re-run it whenever you change the
// site by hand, so the agent's copy does not fall behind what is published.
//
//   node scripts/seed-site-source.mjs <folder> <worker-base-url>
//
// Example:
//   node scripts/seed-site-source.mjs ~/velvex-site \
//     https://velvex-vx03.a99339744.workers.dev/x/<APP_PATH_SECRET>

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const [folder, base] = process.argv.slice(2);
if (!folder || !base) {
  console.error("usage: node scripts/seed-site-source.mjs <folder> <worker-base-url>");
  process.exit(1);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = await walk(folder);
const source = {};
for (const file of files) {
  // Netlify paths are absolute with forward slashes, whatever the OS uses.
  const path = "/" + relative(folder, file).split(sep).join("/");
  source[path] = await readFile(file, "utf8");
}

const paths = Object.keys(source).sort();
console.log(`${paths.length} files:`);
for (const path of paths) console.log(`  ${path.padEnd(32)} ${source[path].length} bytes`);

const res = await fetch(`${base.replace(/\/$/, "")}/api/state/site.source`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(source),
});
console.log(res.ok ? "\nSeeded." : `\nFailed: ${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
