// Runs a SQL file in one transaction as the staff role, printing its notices. For the synthetic
// demo study in scratch databases (the file itself refuses to run in clinical_trials).
//   DATABASE_NAME=assistant_scratch npm run seed -- db/seeds/demo_study.sql
import { readFileSync } from "node:fs";
import pg from "pg";
import { config } from "../config.ts";
import { pgConfig } from "../db.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run seed -- <file.sql>");
  process.exit(1);
}
const client = new pg.Client(pgConfig(config.staffDatabaseUrl));
client.on("notice", (n) => console.log(n.message));
await client.connect();
try {
  await client.query("begin");
  await client.query(readFileSync(file, "utf8"));
  await client.query("commit");
  const { rows: [{ db }] } = await client.query("select current_database() as db");
  console.log(`${db}: ran ${file}`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
