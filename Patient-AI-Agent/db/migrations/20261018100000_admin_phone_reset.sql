-- migrate:up
-- Starting a phone over with Sage, from the team reset code or from the ops website's admin page.
-- Both archive, never delete: the person, their threads and their participant contact are unlinked
-- from the phone (the handle gets an archive suffix), the old journey's check-in reminders are
-- paused, and the reset is audited. On the website a signed-in manager may reset a phone only when
-- every journey on it is in a study they work on; the phone number itself isn't kept in ops' audit.
set local role app_owner;

create function assistant.archive_person(p_person uuid, p_actor text, p_reason text) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  h text;
  archived text;
begin
  select handle into h from assistant.people where id = p_person for update;
  if h is null then return null; end if;
  archived := h || '#reset-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISSMS');
  insert into assistant.audit_events (person_id, engagement_id, actor, action, detail)
    select p_person, e.id, p_actor, 'reminders_paused', jsonb_build_object('until', '2099-12-31', 'reason', p_reason)
    from assistant.engagements e where e.person_id = p_person;
  insert into assistant.audit_events (person_id, actor, action, detail)
    values (p_person, p_actor, 'journey_reset', jsonb_build_object('archived_handle', archived, 'reason', p_reason));
  update assistant.threads set handle = archived, external_space_id = null where person_id = p_person;
  update assistant.people set handle = archived where id = p_person;
  update private.participant_contacts set secure_handle = archived where secure_handle = h;
  return archived;
end $$;
comment on function assistant.archive_person(uuid, text, text) is 'Unlinks a person from their phone so its next text starts someone new. Archives, never deletes.';
revoke execute on function assistant.archive_person(uuid, text, text) from public;

create or replace function assistant.reset_person(p_handle text) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  person uuid;
begin
  if not exists (select 1 from ops.managers where handle = p_handle and is_active) then return false; end if;
  select id into person from assistant.people where handle = p_handle;
  if person is not null then perform assistant.archive_person(person, 'person', 'Reset with the team reset code'); end if;
  return true;
end $$;

-- What's on a phone, for the manager about to reset it: its journeys and whether they may.
create function ops.phone_journey(p_manager uuid, p_handle text) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with person as (select id from assistant.people where handle = p_handle),
  mine as (
    select distinct x.study_id from ops.manager_staff ms
    join ops.managers m on m.id = ms.manager_id and m.is_active
    join ops.staff x on x.staff_user_id = ms.staff_user_id and x.is_active
    where ms.manager_id = p_manager
  ),
  journeys as (
    select e.created_at, st.study_code, st.intervention, pa.participant_code, pa.status, e.phase, e.study_id in (select study_id from mine) as mine
    from assistant.engagements e
    join person on person.id = e.person_id
    join ops.studies st on st.id = e.study_id
    left join public.participants pa on pa.id = e.participant_id
  )
  select case when not exists (select 1 from person) then jsonb_build_object('found', false)
  else jsonb_build_object(
    'found', true,
    'allowed', exists (select 1 from ops.managers where id = p_manager and is_active) and not exists (select 1 from journeys where not mine),
    'journeys', coalesce((select jsonb_agg(jsonb_build_object('study', study_code, 'name', intervention, 'participant', participant_code, 'status', status, 'phase', phase) order by created_at) from journeys), '[]'::jsonb),
    'lastMessageAt', (select max(t.last_message_at) from assistant.threads t join person on person.id = t.person_id))
  end
$$;
comment on function ops.phone_journey(uuid, text) is 'The Sage journeys on a phone, and whether this manager may reset it (every journey is in a study they work on).';

create function ops.reset_phone(p_manager uuid, p_handle text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  j jsonb := ops.phone_journey(p_manager, p_handle);
  person uuid;
begin
  if not (j->>'found')::boolean then return jsonb_build_object('reset', false, 'journeys', '[]'::jsonb); end if;
  if not (j->>'allowed')::boolean then
    raise exception 'That phone has a journey in a study you don''t work on.' using errcode = 'insufficient_privilege';
  end if;
  select id into person from assistant.people where handle = p_handle;
  perform assistant.archive_person(person, 'staff', 'Reset from the ops website admin page');
  insert into ops.audit_events (manager_id, action, detail) values (p_manager, 'phone_reset', jsonb_build_object('journeys', j->'journeys'));
  return jsonb_build_object('reset', true, 'journeys', j->'journeys');
end $$;
comment on function ops.reset_phone(uuid, text) is 'A manager starts a phone over with Sage from the ops website (archives, never deletes; audited).';
revoke execute on function ops.phone_journey(uuid, text) from public;
revoke execute on function ops.reset_phone(uuid, text) from public;
grant execute on function ops.phone_journey(uuid, text) to manager_agent;
grant execute on function ops.reset_phone(uuid, text) to manager_agent;

-- migrate:down
set local role app_owner;
drop function ops.reset_phone(uuid, text);
drop function ops.phone_journey(uuid, text);
create or replace function assistant.reset_person(p_handle text) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  archived text := p_handle || '#reset-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISSMS');
  person uuid;
begin
  if not exists (select 1 from ops.managers where handle = p_handle and is_active) then return false; end if;
  select id into person from assistant.people where handle = p_handle;
  if person is null then return true; end if;
  insert into assistant.audit_events (person_id, engagement_id, actor, action, detail)
    select person, e.id, 'person', 'reminders_paused', jsonb_build_object('until', '2099-12-31', 'reason', 'Reset with the team reset code')
    from assistant.engagements e where e.person_id = person;
  insert into assistant.audit_events (person_id, actor, action, detail)
    values (person, 'person', 'journey_reset', jsonb_build_object('archived_handle', archived));
  update assistant.threads set handle = archived, external_space_id = null where person_id = person;
  update assistant.people set handle = archived where id = person;
  update private.participant_contacts set secure_handle = archived where secure_handle = p_handle;
  return true;
end $$;
drop function assistant.archive_person(uuid, text, text);
