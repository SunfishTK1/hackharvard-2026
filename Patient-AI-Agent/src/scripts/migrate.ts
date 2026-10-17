// Applies the assistant's migrations (db/migrations, dbmate-style "-- migrate:up / -- migrate:down"
// files) to the platform database, recording them in assistant.schema_migrations. Runs as a role
// that can act as app_owner (STAFF_DATABASE_URL, or the developer DATABASE_URL in Clinical-DB/.env).
//   npm run migrate            # apply pending migrations
//   npm run migrate -- status  # list applied and pending
//   npm run migrate -- down    # roll back the latest
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { config } from "../config.ts";
import { pgConfig } from "../db.ts";

const DIR = new URL("../../db/migrations/", import.meta.url);
const command = process.argv[2] ?? "up";

const migrations = readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().map((file) => {
  const text = readFileSync(new URL(file, DIR), "utf8");
  const [, up = "", down = ""] = text.split(/^-- migrate:(?:up|down)\s*$/m);
  return { version: file.split("_")[0], file, up, down };
});

const client = new pg.Client(pgConfig(config.staffDatabaseUrl));
await client.connect();
try {
  const { rows: [{ db }] } = await client.query("select current_database() as db");
  const exists = (await client.query("select to_regclass('assistant.schema_migrations') as t")).rows[0].t !== null;
  const applied = new Set<string>(exists ? (await client.query("select version from assistant.schema_migrations")).rows.map((r) => r.version) : []);

  if (command === "status") {
    for (const m of migrations) console.log(`${applied.has(m.version) ? "applied" : "pending"}  ${m.file}`);
  } else if (command === "up") {
    const pending = migrations.filter((m) => !applied.has(m.version));
    if (!pending.length) console.log(`${db}: up to date`);
    for (const m of pending) {
      await client.query("begin");
      try {
        await client.query(m.up);
        await client.query("insert into assistant.schema_migrations (version) values ($1)", [m.version]);
        await client.query("commit");
        console.log(`${db}: applied ${m.file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } else if (command === "down") {
    const latest = migrations.filter((m) => applied.has(m.version)).at(-1);
    if (!latest) console.log(`${db}: nothing to roll back`);
    else {
      await client.query("begin");
      try {
        await client.query(latest.down);
        if ((await client.query("select to_regclass('assistant.schema_migrations') as t")).rows[0].t) {
          await client.query("delete from assistant.schema_migrations where version = $1", [latest.version]);
        }
        await client.query("commit");
        console.log(`${db}: rolled back ${latest.file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } else {
    throw new Error(`Unknown command ${command}: use up, down or status.`);
  }
} finally {
  await client.end();
}
