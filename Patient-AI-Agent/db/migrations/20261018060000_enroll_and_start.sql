-- migrate:up
-- Enrollment approved means in the study: confirming an enrollment in Trial Ops now enrolls the
-- participant, activates them and lays out their check-ins, so Sage can start them right away.
-- And Sage reminds active participants when a check-in window opens (once per window, only people who
-- agreed to texts, not while they've paused reminders, and not in the first half hour after they
-- start, when Sage has just welcomed them).
set local role app_owner;

create or replace function ops.execute_approval(p_approval uuid) returns jsonb
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
    -- Approved: they're in the study now, and their check-ins start today.
    update public.participants set status = 'active', activated_at = now(), status_changed_by = staff where id = pa.id;
    insert into public.participant_events (study_id, participant_id, event_type, actor_staff_id, metadata)
    values (pa.study_id, pa.id, 'check_ins_started', staff, jsonb_build_object('via', 'trial_ops', 'reason', 'enrollment approved'));
    made := ops.schedule_assessments(pa.id);
    outcome := jsonb_build_object('participant', pa.participant_code, 'status', 'active', 'assessments_scheduled', made,
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

create table assistant.checkin_reminders (
  engagement_id uuid not null references assistant.engagements (id) on delete cascade,
  -- The check-in window, by when it opened (UTC).
  window_key text not null,
  sent_at timestamptz not null default now(),
  primary key (engagement_id, window_key)
);
comment on table assistant.checkin_reminders is 'Check-in windows Sage has reminded someone about, so each goes once.';

create function assistant.claim_checkin_reminders(p_settle interval default interval '30 minutes')
returns table (person_id uuid, handle text, engagement_id uuid, labels text)
language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  with open_now as (
    select e.id as engagement_id, e.person_id, pe.handle, min(a.window_opens_at) as opened, string_agg(distinct m.label, ', ') as labels
    from assistant.engagements e
    join assistant.people pe on pe.id = e.person_id
    join public.participants p on p.id = e.participant_id and p.status = 'active' and p.activated_at <= now() - p_settle
    join public.scheduled_assessments a on a.participant_id = p.id and a.status = 'pending' and now() between a.window_opens_at and a.window_closes_at
    join public.measure_definitions m on m.id = a.measure_id and coalesce(m.source_type, 'patient_message') in ('patient_message', 'questionnaire', 'device')
    where e.contact_opt_in_at is not null
      and exists (select 1 from assistant.threads t where t.person_id = e.person_id)
      and not exists (select 1 from assistant.audit_events x where x.engagement_id = e.id and x.action = 'reminders_paused'
                        and left(x.detail->>'until', 10) >= to_char(now(), 'YYYY-MM-DD'))
    group by e.id, e.person_id, pe.handle
  ), claimed as (
    insert into assistant.checkin_reminders (engagement_id, window_key)
    select engagement_id, to_char(opened at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from open_now
    on conflict do nothing
    returning engagement_id
  )
  select o.person_id, o.handle, o.engagement_id, o.labels from open_now o join claimed c on c.engagement_id = o.engagement_id
$$;
comment on function assistant.claim_checkin_reminders(interval) is 'Claims the check-in windows open now that Sage should remind people about (active, agreed to texts, not paused); each window once.';
revoke execute on function assistant.claim_checkin_reminders(interval) from public;
grant execute on function assistant.claim_checkin_reminders(interval) to patient_assistant;

-- migrate:down
-- Confirming goes back to enrolling only (the function as in 20261018010000_trial_ops).
set local role app_owner;
drop function assistant.claim_checkin_reminders(interval);
drop table assistant.checkin_reminders;
create or replace function ops.execute_approval(p_approval uuid) returns jsonb
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
