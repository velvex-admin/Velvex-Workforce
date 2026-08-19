#!/usr/bin/env node
// Applies db/migrations/*.sql to the VX-03 Supabase project.
//
// Needs a direct Postgres connection string, which is the one credential the
// service-role key cannot stand in for: PostgREST (what the service key talks
// to) executes queries, not DDL.
//
//   Supabase dashboard -> Connect -> "Connection string" -> URI
//
//   DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres' \
//     npm run db:apply
//
// If you would rather not handle a connection string: open the SQL editor in
// the Supabase dashboard, paste the contents of the migration file, and run it.
// Same result — this script exists so it can be repeated without clicking.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "db", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set.\n\n" +
      "Get it from the Supabase dashboard -> Connect -> Connection string (URI),\n" +
      "or paste db/migrations/0001_orchestration_layer.sql into the SQL editor instead."
  );
  process.exit(1);
}

let pg;
try {
  pg = await import("pg");
} catch {
  console.error("The 'pg' package is missing. Run: npm install");
  process.exit(1);
}

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`No .sql files in ${migrationsDir}`);
  process.exit(1);
}

const client = new pg.default.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    process.stdout.write(`applying ${file} ... `);
    await client.query(sql);
    console.log("ok");
  }

  const { rows } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('reports','memory','pending_approvals')
      order by table_name`
  );
  console.log(`\ntables present: ${rows.map((r) => r.table_name).join(", ") || "(none)"}`);
  if (rows.length !== 3) {
    console.error("Expected all three tables. Check the output above.");
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
