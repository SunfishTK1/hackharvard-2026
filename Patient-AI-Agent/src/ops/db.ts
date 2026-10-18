// Trial Ops' own connection, as the platform's manager_agent role: the ops.* views and the
// approval function, nothing else. Separate from Sage's person-scoped pool.
import pg from "pg";
import { config } from "../config.ts";
import { pgConfig, type Query } from "../db.ts";

let pool: pg.Pool | undefined;

export const opsEnabled = () => config.ops.databaseUrl !== undefined;

function opsPool(): pg.Pool {
  const url = config.ops.databaseUrl;
  if (!url) throw new Error("Trial Ops is off: set TRIAL_OPS_DATABASE_URL (the manager_agent login).");
  pool ??= new pg.Pool({ ...pgConfig(url), max: 4 });
  return pool;
}

/** One statement, autocommit. */
export const ops: Query = async (text, values) => (await opsPool().query(text, values)).rows;

/** Several statements in one transaction. */
export async function opsTx<T>(work: (q: Query) => Promise<T>): Promise<T> {
  const client = await opsPool().connect();
  try {
    await client.query("begin");
    const result = await work(async (text, values) => (await client.query(text, values)).rows);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeOps(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
