// Postgres access. Every query about a person runs in asPerson(), which opens a transaction and
// calls assistant.use_person(): row-level security then limits the patient_assistant role to that
// one person's rows, whatever the SQL asks for.
import pg from "pg";
import { config } from "./config.ts";

export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<R[]>;

/** Connection settings for a URL. The database uses a self-signed certificate: encrypt, but don't verify the chain. */
export function pgConfig(url: string): pg.ClientConfig {
  const parsed = new URL(url);
  const wantsTls = parsed.searchParams.get("sslmode") === "require";
  parsed.searchParams.delete("sslmode");
  return { connectionString: parsed.toString(), ssl: wantsTls ? { rejectUnauthorized: false } : undefined };
}

export const pool = new pg.Pool({ ...pgConfig(config.databaseUrl), max: 8 });
pool.on("error", (error) => console.error("db: idle client error", error.message));

const bind = (client: pg.PoolClient): Query => async (text, values) => (await client.query(text, values)).rows;

/** Runs `work` in a transaction scoped to one person. */
export async function asPerson<T>(personId: string, work: (q: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select assistant.use_person($1)", [personId]);
    const result = await work(bind(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Queries that aren't about one person: trial content, token lookup, finding who is texting. */
export const shared: Query = async (text, values) => (await pool.query(text, values)).rows;
