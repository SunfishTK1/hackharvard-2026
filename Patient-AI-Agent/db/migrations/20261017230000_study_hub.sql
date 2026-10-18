-- migrate:up
-- The "Your study" mini-app for enrolled participants: its form kind, and three read-only views of
-- the participant's own platform record (progress, today's assessments, recent readings), behind
-- the same person check as the rest of the bridge.
set local role app_owner;

alter table assistant.forms drop constraint forms_kind_check;
alter table assistant.forms add constraint forms_kind_check
  check (kind in ('prescreen', 'info', 'consent', 'schedule', 'checkin', 'document', 'study'));

create function assistant.study_overview(p_engagement uuid)
returns table (participant_code text, participant_status text, started_at timestamptz, duration_weeks integer,
               study_day integer, assessments_due_14d integer, assessments_done_14d integer)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  return query
  select p.participant_code, p.status, coalesce(p.activated_at, p.enrolled_at), s.duration_weeks,
         case when coalesce(p.activated_at, p.enrolled_at) is null then null
              else ((now() at time zone p.time_zone)::date - (coalesce(p.activated_at, p.enrolled_at) at time zone p.time_zone)::date) + 1 end,
         (select count(*)::integer from public.scheduled_assessments a
          where a.participant_id = p.id and a.due_at > now() - interval '14 days' and a.due_at <= now()),
         (select count(*)::integer from public.scheduled_assessments a
          where a.participant_id = p.id and a.due_at > now() - interval '14 days' and a.due_at <= now() and a.status = 'completed')
  from public.participants p join public.studies s on s.id = p.study_id
  where p.id = e.participant_id;
end $$;
comment on function assistant.study_overview(uuid) is 'The current person''s place in their study: code, status, start, study day, and assessments due and done in the last 14 days.';

create function assistant.today_assessments(p_engagement uuid)
returns table (measure_code text, label text, due_at timestamptz, window_closes_at timestamptz, status text)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  return query
  select m.measure_code, m.label, a.due_at, a.window_closes_at, a.status
  from public.scheduled_assessments a
  join public.measure_definitions m on m.id = a.measure_id
  join public.participants p on p.id = a.participant_id
  where a.participant_id = e.participant_id
    and (a.due_at at time zone p.time_zone)::date = (now() at time zone p.time_zone)::date
  order by a.due_at, m.measure_code;
end $$;
comment on function assistant.today_assessments(uuid) is 'The current person''s assessments scheduled for today (their time zone), done or not.';

create function assistant.recent_observations(p_engagement uuid, p_days integer default 14)
returns table (measure_code text, label text, unit text, data_type text, numeric_value numeric, boolean_value boolean,
               text_value text, captured_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  return query
  select m.measure_code, m.label, m.unit, m.data_type, o.numeric_value, o.boolean_value, o.text_value, o.captured_at
  from public.observations o join public.measure_definitions m on m.id = o.measure_id
  where o.participant_id = e.participant_id
    and o.captured_at > now() - make_interval(days => least(greatest(p_days, 1), 90))
    and o.review_status <> 'rejected'
    and not exists (select 1 from public.observations newer where newer.supersedes_observation_id = o.id)
  order by o.captured_at;
end $$;
comment on function assistant.recent_observations(uuid, integer) is 'The current person''s own recent readings (latest corrections only), for their check-in history and trends.';

revoke execute on function assistant.study_overview(uuid), assistant.today_assessments(uuid), assistant.recent_observations(uuid, integer) from public;
grant execute on function assistant.study_overview(uuid), assistant.today_assessments(uuid), assistant.recent_observations(uuid, integer) to patient_assistant;

-- migrate:down
set local role app_owner;
drop function assistant.study_overview(uuid);
drop function assistant.today_assessments(uuid);
drop function assistant.recent_observations(uuid, integer);
delete from assistant.forms where kind = 'study';
alter table assistant.forms drop constraint forms_kind_check;
alter table assistant.forms add constraint forms_kind_check
  check (kind in ('prescreen', 'info', 'consent', 'schedule', 'checkin', 'document'));
