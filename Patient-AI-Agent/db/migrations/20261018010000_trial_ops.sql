-- migrate:up
-- Trial Ops: the iMessage agent and mini-apps for trial managers, on the same data as the ops home.
--
-- It runs as the platform's manager_agent role. Reads go through the views in schema ops: they are
-- owned by app_owner, so manager_agent needs no access to the platform schemas themselves, and they leave out what a manager doesn't need:
-- contact details, signatures and consent evidence.
--
-- Writes are the decisions a manager makes: confirm or decline an enrollment, record a baseline visit
-- (activation), sign off a safety review, acknowledge or resolve an alert. Each is an ops.approvals
-- row that the server marks verified only after the manager's Face ID; ops.execute_approval then
-- acts as the manager's own staff identity for that study, and the platform's triggers check that
-- identity is authorized. The model can prepare an approval but never verify or execute one.
do $$
begin
  if not exists (select from pg_roles where rolname = 'manager_agent') then
    raise exception 'Trial Ops runs as the platform role manager_agent, which is missing. As the database owner (postgres), run: create role manager_agent login password ''...'';';
  end if;
end $$;
set local role app_owner;
create schema ops;
comment on schema ops is 'Trial Ops: trial managers over iMessage. Read views over the platform, manager identities and their staff links, chat memory, mini-app cards, Face ID passkeys, and approvals that become platform decisions only after Face ID.';

-- Managers and identity -------------------------------------------------------------------------

create table ops.managers (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^(\+[1-9][0-9]{6,14}|[^@\s]+@[^@\s]+)$'),
  display_name text not null,
  -- Where this handle's chat goes when it is also a Sage participant: 'ops' or 'sage'.
  chat_mode text not null default 'ops' check (chat_mode in ('ops', 'sage')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table ops.managers is 'Phones (iMessage handles) allowed to use Trial Ops. Added by an administrator (npm run ops:link), never by the agent.';

create table ops.manager_staff (
  manager_id uuid not null references ops.managers (id) on delete cascade,
  staff_user_id uuid not null references private.staff_users (id),
  primary key (manager_id, staff_user_id)
);
comment on table ops.manager_staff is 'The platform staff identities a manager acts as. Approvals use the one assigned to the study.';

create table ops.threads (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null unique references ops.managers (id) on delete cascade,
  external_space_id text,
  created_at timestamptz not null default now()
);

create table ops.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references ops.threads (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  author text not null check (author in ('manager', 'agent', 'system')),
  kind text not null default 'text' check (kind in ('text', 'card', 'event')),
  body text not null,
  external_id text unique,
  -- A card in the chat: its view, title and mini-app URL, so every surface can show it.
  link jsonb,
  created_at timestamptz not null default now()
);
create index on ops.messages (thread_id, created_at);

-- A mini-app link. Its token (made by the server) is the credential: long, random, one manager, expiring.
create table ops.cards (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references ops.managers (id) on delete cascade,
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  view text not null check (view in ('home', 'approvals', 'alerts', 'alert', 'study', 'participant', 'pipeline', 'quality', 'analysis')),
  params jsonb not null default '{}',
  title text not null,
  message_id text,
  session jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);

-- Signing in to Trial Ops on the web (the ops website): a one-time link texted to the manager's
-- phone, then a session. Only hashes of the tokens are kept.
create table ops.web_signins (
  token_hash text primary key,
  manager_id uuid not null references ops.managers (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);
create table ops.web_sessions (
  token_hash text primary key,
  manager_id uuid not null references ops.managers (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table ops.passkeys (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references ops.managers (id) on delete cascade,
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[],
  device_type text,
  backed_up boolean,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table ops.approvals (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references ops.managers (id) on delete cascade,
  kind text not null check (kind in ('confirm_enrollment', 'decline_enrollment', 'activate', 'review_safety', 'acknowledge_alert', 'resolve_alert')),
  -- A workflow task (enrollment, safety review), a participant (activation) or an alert.
  target_id uuid not null,
  note text check (length(note) <= 1000),
  -- Who set it up: the agent in chat, or the manager in a mini-app. Either way the manager confirms it.
  prepared_by text not null check (prepared_by in ('agent', 'manager')),
  status text not null default 'pending' check (status in ('pending', 'verified', 'done', 'failed', 'cancelled')),
  verified_with uuid references ops.passkeys (id),
  verified_at timestamptz,
  staff_user_id uuid references private.staff_users (id),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (status not in ('verified', 'done') or (verified_with is not null and verified_at is not null))
);
create index on ops.approvals (manager_id, status);

create table ops.audit_events (
  id bigint generated always as identity primary key,
  manager_id uuid references ops.managers (id) on delete set null,
  action text not null,
  detail jsonb not null default '{}',
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Analyses on a Daytona computer: one computer per manager (a cloud sandbox that stops when idle),
-- and the analyses an analyst agent runs there on a snapshot of the data below. Reports (summary,
-- findings, charts and tables) are kept here, so the mini-app shows them after the computer is gone.
create table ops.computers (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references ops.managers (id) on delete cascade,
  sandbox_id text not null unique,
  status text not null check (status in ('starting', 'ready', 'stopped', 'deleted', 'failed')),
  cpu integer,
  memory integer,
  prepared boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create unique index computers_one_per_manager on ops.computers (manager_id) where status in ('starting', 'ready', 'stopped');

create table ops.analyses (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references ops.managers (id) on delete cascade,
  computer_id uuid references ops.computers (id),
  title text not null check (length(title) <= 120),
  request text not null check (length(request) <= 4000),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  summary text,
  findings jsonb not null default '[]',
  progress jsonb not null default '[]',
  steps integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on ops.analyses (manager_id, created_at desc);

create table ops.analysis_files (
  analysis_id uuid not null references ops.analyses (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9._-]{1,120}$'),
  content_type text not null,
  bytes bytea not null check (octet_length(bytes) <= 8 * 1024 * 1024),
  primary key (analysis_id, name)
);

-- Read views: the platform as a manager sees it ---------------------------------------------------

create view ops.staff as
select s.id as assignment_id, s.study_id, s.site_id, s.staff_user_id, u.display_name as name, s.role, s.receives_alerts,
       s.is_active and u.is_active as is_active
from public.study_staff s join private.staff_users u on u.id = s.staff_user_id;

create view ops.studies as
select st.id, st.study_code, st.title, st.intervention, st.protocol_id, st.design, st.condition, st.phase, st.study_type, st.status, st.target_enrollment,
       st.duration_weeks, st.primary_outcome, st.sponsor, st.is_synthetic, st.updated_at,
       (select string_agg(x.name, ', ' order by x.name) from ops.staff x where x.study_id = st.id and x.role = 'trial_manager' and x.is_active) as managers
from public.studies st;

create view ops.sites as
select s.id, s.study_id, st.study_code, s.site_code, s.institution_name, s.city, s.state, s.time_zone, s.status,
       (select x.name from ops.staff x where x.site_id = s.id and x.role = 'principal_investigator' and x.is_active order by x.name limit 1) as investigator,
       (select x.name from ops.staff x where x.site_id = s.id and x.role = 'coordinator' and x.is_active order by x.name limit 1) as coordinator
from public.sites s join public.studies st on st.id = s.study_id;

create view ops.participants as
select p.id, p.study_id, st.study_code, p.site_id, s.site_code, s.institution_name as site_name, p.participant_code, p.status,
       p.eligibility_status, a.arm_code, a.name as arm_name, p.time_zone, p.enrolled_at, p.activated_at, p.completed_at, p.withdrawn_at,
       p.created_at, p.updated_at, u.display_name as enrollment_confirmed_by, p.is_synthetic,
       public.has_current_consent(p.study_id, p.id) as has_current_consent,
       exists (select 1 from assistant.engagements e where e.participant_id = p.id) as via_sage
from public.participants p
join public.studies st on st.id = p.study_id
join public.sites s on s.id = p.site_id
left join public.study_arms a on a.id = p.assigned_arm_id
left join private.staff_users u on u.id = p.enrollment_confirmed_by;

create view ops.consents as
select c.id, c.study_id, c.participant_id, d.version, d.document_name, c.status, c.presented_at, c.opened_at, c.signed_at,
       c.declined_at, c.revoked_at, c.copy_provided_at
from public.participant_consents c join public.consent_documents d on d.id = c.consent_document_id;

create view ops.events as
select ev.id, ev.study_id, ev.participant_id, p.participant_code, ev.event_type, ev.previous_status, ev.new_status,
       u.display_name as actor, ev.metadata - 'engagement_id' as metadata, ev.occurred_at
from public.participant_events ev
join public.participants p on p.id = ev.participant_id
left join private.staff_users u on u.id = ev.actor_staff_id;

create view ops.alerts as
select al.id, al.study_id, st.study_code, al.participant_id, p.participant_code, al.assigned_site_id as site_id, s.site_code,
       s.institution_name as site_name, al.alert_type, al.severity, al.status, al.reason, al.recommended_action,
       r.rule_code, r.name as rule_name, x.name as assignee, x.role as assignee_role,
       ack.display_name as acknowledged_by, res.display_name as resolved_by, al.resolution_notes,
       al.created_at, al.acknowledged_at, al.resolved_at,
       al.deduplication_key like 'assistant:%' or (r.rule_code is not null and exists (
         select 1 from public.observations o where o.participant_id = al.participant_id and o.source_payload->>'via' = 'patient_assistant'
           and al.deduplication_key = r.rule_code || ':' || o.id)) as from_sage
from public.alerts al
join public.studies st on st.id = al.study_id
join public.participants p on p.id = al.participant_id
join public.sites s on s.id = al.assigned_site_id
left join public.alert_rules r on r.id = al.rule_id
left join ops.staff x on x.assignment_id = al.assigned_staff_id
left join private.staff_users ack on ack.id = al.acknowledged_by
left join private.staff_users res on res.id = al.resolved_by;

create view ops.tasks as
select t.id, t.study_id, st.study_code, t.participant_id, p.participant_code, p.site_id, s.site_code, s.institution_name as site_name,
       t.action_type, t.status, t.requires_approval, t.payload - 'engagement_id' as payload, x.name as assignee, x.role as assignee_role,
       u.display_name as approved_by, t.approved_at, t.run_after, t.completed_at, t.created_at, t.updated_at
from public.workflow_tasks t
join public.studies st on st.id = t.study_id
left join public.participants p on p.id = t.participant_id
left join public.sites s on s.id = p.site_id
left join ops.staff x on x.assignment_id = t.assigned_staff_id
left join private.staff_users u on u.id = t.approved_by;

create view ops.assessments as
select a.id, a.study_id, a.participant_id, p.participant_code, p.site_id, m.measure_code, m.label, m.source_type,
       sc.frequency, a.window_opens_at, a.due_at, a.window_closes_at, a.completed_at,
       case when a.status = 'pending' and a.window_closes_at < now() then 'overdue' else a.status end as status
from public.scheduled_assessments a
join public.participants p on p.id = a.participant_id
join public.measure_definitions m on m.id = a.measure_id
left join public.assessment_schedules sc on sc.id = a.schedule_id;

create view ops.readings as
select o.id, o.study_id, o.participant_id, p.participant_code, p.site_id, m.measure_code, m.label, m.unit, m.data_type,
       o.numeric_value, o.boolean_value, o.text_value,
       coalesce(trim_scale(o.numeric_value)::text, o.text_value, case when o.boolean_value then 'Yes' when not o.boolean_value then 'No' end, o.json_value::text) as value,
       o.source_type, o.source_payload->>'via' = 'patient_assistant' as via_sage, o.requires_review, o.review_status,
       o.supersedes_observation_id, exists (select 1 from public.observations n where n.supersedes_observation_id = o.id) as superseded,
       o.scheduled_assessment_id, o.captured_at
from public.observations o
join public.participants p on p.id = o.participant_id
join public.measure_definitions m on m.id = o.measure_id;

create view ops.messages_log as
select mg.id, mg.study_id, mg.participant_id, p.participant_code, p.site_id, mg.direction, mg.channel, mg.provider, mg.message_type,
       mg.status, left(mg.body, 600) as body, mg.error_code, mg.sent_at, mg.delivered_at, mg.received_at, mg.created_at
from public.messages mg join public.participants p on p.id = mg.participant_id;

create view ops.measures as
select m.id, m.study_id, m.measure_code, m.label, m.data_type, m.unit, m.min_value, m.max_value, m.source_type, m.is_active
from public.measure_definitions m;

create view ops.alert_rules as
select r.id, r.study_id, r.rule_code, r.name, r.rule_type, r.severity, r.action_type, r.enabled, m.measure_code, r.condition - 'basis' as condition
from public.alert_rules r left join public.measure_definitions m on m.id = r.measure_id;

create view ops.arms as
select a.id, a.study_id, a.arm_code, a.name, a.is_control, a.allocation_ratio from public.study_arms a;

-- Sage's recruitment funnel and booked visits, counts and times only.
create view ops.sage_funnel as select * from assistant.recruitment_funnel;
create view ops.sage_visits as
select ap.id, e.study_id, e.participant_id, ap.site_id, ap.kind, ap.status, ap.starts_at, ap.ends_at
from assistant.appointments ap join assistant.engagements e on e.id = ap.engagement_id;

-- The platform's own analytics.
create view ops.study_dashboard as select * from analytics.study_dashboard;
create view ops.site_metrics as select * from analytics.site_metrics;

-- Decisions ---------------------------------------------------------------------------------------

-- The manager's staff identity for a study (and site): theirs, authorized by the platform's own rule.
create function ops.staff_identity(p_manager uuid, p_study uuid, p_site uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select ms.staff_user_id from ops.manager_staff ms
  join ops.managers m on m.id = ms.manager_id and m.is_active
  where ms.manager_id = p_manager and public.staff_authorized(p_study, ms.staff_user_id, p_site)
  order by ms.staff_user_id limit 1
$$;

-- Lays out a newly active participant's expected assessments for the next p_days days, from the
-- study's active schedules (daily and weekly; times in the participant's time zone).
create function ops.schedule_assessments(p_participant uuid, p_days integer default 14) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  p public.participants;
  made integer;
begin
  select * into p from public.participants where id = p_participant;
  insert into public.scheduled_assessments (study_id, participant_id, measure_id, schedule_id, window_opens_at, due_at, window_closes_at)
  select p.study_id, p.id, s.measure_id, s.id, due - interval '1 hour', due, due + make_interval(mins => greatest(s.grace_period_minutes, 60))
  from public.assessment_schedules s
  cross join lateral generate_series(0, p_days - 1) as d(day)
  cross join lateral unnest(s.times_of_day) as t(at)
  cross join lateral (select ((((p.activated_at at time zone p.time_zone)::date + d.day) + t.at) at time zone p.time_zone) as due) x
  where s.study_id = p.study_id and s.is_active and s.anchor_event = 'activation'
    and d.day >= s.start_day and (s.end_day is null or d.day <= s.end_day)
    and (s.frequency = 'daily'
         or (s.frequency = 'weekly' and extract(isodow from (p.activated_at at time zone p.time_zone)::date + d.day)::smallint = any (s.weekdays)))
    and x.due + make_interval(mins => greatest(s.grace_period_minutes, 60)) > now()
  on conflict do nothing;
  get diagnostics made = row_count;
  return made;
end $$;

-- Tells Sage's journey about a platform change (its phase follows the participant's status).
create function ops.sync_sage(p_participant uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare e assistant.engagements;
begin
  select * into e from assistant.engagements where participant_id = p_participant order by updated_at desc limit 1;
  if not found then return; end if;
  perform set_config('app.person_id', e.person_id::text, true);
  perform assistant.sync_phase(e.id);
  update assistant.appointments set status = 'completed' where engagement_id = e.id and status = 'booked' and kind = 'screening_visit' and starts_at < now();
end $$;

-- Carries out a verified approval as the manager's staff identity. Returns what happened.
create function ops.execute_approval(p_approval uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  ap ops.approvals;
  t public.workflow_tasks;
  pa public.participants;
  al public.alerts;
  staff uuid;
  arm uuid;
  pick numeric;
  made integer;
  outcome jsonb;
begin
  select * into ap from ops.approvals where id = p_approval for update;
  if not found then raise exception 'No approval %', p_approval using errcode = 'no_data_found'; end if;
  if ap.status <> 'verified' or ap.verified_at < now() - interval '10 minutes' then
    raise exception 'This approval needs Face ID first' using errcode = 'insufficient_privilege';
  end if;

  if ap.kind in ('confirm_enrollment', 'decline_enrollment', 'review_safety') then
    select * into t from public.workflow_tasks where id = ap.target_id for update;
    if not found then raise exception 'That task no longer exists' using errcode = '23514'; end if;
    if t.status not in ('pending', 'waiting_review') then raise exception 'That is already %', t.status using errcode = '23514'; end if;
    if (ap.kind = 'review_safety') <> (t.action_type = 'review_safety') or (ap.kind <> 'review_safety' and t.action_type <> 'confirm_enrollment') then
      raise exception 'That task is a %', t.action_type using errcode = '23514';
    end if;
    select * into pa from public.participants where id = t.participant_id;
  elsif ap.kind = 'activate' then
    select * into pa from public.participants where id = ap.target_id for update;
  else
    select * into al from public.alerts where id = ap.target_id for update;
    if not found then raise exception 'That alert no longer exists' using errcode = '23514'; end if;
    select * into pa from public.participants where id = al.participant_id;
  end if;
  if pa.id is null then raise exception 'No participant for this decision' using errcode = '23514'; end if;

  staff := ops.staff_identity(ap.manager_id, pa.study_id, pa.site_id);
  if staff is null then raise exception 'You are not authorized staff for % at this site', (select study_code from public.studies where id = pa.study_id) using errcode = 'insufficient_privilege'; end if;

  if ap.kind = 'confirm_enrollment' then
    if pa.status <> 'consented' then raise exception '% is %, not consented', pa.participant_code, pa.status using errcode = '23514'; end if;
    -- Randomize by allocation ratio, as the staff enrollment script does.
    select coalesce(sum(coalesce(allocation_ratio, 1)), 0) * random() into pick from public.study_arms where study_id = pa.study_id;
    select id into arm from (
      select id, sum(coalesce(allocation_ratio, 1)) over (order by arm_code) as upto from public.study_arms where study_id = pa.study_id
    ) a where a.upto > pick order by a.upto limit 1;
    update public.participants set eligibility_status = 'eligible', status = 'enrolled', enrolled_at = now(),
           enrollment_confirmed_by = staff, status_changed_by = staff, assigned_arm_id = coalesce(arm, assigned_arm_id)
    where id = pa.id;
    update public.workflow_tasks set status = 'completed', approved_by = staff, approved_at = now(), completed_at = now(), updated_at = now()
    where id = t.id;
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'enrolled',
      'arm', (select name from public.study_arms where id = arm));
  elsif ap.kind = 'decline_enrollment' then
    if pa.status not in ('consent_pending', 'consented') then raise exception '% is %', pa.participant_code, pa.status using errcode = '23514'; end if;
    update public.participants set status = 'screen_failed', status_changed_by = staff where id = pa.id;
    update public.workflow_tasks set status = 'cancelled', updated_at = now(), last_error_code = 'declined_by_staff' where id = t.id;
    insert into public.participant_events (study_id, participant_id, event_type, actor_staff_id, metadata)
    values (pa.study_id, pa.id, 'enrollment_declined', staff, jsonb_build_object('reason', ap.note, 'via', 'trial_ops'));
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'screen_failed');
  elsif ap.kind = 'activate' then
    if pa.status <> 'enrolled' then raise exception '% is %, not enrolled', pa.participant_code, pa.status using errcode = '23514'; end if;
    update public.participants set status = 'active', activated_at = now(), status_changed_by = staff where id = pa.id;
    insert into public.participant_events (study_id, participant_id, event_type, actor_staff_id, metadata)
    values (pa.study_id, pa.id, 'baseline_visit_completed', staff, jsonb_build_object('via', 'trial_ops'));
    made := ops.schedule_assessments(pa.id);
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'active', 'assessments_scheduled', made);
  elsif ap.kind = 'review_safety' then
    if nullif(btrim(ap.note), '') is null then raise exception 'A safety review needs your assessment in a note' using errcode = '23514'; end if;
    update public.workflow_tasks set status = 'completed', approved_by = staff, approved_at = now(), completed_at = now(), updated_at = now()
    where id = t.id;
    update public.alerts set status = 'resolved', acknowledged_by = coalesce(acknowledged_by, staff), acknowledged_at = coalesce(acknowledged_at, now()),
           resolved_by = staff, resolved_at = now(), resolution_notes = ap.note
    where id = (t.payload->>'alert_id')::uuid and status <> 'resolved';
    update public.observations set review_status = 'accepted', reviewed_by = staff, reviewed_at = now()
    where id = (t.payload->>'observation_id')::uuid and review_status = 'unreviewed';
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'reviewed');
  elsif ap.kind = 'acknowledge_alert' then
    if al.status <> 'open' then raise exception 'That alert is already %', al.status using errcode = '23514'; end if;
    update public.alerts set status = 'acknowledged', acknowledged_by = staff, acknowledged_at = now() where id = al.id;
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'acknowledged');
  elsif ap.kind = 'resolve_alert' then
    if al.status = 'resolved' then raise exception 'That alert is already resolved' using errcode = '23514'; end if;
    if nullif(btrim(ap.note), '') is null then raise exception 'Resolving an alert needs a note' using errcode = '23514'; end if;
    update public.alerts set status = 'resolved', acknowledged_by = coalesce(acknowledged_by, staff), acknowledged_at = coalesce(acknowledged_at, now()),
           resolved_by = staff, resolved_at = now(), resolution_notes = ap.note
    where id = al.id;
    -- Its safety review, if any, is done with it.
    update public.workflow_tasks set status = 'completed', approved_by = staff, approved_at = now(), completed_at = now(), updated_at = now()
    where action_type = 'review_safety' and status in ('pending', 'waiting_review') and payload->>'alert_id' = al.id::text;
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'resolved');
  end if;

  perform ops.sync_sage(pa.id);
  update ops.approvals set status = 'done', staff_user_id = staff, result = outcome, completed_at = now() where id = ap.id;
  insert into ops.audit_events (manager_id, action, detail) values (ap.manager_id, 'approval_executed',
    jsonb_build_object('approval_id', ap.id, 'kind', ap.kind, 'target_id', ap.target_id, 'staff_user_id', staff) || outcome);
  return outcome || jsonb_build_object('by', (select display_name from private.staff_users where id = staff));
end $$;

-- The Sage chat for a participant, so a decision can be followed by Sage telling them.
create function ops.sage_handle(p_participant uuid) returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select pe.handle from assistant.engagements e join assistant.people pe on pe.id = e.person_id
  where e.participant_id = p_participant order by e.updated_at desc limit 1
$$;

-- Access ------------------------------------------------------------------------------------------

grant usage on schema ops to manager_agent;
grant select on ops.staff, ops.studies, ops.sites, ops.participants, ops.consents, ops.events, ops.alerts, ops.tasks, ops.assessments,
  ops.readings, ops.messages_log, ops.measures, ops.alert_rules, ops.arms, ops.sage_funnel, ops.sage_visits, ops.study_dashboard,
  ops.site_metrics to manager_agent;
grant select on ops.managers, ops.manager_staff to manager_agent;
grant update (chat_mode) on ops.managers to manager_agent;
grant select, insert, update on ops.threads, ops.messages, ops.cards, ops.passkeys to manager_agent;
grant select, insert, update on ops.web_signins, ops.web_sessions to manager_agent;
grant select, insert on ops.audit_events to manager_agent;
grant select, insert, update on ops.computers, ops.analyses to manager_agent;
grant select, insert on ops.analysis_files to manager_agent;
grant select, insert on ops.approvals to manager_agent;
grant update (status, note, verified_with, verified_at, result, error, completed_at) on ops.approvals to manager_agent;
revoke execute on function ops.staff_identity(uuid, uuid, uuid), ops.schedule_assessments(uuid, integer), ops.sync_sage(uuid),
  ops.execute_approval(uuid), ops.sage_handle(uuid) from public;
grant execute on function public.has_current_consent(uuid, uuid) to manager_agent;
grant execute on function ops.execute_approval(uuid), ops.sage_handle(uuid) to manager_agent;

-- migrate:down
set local role app_owner;
drop schema ops cascade;
