// Makes someone the principal investigator of a study (an administrator's job). In one transaction:
// adds them as platform staff, makes them the investigator at the study's sites (retiring the
// current ones there), moves those investigators' open alerts and review tasks to them, updates the
// investigator name Sage tells people (public.sites), and with --manager links their Trial Ops
// account to the new identity. Runs as the staff login (STAFF_DATABASE_URL or the developer DATABASE_URL).
//   npm run set-pi -- STUDY-005 "Bessie Li" bl108@wellesley.edu --manager +14014080626
//   npm run set-pi -- STUDY-005 "Bessie Li" bl108@wellesley.edu --sites SITE-005-A
import { parseArgs } from "node:util";
import pg from "pg";
import { config } from "../config.ts";
import { pgConfig } from "../db.ts";

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { sites: { type: "string" }, manager: { type: "string" } } });
const [studyCode, name, email] = positionals;
if (!studyCode || !name || !email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('Usage: npm run set-pi -- STUDY-005 "First Last" email@example.edu [--sites SITE-005-A,SITE-005-B] [--manager +1XXXXXXXXXX]');
  process.exit(1);
}
const client = new pg.Client(pgConfig(config.staffDatabaseUrl));
await client.connect();
const q = async <T = Record<string, unknown>>(text: string, values?: unknown[]) => (await client.query(text, values)).rows as T[];

try {
  await client.query("begin");
  await client.query("set local role app_owner");
  const [study] = await q<{ id: string; title: string }>("select id, title from public.studies where study_code = $1", [studyCode]);
  if (!study) throw new Error(`No study ${studyCode}.`);
  const wanted = flags.sites?.split(",").map((s) => s.trim()).filter(Boolean);
  const sites = await q<{ id: string; site_code: string; institution_name: string }>(
    "select id, site_code, institution_name from public.sites where study_id = $1 and ($2::text[] is null or site_code = any($2)) order by site_code", [study.id, wanted ?? null]);
  if (!sites.length) throw new Error(`No sites${wanted ? ` ${wanted.join(", ")}` : ""} in ${studyCode}.`);

  // The person, as platform staff.
  const [user] = await q<{ id: string }>(
    `insert into private.staff_users (auth_subject, display_name, email, is_active) values ($1, $2, $3, true)
     on conflict (auth_subject) do update set display_name = excluded.display_name, email = excluded.email, is_active = true returning id`,
    [`trialops|${email.toLowerCase()}`, name, email]);

  for (const site of sites) {
    const previous = await q<{ id: string; name: string }>(
      `select s.id, u.display_name as name from public.study_staff s join private.staff_users u on u.id = s.staff_user_id
       where s.study_id = $1 and s.site_id = $2 and s.role = 'principal_investigator' and s.is_active and s.staff_user_id <> $3`, [study.id, site.id, user.id]);
    const [assignment] = await q<{ id: string }>(
      `insert into public.study_staff (study_id, site_id, staff_user_id, role, receives_alerts, is_active) values ($1, $2, $3, 'principal_investigator', true, true)
       on conflict (study_id, site_id, staff_user_id, role) do update set is_active = true, receives_alerts = true returning id`, [study.id, site.id, user.id]);
    let moved = 0;
    if (previous.length) {
      const ids = previous.map((p) => p.id);
      moved += (await client.query("update public.alerts set assigned_staff_id = $1 where assigned_staff_id = any($2) and status <> 'resolved'", [assignment.id, ids])).rowCount ?? 0;
      moved += (await client.query("update public.workflow_tasks set assigned_staff_id = $1, updated_at = now() where assigned_staff_id = any($2) and status in ('pending', 'waiting_review')", [assignment.id, ids])).rowCount ?? 0;
      await q("update public.study_staff set is_active = false where id = any($1)", [ids]);
    }
    await q("update public.sites set principal_investigator = $2, updated_at = now() where id = $1", [site.id, name]);
    console.log(`${site.site_code} (${site.institution_name}): ${name} is the principal investigator${previous.length ? `, in place of ${previous.map((p) => p.name).join(", ")}` : ""}; ${moved} open item(s) moved to them.`);
  }

  if (flags.manager) {
    const [m] = await q<{ id: string }>("select id from ops.managers where handle = $1", [flags.manager]);
    if (!m) throw new Error(`${flags.manager} isn't a Trial Ops manager (npm run ops:link first).`);
    await q("insert into ops.manager_staff (manager_id, staff_user_id) values ($1, $2) on conflict do nothing", [m.id, user.id]);
    console.log(`${flags.manager} now acts in Trial Ops as ${name} (principal investigator) for ${studyCode}.`);
  }
  await client.query("commit");
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
