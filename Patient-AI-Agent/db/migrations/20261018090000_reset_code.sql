-- migrate:up
-- For demos: a team member's phone (an active Trial Ops manager) that texts Sage the reset code starts
-- over as someone brand new. Nothing is deleted: their person, threads and participant contact are
-- unlinked from the phone (the handle gets an archive suffix), check-in reminders for the old journey
-- are paused, and the reset is audited. Any other phone gets false, and the text is handled normally.
set local role app_owner;
create function assistant.reset_person(p_handle text) returns boolean
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
comment on function assistant.reset_person(text) is 'Demo reset: a Trial Ops manager''s phone starts over with Sage as someone new. Archives, never deletes.';
revoke execute on function assistant.reset_person(text) from public;
grant execute on function assistant.reset_person(text) to patient_assistant;

-- migrate:down
set local role app_owner;
drop function assistant.reset_person(text);
