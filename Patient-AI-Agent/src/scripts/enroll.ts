// Site staff action for demos: after the screening visit, confirm a consented participant's
// eligibility and enrollment on the platform (as an authorized staff user, which the platform
// requires), assign an arm, activate them, and close the assistant's enrollment task. The
// assistant picks the change up on their next message and moves to the active phase.
//   npm run enroll -- +16175550190 [--staff demo-coordinator] [--arm NS210] [--no-activate] [--due-now]
// --due-now also opens today's self-reported assessments for check-in (normally the platform's scheduler does).
// Connects with STAFF_DATABASE_URL, or the developer DATABASE_URL in Clinical-DB/.env.
import { parseArgs } from "node:util";
import pg from "pg";
import { config } from "../config.ts";
import { pgConfig } from "../db.ts";

const { values: flags, positionals: [handle] } = parseArgs({
  allowPositionals: true,
  options: { staff: { type: "string" }, arm: { type: "string" }, "no-activate": { type: "boolean" }, "due-now": { type: "boolean" } },
});
if (!handle) {
  console.error("Usage: npm run enroll -- <phone or email> [--staff <auth_subject>] [--arm <arm_code>] [--no-activate] [--due-now]");
  process.exit(1);
}

const client = new pg.Client(pgConfig(config.staffDatabaseUrl));
await client.connect();
const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];
try {
  await client.query("begin");
  await client.query("set local role app_owner");
  const e = await one(
    `select e.id, e.person_id, e.study_id, e.participant_id, p.status, p.site_id, p.participant_code, p.time_zone
     from assistant.engagements e join assistant.people h on h.id = e.person_id
     left join public.participants p on p.id = e.participant_id
     where h.handle = $1 order by e.updated_at desc limit 1`, [handle]);
  if (!e) throw new Error(`No journey for ${handle}. Text the assistant first.`);
  if (!e.participant_id) throw new Error(`${handle} hasn't passed the prescreen yet, so there's no participant to enroll.`);
  if (e.status !== "consented") throw new Error(`${e.participant_code} is ${e.status}; only consented participants can be enrolled.`);

  const staff = flags.staff
    ? await one("select id, display_name from private.staff_users where auth_subject = $1 and is_active", [flags.staff])
    : await one(
      `select u.id, u.display_name from public.study_staff s join private.staff_users u on u.id = s.staff_user_id
       where s.study_id = $1 and (s.site_id is null or s.site_id = $2) and s.is_active and u.is_active
         and s.role in ('trial_manager', 'principal_investigator', 'coordinator') order by s.created_at limit 1`, [e.study_id, e.site_id]);
  if (!staff) throw new Error("No authorized staff user for this study and site. Pass --staff <auth_subject>.");

  const arms = (await client.query("select id, arm_code, name, coalesce(allocation_ratio, 1) as ratio from public.study_arms where study_id = $1", [e.study_id])).rows;
  let arm = flags.arm ? arms.find((a) => a.arm_code === flags.arm) : undefined;
  if (flags.arm && !arm) throw new Error(`No arm ${flags.arm}. Arms: ${arms.map((a) => a.arm_code).join(", ")}`);
  if (!arm && arms.length) {
    let pick = Math.random() * arms.reduce((sum, a) => sum + Number(a.ratio), 0);
    arm = arms.find((a) => (pick -= Number(a.ratio)) < 0) ?? arms[0];
  }

  await client.query(
    `update public.participants set eligibility_status = 'eligible', status = 'enrolled', enrolled_at = now(),
       enrollment_confirmed_by = $2, status_changed_by = $2, assigned_arm_id = $3 where id = $1`,
    [e.participant_id, staff.id, arm?.id ?? null]);
  if (!flags["no-activate"]) {
    await client.query("update public.participants set status = 'active', activated_at = now() where id = $1", [e.participant_id]);
  }
  await client.query(
    `update public.workflow_tasks set status = 'completed', approved_by = $2, approved_at = now(), completed_at = now()
     where participant_id = $1 and action_type = 'confirm_enrollment' and status in ('pending', 'waiting_review')`, [e.participant_id, staff.id]);
  await client.query("update assistant.appointments set status = 'completed' where engagement_id = $1 and status = 'booked'", [e.id]);

  let due = 0;
  if (flags["due-now"] && !flags["no-activate"]) {
    const { rowCount } = await client.query(
      `insert into public.scheduled_assessments (study_id, participant_id, measure_id, schedule_id, window_opens_at, due_at, window_closes_at)
       select s.study_id, $1, s.measure_id, s.id, now() - interval '1 hour', now(), now() + make_interval(mins => greatest(s.grace_period_minutes, 60))
       from public.assessment_schedules s join public.measure_definitions m on m.id = s.measure_id
       where s.study_id = $2 and s.is_active and s.frequency in ('daily', 'weekly') and m.data_type <> 'json'
         and coalesce(m.source_type, 'patient_message') in ('patient_message', 'questionnaire', 'device')
       on conflict do nothing`, [e.participant_id, e.study_id]);
    due = rowCount ?? 0;
  }

  await client.query("select set_config('app.person_id', $1, true)", [e.person_id]);
  const { phase } = await one("select assistant.sync_phase($1) as phase", [e.id]);
  await client.query("commit");
  console.log(`${e.participant_code} enrolled${flags["no-activate"] ? "" : " and active"} by ${staff.display_name}${arm ? `, arm ${arm.arm_code} (${arm.name})` : ""}. Assistant phase: ${phase}.${due ? ` ${due} assessments open for check-in now.` : ""}`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
