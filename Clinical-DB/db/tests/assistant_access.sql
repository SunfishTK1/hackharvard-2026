-- Proves the patient assistant is scoped to one person. Needs demo.sql and assistant_demo.sql;
-- changes nothing (everything rolls back).
--   docker compose exec -T postgres psql -U postgres -d clinical_trials -f /db/tests/assistant_access.sql
\set ON_ERROR_STOP on
\set QUIET on
begin;
set local role patient_assistant;

do $$
begin
  assert (select count(*) from assistant.engagements) = 0, 'saw engagements before choosing a person';
  assert (select count(*) from core.people) = 0, 'saw people before choosing a person';
  assert (select count(*) from assistant.prescreen_questions) > 0, 'trial content should be readable';
end $$;
\echo 'ok  patient_assistant sees no personal rows until it calls use_person()'

-- Two new people text in.
select assistant.person_for_handle('+16175559901', 'Test Person A') as person_a \gset
select assistant.person_for_handle('+16175559902', 'Test Person B') as person_b \gset
do $$
begin
  assert assistant.person_for_handle('+16175559901') = (select assistant.person_for_handle('+16175559901')), 'lookup should be stable';
end $$;

select assistant.use_person(:'person_b') \gset
insert into assistant.engagements (person_id, trial_id)
select :'person_b', id from trial.trials where code = 'NORTHSTAR-2';
insert into assistant.memories (person_id, kind, content) values (:'person_b', 'fact', 'B secret');

select assistant.use_person(:'person_a') \gset
insert into assistant.engagements (person_id, trial_id)
select :'person_a', id from trial.trials where code = 'NORTHSTAR-2';
insert into assistant.memories (person_id, kind, content) values (:'person_a', 'preference', 'Prefers mornings');
do $$
declare
  me uuid := assistant.current_person_id();
begin
  assert (select count(*) from core.people) = 1, 'should see exactly one person row';
  assert (select count(*) from assistant.engagements) = 1, 'should see only its own engagement';
  assert (select bool_and(person_id = me) from assistant.memories), 'saw another person''s memories';
  assert not exists (select 1 from assistant.memories where content = 'B secret'), 'read person B''s memory';
end $$;
\echo 'ok  after use_person(), every read is limited to that person'

select set_config('test.person_b', :'person_b', true) \gset
do $$
begin
  begin
    execute format('insert into assistant.memories (person_id, kind, content) values (%L, %L, %L)',
                   current_setting('test.person_b'), 'fact', 'cross-person write');
    raise exception 'wrote a memory for another person';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'ok  patient_assistant cannot write another person''s rows'

do $$
begin
  begin
    perform assistant.enroll((select id from assistant.engagements limit 1));
    raise exception 'patient_assistant enrolled someone';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from analytics.trials;
    raise exception 'patient_assistant read analytics';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'ok  enrolling stays a staff action; analytics stay off limits'

rollback;
\echo 'All patient assistant access checks passed.'
