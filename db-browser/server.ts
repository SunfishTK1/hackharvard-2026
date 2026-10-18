// A read-only browser for the clinical trial database. Lists every schema, table and view with
// row counts; pages, sorts and searches rows; shows any row in full; follows foreign keys both
// ways. Every query runs in a read-only transaction.
//
// Locally (only on 127.0.0.1):
//   ssh -N -L 15432:localhost:5432 root@<server> &   # Postgres is firewalled; tunnel it
//   npm start                                       # http://localhost:4321
// Deployed: https://dbview.hackharvard2026.velroi.com, behind a shared password (BROWSER_PASSWORD;
// any username, unless BROWSER_USER is set). Without a password it can still run in public, but
// then contact details and access tokens are masked (see MASK).
//
// Connection: DATABASE_URL as given, or the developer DATABASE_URL in ../Clinical-DB/.env through
// the tunnel (DATABASE_HOST, default localhost:15432). DATABASE_NAME picks another database.
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "127.0.0.1";
const PASSWORD = process.env.BROWSER_PASSWORD || undefined;
const USERNAME = process.env.BROWSER_USER || undefined;
const LOGIN = Boolean(PASSWORD);
/** Open to the internet without a login: hide what identifies or grants access to a person. */
const MASK = !LOGIN && HOST !== "127.0.0.1" && HOST !== "localhost";
// Phone numbers, emails and iMessage handles keep their last two characters.
const PARTIAL = /(^|_)(phone|phone_number|email|handle|secure_handle)$/i;
// Link tokens (each opens someone's mini-apps), chat ids (they contain phone numbers), keys, IPs.
const HIDDEN = /(^|_)(token|card|session|external_space_id|external_thread_id|credential_id|public_key|ip_address|user_agent|auth_subject)$/i;

function masked(column: string, value: unknown): unknown {
  if (!MASK || value === null || value === undefined) return value;
  if (HIDDEN.test(column)) return "•••• hidden";
  if (PARTIAL.test(column)) {
    const text = String(value);
    return text.length > 4 ? `${"•".repeat(Math.min(8, text.length - 2))}${text.slice(-2)}` : "••••";
  }
  return value;
}
const PUBLIC = join(import.meta.dirname, "public");
const PAGE_SIZES = [25, 50, 100, 250];
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

function connection(): { url: string; tls: boolean } {
  let url = process.env.DATABASE_URL;
  const viaTunnel = !url;
  if (!url) {
    try {
      url = parseEnv(readFileSync(new URL("../Clinical-DB/.env", import.meta.url), "utf8")).DATABASE_URL;
    } catch {
      // handled below
    }
  }
  if (!url) throw new Error("Set DATABASE_URL (a role that can read every schema, e.g. developer).");
  const parsed = new URL(url.trim().replace(/^["'“”]+|["'“”]+$/g, ""));
  if (process.env.DATABASE_HOST || viaTunnel) parsed.host = process.env.DATABASE_HOST ?? "localhost:15432";
  if (process.env.DATABASE_NAME) parsed.pathname = `/${process.env.DATABASE_NAME}`;
  // The database uses a self-signed certificate: encrypt, but don't verify the chain.
  const tls = parsed.searchParams.get("sslmode") === "require";
  parsed.searchParams.delete("sslmode");
  return { url: parsed.toString(), tls };
}

const { url, tls } = connection();
const pool = new pg.Pool({
  connectionString: url,
  ssl: tls ? { rejectUnauthorized: false } : undefined,
  max: 4,
  // Read-only at the session level too: nothing here can change data.
  options: "-c default_transaction_read_only=on -c statement_timeout=15000",
  application_name: "db-browser",
});
pool.on("error", (error) => console.error("db:", error.message));

async function readOnly<T>(work: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    return await work(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  comment: string | null;
}

interface ForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  srcSchema: string;
  srcTable: string;
}

/** Every user table and view, with exact row counts. */
async function tables() {
  return readOnly(async (q) => {
    const { rows } = await q.query(
      `select n.nspname as schema, c.relname as name, c.relkind as kind, obj_description(c.oid, 'pg_class') as comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'v', 'm', 'p') and n.nspname <> all($1) and n.nspname not like 'pg_temp%'
         and has_table_privilege(c.oid, 'select')
       order by n.nspname, c.relname`, [SYSTEM_SCHEMAS]);
    const out = [];
    for (const t of rows) {
      let count: number | null = null;
      try {
        await q.query("savepoint c");
        count = Number((await q.query(`select count(*) as n from ${ident(t.schema)}.${ident(t.name)}`)).rows[0].n);
        await q.query("release savepoint c");
      } catch {
        await q.query("rollback to savepoint c");
      }
      out.push({ schema: t.schema, name: t.name, kind: { r: "table", p: "table", v: "view", m: "materialized view" }[t.kind as string], comment: t.comment, count });
    }
    return out;
  });
}

async function describe(q: pg.PoolClient, schema: string, table: string) {
  const { rows: [rel] } = await q.query(
    `select c.oid, c.relkind, obj_description(c.oid, 'pg_class') as comment from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'v', 'm', 'p')`, [schema, table]);
  if (!rel) return undefined;
  const { rows: columns } = await q.query<Column>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
            coalesce(a.attnum = any(i.indkey), false) as pk, col_description(a.attrelid, a.attnum) as comment
     from pg_attribute a left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
     where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [rel.oid]);
  const fk = async (where: string) => (await q.query<ForeignKey>(
    `select con.conname as name,
            array(select a.attname from unnest(con.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i) as columns,
            rn.nspname as "refSchema", rc.relname as "refTable",
            array(select a.attname from unnest(con.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i) as "refColumns",
            sn.nspname as "srcSchema", sc.relname as "srcTable"
     from pg_constraint con
     join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
     join pg_class sc on sc.oid = con.conrelid join pg_namespace sn on sn.oid = sc.relnamespace
     where con.contype = 'f' and ${where} order by con.conname`, [rel.oid])).rows;
  return {
    oid: rel.oid as number,
    kind: rel.relkind as string,
    comment: rel.comment as string | null,
    columns,
    foreignKeys: await fk("con.conrelid = $1"),
    referencedBy: await fk("con.confrelid = $1"),
  };
}

/** One page of rows, sorted, searched (any column, as text) and filtered by exact column values. */
async function rows(schema: string, table: string, params: URLSearchParams) {
  return readOnly(async (q) => {
    const meta = await describe(q, schema, table);
    if (!meta) return undefined;
    // In public mode hidden columns can't be searched, filtered or sorted on, so nobody can probe them.
    const open = meta.columns.filter((c) => !MASK || !(HIDDEN.test(c.name) || PARTIAL.test(c.name)));
    const names = new Set(open.map((c) => c.name));
    const size = PAGE_SIZES.includes(Number(params.get("size"))) ? Number(params.get("size")) : 50;
    const page = Math.max(0, Math.floor(Number(params.get("page")) || 0));
    const values: unknown[] = [];
    const where: string[] = [];
    for (const [key, value] of params) {
      if (!key.startsWith("f.") || !names.has(key.slice(2))) continue;
      values.push(value);
      where.push(`${ident(key.slice(2))}::text = $${values.length}`);
    }
    const search = params.get("q")?.trim();
    if (search) {
      values.push(`%${search}%`);
      where.push(`concat_ws(' ', ${open.map((c) => `t.${ident(c.name)}::text`).join(", ") || "''"}) ilike $${values.length}`);
    }
    const sort = params.get("sort");
    const pkColumns = meta.columns.filter((c) => c.pk).map((c) => ident(c.name));
    const order = sort && names.has(sort)
      ? `${ident(sort)} ${params.get("dir") === "desc" ? "desc" : "asc"} nulls last`
      : pkColumns.length ? pkColumns.join(", ") : "1";
    const from = `${ident(schema)}.${ident(table)} t ${where.length ? `where ${where.join(" and ")}` : ""}`;
    const total = Number((await q.query(`select count(*) as n from ${from}`, values)).rows[0].n);
    const data = await q.query(`select t.* from ${from} order by ${order} limit ${size} offset ${page * size}`, values);
    const rows = data.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, masked(k, v)])));
    return { schema, table, ...meta, total, page, size, masked: MASK, rows };
  });
}

/** JSON for Postgres values: bytea as short hex, bigint-safe numbers as strings. */
function replacer(_key: string, value: unknown) {
  if (value && typeof value === "object" && (value as { type?: string }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    const bytes = Buffer.from((value as { data: number[] }).data);
    return `\\x${bytes.subarray(0, 32).toString("hex")}${bytes.length > 32 ? `… (${bytes.length} bytes)` : ""}`;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body, replacer));
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** HTTP Basic auth: the shared password, with any username unless BROWSER_USER is set. */
function authorized(header: string | undefined): boolean {
  if (!PASSWORD) return true;
  const decoded = Buffer.from((header ?? "").replace(/^Basic\s+/i, ""), "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  const passwordOk = same(decoded.slice(split + 1), PASSWORD);
  return USERNAME ? passwordOk && same(decoded.slice(0, split), USERNAME) : passwordOk;
}

createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="DB Browser", charset="UTF-8"', "content-type": "text/plain" });
      return res.end("Enter the DB Browser password (any username).");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/meta") {
      const { rows: [m] } = await pool.query("select current_database() as database, current_user as role, version() as version");
      return send(res, 200, { database: m.database, role: m.role, version: String(m.version).split(" on ")[0], masked: MASK });
    }
    if (url.pathname === "/api/tables") return send(res, 200, await tables());
    const table = url.pathname.match(/^\/api\/rows\/([^/]+)\/([^/]+)$/);
    if (table) {
      const result = await rows(decodeURIComponent(table[1]), decodeURIComponent(table[2]), url.searchParams);
      return result ? send(res, 200, result) : send(res, 404, { error: "No such table" });
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[a-z.-]+$/.test(file)) return send(res, 404, { error: "Not found" });
    const body = await readFile(join(PUBLIC, file)).catch(() => undefined);
    if (!body) return send(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}).listen(PORT, HOST, () => {
  const shown = new URL(url);
  shown.password = "";
  console.log(`db-browser: http://${HOST}:${PORT}  (read-only, ${shown.username}@${shown.host}${shown.pathname}${LOGIN ? ", login required" : MASK ? ", public: contact details and tokens masked" : ""})`);
});
