// Lets a phone use Trial Ops, acting as platform staff identities (an administrator's job, never
// the agent's). Runs as the staff login (STAFF_DATABASE_URL or the developer DATABASE_URL).
//   npm run ops:link -- +16175550123 "Jordan Lee" --managers        every study's trial manager
//   npm run ops:link -- +16175550123 "Jordan Lee" --as drew.foster  these staff (auth subject or its slug)
//   npm run ops:link -- +16175550123 --remove
//   npm run ops:link -- --list
import { parseArgs } from "node:util";
import pg from "pg";
import { config } from "../config.ts";
import { pgConfig } from "../db.ts";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { managers: { type: "boolean" }, as: { type: "string" }, remove: { type: "boolean" }, list: { type: "boolean" }, sage: { type: "boolean" } },
});
const client = new pg.Client(pgConfig(config.staffDatabaseUrl));
await client.connect();
const q = async <T = Record<string, unknown>>(text: string, values?: unknown[]) => (await client.query(text, values)).rows as T[];

try {
  if (flags.list) {
    const rows = await q<{ handle: string; display_name: string; chat_mode: string; is_active: boolean; staff: string | null }>(
      `select m.handle, m.display_name, m.chat_mode, m.is_active,
         string_agg(u.display_name || ' (' || (select string_agg(distinct st.study_code || ' ' || s.role, ', ') from public.study_staff s join public.studies st on st.id = s.study_id where s.staff_user_id = u.id) || ')', '; ') staff
       from ops.managers m left join ops.manager_staff ms on ms.manager_id = m.id left join private.staff_users u on u.id = ms.staff_user_id
       group by m.id order by m.created_at`);
    for (const r of rows) console.log(`${r.handle}  ${r.display_name}  ${r.is_active ? r.chat_mode : "inactive"}  ${r.staff ?? "(no staff)"}`);
    if (!rows.length) console.log("No managers linked.");
    process.exit(0);
  }
  const [handle, name] = positionals;
  if (!handle || !/^(\+[1-9]\d{6,14}|[^@\s]+@[^@\s]+)$/.test(handle)) throw new Error("Give the phone as +1XXXXXXXXXX (or an iMessage email).");
  await client.query("begin");
  if (flags.remove) {
    await q("update ops.managers set is_active = false where handle = $1", [handle]);
    await client.query("commit");
    console.log(`${handle} can no longer use Trial Ops.`);
    process.exit(0);
  }
  if (!name) throw new Error('Give their name too: npm run ops:link -- +1XXXXXXXXXX "First Last" --managers');
  const staff = flags.managers
    ? await q<{ id: string; display_name: string }>(
        "select distinct u.id, u.display_name from public.study_staff s join private.staff_users u on u.id = s.staff_user_id where s.role = 'trial_manager' and s.is_active and u.is_active")
    : flags.as
      ? await q<{ id: string; display_name: string }>(
          "select id, display_name from private.staff_users where is_active and (auth_subject = any($1) or split_part(auth_subject, '|', 2) = any($1))",
          [flags.as.split(",").map((s) => s.trim()).filter(Boolean)])
      : [];
  if (!staff.length) throw new Error("No staff to act as: pass --managers, or --as with staff auth subjects (e.g. drew.foster).");
  const [m] = await q<{ id: string }>(
    `insert into ops.managers (handle, display_name, chat_mode) values ($1, $2, $3)
     on conflict (handle) do update set display_name = excluded.display_name, is_active = true, chat_mode = excluded.chat_mode returning id`,
    [handle, name, flags.sage ? "sage" : "ops"]);
  await q("delete from ops.manager_staff where manager_id = $1", [m.id]);
  for (const s of staff) await q("insert into ops.manager_staff (manager_id, staff_user_id) values ($1, $2)", [m.id, s.id]);
  await client.query("commit");
  console.log(`${handle} (${name}) can use Trial Ops as ${staff.map((s) => s.display_name).join(", ")}. Their chat starts with ${flags.sage ? "Sage" : "Trial Ops"}; texting "sage" or "ops" switches.`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
