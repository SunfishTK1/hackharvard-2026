-- Proves the access rules hold. Needs the demo seed; changes nothing (everything rolls back).
--   docker compose exec -T postgres psql -U postgres -d clinical_trials -f /db/tests/access.sql
\set ON_ERROR_STOP on
\set QUIET on
begin;

-- Patient agent ------------------------------------------------------------------
set local role patient_agent;
do $$
begin
  assert (select count(*) from clinical.observations) = 0, 'patient_agent saw observations before choosing a participant';
  assert (select count(*) from trial.participants) = 0, 'patient_agent saw participants before choosing one';
end $$;
\echo 'ok  patient_agent sees no patient rows until it calls use_participant()'

select patient_agent.use_participant(participant_id) from patient_agent.find_participant('+16175550111') limit 1 \gset
do $$
declare
  me uuid := patient_agent.current_participant_id();
begin
  assert (select count(*) from trial.participants) = 1, 'patient_agent should see exactly its own enrollment';
  assert (select count(*) from core.people) = 1, 'patient_agent should see exactly its own person row';
  assert (select bool_and(participant_id = me) from clinical.observations), 'saw another participant''s observations';
  assert (select bool_and(participant_id = me) from patient_agent.messages), 'saw another participant''s messages';
  assert (select count(*) from patient_agent.messages) > 0, 'expected the demo conversation';
  assert (select count(*) from trial.measures) > 0, 'trial configuration should be readable';
end $$;
\echo 'ok  after use_participant(), every read is limited to that one participant'

do $$
declare
  mine clinical.observations%rowtype;
begin
  select * into mine from clinical.observations limit 1;
  begin
    insert into clinical.observations (trial_id, participant_id, measure_id, value_number, observed_at, source_id)
    values (mine.trial_id, gen_random_uuid(), mine.measure_id, 1, now(), mine.source_id);
    raise exception 'patient_agent wrote an observation for another participant';
  exception when insufficient_privilege then null;
  end;
  insert into clinical.observations (trial_id, participant_id, measure_id, value_number, observed_at, source_id)
  values (mine.trial_id, mine.participant_id, mine.measure_id, 1, now(), mine.source_id);
end $$;
\echo 'ok  patient_agent can record data for its participant and nobody else'

do $$
begin
  begin
    perform 1 from analytics.trials;
    raise exception 'patient_agent read analytics';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'ok  patient_agent cannot read the manager analytics'

-- Manager agent ------------------------------------------------------------------
set local role manager_agent;
do $$
begin
  assert (select count(*) from analytics.trials) = 0, 'manager_agent saw trials before choosing a staff member';
end $$;
select manager_agent.use_staff(person_id) from manager_agent.find_staff('+16175550100') \gset
do $$
begin
  assert (select array_agg(trial_code) from analytics.trials) = array['NORTHSTAR-2'], 'Dr. Chen should see only NORTHSTAR-2';
  assert not exists (select 1 from analytics.participants where trial_code <> 'NORTHSTAR-2'), 'saw participants from another trial';
  assert (select count(*) from manager_agent.alerts) >= 1, 'expected the grade 3 nausea alert';
  assert (select count(*) from manager_agent.memories) >= 1, 'expected Dr. Chen''s memories';
end $$;
select manager_agent.use_staff(person_id) from manager_agent.find_staff('+16175550102') \gset
do $$
begin
  assert (select array_agg(trial_code) from analytics.trials) = array['BREATHE-1'], 'Dr. Rivera should see only BREATHE-1';
  assert (select count(*) from manager_agent.memories) = 0, 'Dr. Rivera saw Dr. Chen''s memories';
  begin
    perform 1 from clinical.observations;
    raise exception 'manager_agent read raw clinical tables';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'ok  manager_agent sees only its staff member''s trials, through analytics views only'

-- Analyst ------------------------------------------------------------------------
set local role analyst;
do $$
begin
  assert (select count(*) from analytics.trials) >= 2, 'analyst should see every trial';
  assert (select count(distinct participant_id) from clinical.observations) > 1, 'analyst should see all participants';
  begin
    delete from clinical.observations;
    raise exception 'analyst deleted data';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'ok  analyst reads everything and can''t write'

rollback;
\echo 'All access checks passed.'
