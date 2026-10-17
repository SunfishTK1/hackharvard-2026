-- migrate:up
-- Who can see and change what, in one place.
--   developer      member of app_owner: owns everything, bypasses row-level security, runs migrations
--   analyst        read-only everywhere (BYPASSRLS, read-only transactions)
--   patient_agent  one participant at a time, after patient_agent.use_participant()
--   manager_agent  analytics views for its staff member's trials, plus its own memory, after manager_agent.use_staff()
set local role app_owner;

-- analyst ---------------------------------------------------------------------
grant usage on schema core, trial, patient_agent, clinical, manager_agent, analytics to analyst;
grant select on all tables in schema core, trial, patient_agent, clinical, manager_agent, analytics to analyst;
alter default privileges in schema core, trial, patient_agent, clinical, manager_agent, analytics
  grant select on tables to analyst;

-- patient_agent ---------------------------------------------------------------
grant usage on schema core, trial, patient_agent, clinical, manager_agent to patient_agent;
grant select on trial.trials, trial.arms, trial.sites, trial.measures, trial.schedule_events,
  trial.collection_plans, trial.eligibility_criteria, trial.agent_profiles to patient_agent;
grant select on trial.participants, core.people to patient_agent;
grant select, insert, update on patient_agent.threads, patient_agent.messages, patient_agent.memories, patient_agent.check_ins to patient_agent;
grant delete on patient_agent.memories to patient_agent;
grant select on clinical.data_sources to patient_agent;
grant select, insert, update on clinical.observations, clinical.adverse_events, clinical.visits to patient_agent;
grant insert on manager_agent.alerts to patient_agent;
revoke execute on function patient_agent.find_participant(text), patient_agent.use_participant(uuid) from public;
grant execute on function patient_agent.find_participant(text), patient_agent.use_participant(uuid) to patient_agent;

-- manager_agent ---------------------------------------------------------------
grant usage on schema analytics, manager_agent to manager_agent;
grant select on all tables in schema analytics to manager_agent;
alter default privileges in schema analytics grant select on tables to manager_agent;
grant select, insert, update on manager_agent.threads, manager_agent.messages, manager_agent.memories, manager_agent.analyses to manager_agent;
grant delete on manager_agent.memories to manager_agent;
grant select, update on manager_agent.alerts to manager_agent;
revoke execute on function manager_agent.find_staff(text), manager_agent.use_staff(uuid) from public;
grant execute on function manager_agent.find_staff(text), manager_agent.use_staff(uuid) to manager_agent;

-- Row-level security ------------------------------------------------------------
-- Policies name the agent roles only. Owners (developer) and BYPASSRLS roles (analyst) are
-- unaffected; any other role sees nothing in these tables.

alter table trial.participants enable row level security;
create policy patient_agent_self on trial.participants for select to patient_agent
  using (id = patient_agent.current_participant_id());

alter table core.people enable row level security;
create policy patient_agent_self on core.people for select to patient_agent
  using (id = (select person_id from trial.participants where id = patient_agent.current_participant_id()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'patient_agent.threads', 'patient_agent.messages', 'patient_agent.memories', 'patient_agent.check_ins',
    'clinical.observations', 'clinical.adverse_events', 'clinical.visits'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format(
      'create policy patient_agent_own on %s to patient_agent
         using (participant_id = patient_agent.current_participant_id())
         with check (participant_id = patient_agent.current_participant_id())', t);
  end loop;

  foreach t in array array[
    'manager_agent.threads', 'manager_agent.messages', 'manager_agent.memories', 'manager_agent.analyses'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format(
      'create policy manager_agent_own on %s to manager_agent
         using (person_id = manager_agent.current_staff_id())
         with check (person_id = manager_agent.current_staff_id())', t);
  end loop;
end $$;

alter table manager_agent.alerts enable row level security;
create policy manager_agent_read on manager_agent.alerts for select to manager_agent
  using (trial_id = any (manager_agent.my_trial_ids()));
create policy manager_agent_update on manager_agent.alerts for update to manager_agent
  using (trial_id = any (manager_agent.my_trial_ids()))
  with check (trial_id = any (manager_agent.my_trial_ids()));
create policy patient_agent_raise on manager_agent.alerts for insert to patient_agent
  with check (participant_id = patient_agent.current_participant_id());

-- migrate:down
set local role app_owner;
drop policy patient_agent_raise on manager_agent.alerts;
drop policy manager_agent_update on manager_agent.alerts;
drop policy manager_agent_read on manager_agent.alerts;
alter table manager_agent.alerts disable row level security;
do $$
declare
  t text;
begin
  foreach t in array array['manager_agent.threads', 'manager_agent.messages', 'manager_agent.memories', 'manager_agent.analyses'] loop
    execute format('drop policy manager_agent_own on %s', t);
    execute format('alter table %s disable row level security', t);
  end loop;
  foreach t in array array['patient_agent.threads', 'patient_agent.messages', 'patient_agent.memories', 'patient_agent.check_ins',
                           'clinical.observations', 'clinical.adverse_events', 'clinical.visits'] loop
    execute format('drop policy patient_agent_own on %s', t);
    execute format('alter table %s disable row level security', t);
  end loop;
end $$;
drop policy patient_agent_self on core.people;
alter table core.people disable row level security;
drop policy patient_agent_self on trial.participants;
alter table trial.participants disable row level security;
revoke all on all tables in schema core, trial, patient_agent, clinical, manager_agent, analytics from analyst, patient_agent, manager_agent;
revoke usage on schema core, trial, patient_agent, clinical, manager_agent, analytics from analyst, patient_agent, manager_agent;
