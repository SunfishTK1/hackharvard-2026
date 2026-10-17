-- migrate:up
-- Lets the patient assistant check whether a handle already has a conversation with it, without
-- creating a person. Used when the assistant shares an iMessage line with other bots and only
-- answers people who opted in.
set local role app_owner;

create function assistant.has_thread(p_handle text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from assistant.threads t
    join core.people p on p.id = t.person_id
    where t.handle = p_handle or p.phone_e164 = p_handle or lower(p.email) = lower(p_handle))
$$;
comment on function assistant.has_thread(text) is 'True if this handle already talks with the patient assistant. Never creates anything.';

-- Taken visit slots for a trial, so the scheduler can hide them. Times only, never who booked.
create function assistant.booked_slots(p_trial_id uuid) returns table (site_id uuid, starts_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.site_id, a.starts_at from assistant.appointments a join trial.sites s on s.id = a.site_id
  where s.trial_id = p_trial_id and a.status = 'booked' and a.starts_at > now()
$$;
comment on function assistant.booked_slots(uuid) is 'Booked appointment times for a trial''s sites (no identities), for offering free slots.';

revoke execute on function assistant.has_thread(text), assistant.booked_slots(uuid) from public;
grant execute on function assistant.has_thread(text), assistant.booked_slots(uuid) to patient_assistant;

-- migrate:down
set local role app_owner;
drop function assistant.booked_slots(uuid);
drop function assistant.has_thread(text);
