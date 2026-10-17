-- migrate:up
-- The trial manager iMessage agent: conversations, memory, analyses it ran, and alerts.
-- Mirrors patient_agent, scoped to a staff member (person_id) instead of a participant.
set local role app_owner;

create table manager_agent.threads (
  id                      uuid primary key default uuidv7(),
  person_id               uuid not null references core.people (id) on delete cascade,
  channel                 text not null default 'imessage' check (channel in ('imessage', 'sms', 'whatsapp', 'email', 'web')),
  handle                  text not null,
  agent_handle            text,
  external_space_id       text,
  external_agent_user_id  text,
  default_trial_id        uuid references trial.trials (id) on delete set null,
  status                  text not null default 'active' check (status in ('active', 'paused', 'closed')),
  state                   jsonb not null default '{}',
  last_message_at         timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (person_id, channel),
  unique (id, person_id)
);
create index on manager_agent.threads (channel, handle);
create trigger set_updated_at before update on manager_agent.threads for each row execute function core.set_updated_at();
comment on table manager_agent.threads is 'One conversation per staff member per channel with the trial manager agent.';
comment on column manager_agent.threads.default_trial_id is 'Trial assumed when the manager doesn''t name one ("how''s enrollment?").';

create table manager_agent.messages (
  id           uuid primary key default uuidv7(),
  thread_id    uuid not null,
  person_id    uuid not null,
  direction    text not null check (direction in ('inbound', 'outbound')),
  author       text not null check (author in ('manager', 'agent', 'system')),
  body         text,
  content      jsonb not null default '{}',
  external_id  text unique,
  sent_at      timestamptz not null default now(),
  model        text,
  usage        jsonb,
  created_at   timestamptz not null default now(),
  foreign key (thread_id, person_id) references manager_agent.threads (id, person_id) on delete cascade,
  check ((direction = 'inbound') = (author = 'manager'))
);
create index on manager_agent.messages (person_id, sent_at desc);
create index on manager_agent.messages (thread_id, sent_at);
comment on table manager_agent.messages is 'Every message between a trial manager and the manager agent.';

create table manager_agent.memories (
  id                 uuid primary key default uuidv7(),
  person_id          uuid not null references core.people (id) on delete cascade,
  trial_id           uuid references trial.trials (id) on delete cascade,
  kind               text not null check (kind in ('preference', 'focus', 'fact', 'instruction', 'saved_question', 'summary')),
  content            text not null,
  importance         smallint not null default 3 check (importance between 1 and 5),
  source_message_id  uuid references manager_agent.messages (id) on delete set null,
  covers_from        timestamptz,
  covers_to          timestamptz,
  embedding          vector,
  embedding_model    text,
  superseded_by      uuid references manager_agent.memories (id) on delete set null,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((embedding is null) = (embedding_model is null))
);
create index on manager_agent.memories (person_id, kind) where superseded_by is null;
create trigger set_updated_at before update on manager_agent.memories for each row execute function core.set_updated_at();
comment on table manager_agent.memories is 'Long-term memory about one manager: report preferences, what they are watching, standing instructions, saved questions, conversation summaries. trial_id null means it applies to all their trials.';

create table manager_agent.analyses (
  id                   uuid primary key default uuidv7(),
  person_id            uuid not null references core.people (id) on delete cascade,
  trial_id             uuid references trial.trials (id) on delete cascade,
  thread_id            uuid references manager_agent.threads (id) on delete set null,
  request_message_id   uuid references manager_agent.messages (id) on delete set null,
  response_message_id  uuid references manager_agent.messages (id) on delete set null,
  question             text not null,
  sql_text             text,
  result               jsonb,
  narrative            text,
  status               text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error                text,
  model                text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);
create index on manager_agent.analyses (person_id, created_at desc);
comment on table manager_agent.analyses is 'Audit log of every analysis the manager agent ran: the question, the SQL it wrote against analytics.*, the result and the iMessage-sized answer. Also a cache for repeat questions.';

create table manager_agent.alerts (
  id                    uuid primary key default uuidv7(),
  trial_id              uuid not null references trial.trials (id) on delete cascade,
  participant_id        uuid references trial.participants (id) on delete cascade,
  kind                  text not null check (kind in ('adverse_event', 'missed_check_ins', 'out_of_range', 'withdrawal_risk', 'data_quality', 'other')),
  severity              text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  title                 text not null,
  detail                text,
  adverse_event_id      uuid references clinical.adverse_events (id) on delete cascade,
  observation_id        uuid references clinical.observations (id) on delete cascade,
  recipient_person_id   uuid references core.people (id) on delete cascade,
  status                text not null default 'open' check (status in ('open', 'sent', 'acknowledged', 'resolved')),
  delivered_message_id  uuid references manager_agent.messages (id) on delete set null,
  created_at            timestamptz not null default now(),
  sent_at               timestamptz,
  acknowledged_at       timestamptz,
  resolved_at           timestamptz
);
create index on manager_agent.alerts (trial_id, status, created_at desc);
comment on table manager_agent.alerts is 'Things a trial manager should hear about without asking: serious adverse events, missed check-ins, out-of-range values. Raised by triggers or the patient agent; texted by the manager agent.';
comment on column manager_agent.alerts.recipient_person_id is 'A specific staff member, or null for every staff member on the trial with receives_alerts.';

-- Scoping. A manager agent session works for exactly one staff member:
--   begin;
--   select manager_agent.use_staff(person_id) from manager_agent.find_staff('+16175550100');
--   ... analytics.* now shows only that person's trials ...
--   commit;
create function manager_agent.current_staff_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.staff_person_id', true), '')::uuid
$$;
comment on function manager_agent.current_staff_id() is 'The staff member this session (transaction) is scoped to, or null.';

create function manager_agent.my_trial_ids() returns uuid[]
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(distinct trial_id), '{}')
  from trial.staff
  where person_id = manager_agent.current_staff_id()
$$;
comment on function manager_agent.my_trial_ids() is 'Trials the current staff member works on. analytics.visible_trial() uses this to limit the manager_agent role.';

create function manager_agent.find_staff(p_handle text)
returns table (person_id uuid, display_name text, trial_codes text[], thread_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select pe.id, pe.display_name, array_agg(distinct t.code order by t.code), min(th.id::text)::uuid
  from core.people pe
  join trial.staff s on s.person_id = pe.id
  join trial.trials t on t.id = s.trial_id
  left join manager_agent.threads th on th.person_id = pe.id and th.channel = 'imessage'
  where pe.phone_e164 = p_handle or lower(pe.email) = lower(p_handle) or th.handle = p_handle
  group by pe.id, pe.display_name
$$;
comment on function manager_agent.find_staff(text) is 'Who is texting? Resolves an iMessage handle to a staff member and their trials. Call before use_staff.';

create function manager_agent.use_staff(p_person_id uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (select 1 from trial.staff where person_id = p_person_id) then
    raise exception 'Person % is not staff on any trial', p_person_id using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.staff_person_id', p_person_id::text, true);
  return p_person_id;
end $$;
comment on function manager_agent.use_staff(uuid) is 'Scopes the current transaction to one staff member and their trials.';

-- Patient side to manager side: a severe or serious adverse event raises an alert.
create function clinical.alert_on_adverse_event() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  subject text;
begin
  if coalesce(new.grade, 0) >= 3 or new.is_serious then
    select subject_code into subject from trial.participants where id = new.participant_id;
    insert into manager_agent.alerts (trial_id, participant_id, kind, severity, title, detail, adverse_event_id)
    values (
      new.trial_id, new.participant_id, 'adverse_event',
      case when new.is_serious or coalesce(new.grade, 0) >= 4 then 'critical' else 'warning' end,
      format('%s: %s%s%s', subject, new.term,
             case when new.grade is not null then format(' (grade %s)', new.grade) else '' end,
             case when new.is_serious then ', serious' else '' end),
      new.description,
      new.id);
  end if;
  return new;
end $$;
create trigger alert_on_adverse_event after insert on clinical.adverse_events
  for each row execute function clinical.alert_on_adverse_event();
comment on function clinical.alert_on_adverse_event() is 'Raises a manager_agent.alerts row for grade 3+ or serious adverse events.';

-- migrate:down
set local role app_owner;
drop trigger alert_on_adverse_event on clinical.adverse_events;
drop function clinical.alert_on_adverse_event();
drop function manager_agent.use_staff(uuid), manager_agent.find_staff(text), manager_agent.my_trial_ids(), manager_agent.current_staff_id();
drop table manager_agent.alerts, manager_agent.analyses, manager_agent.memories, manager_agent.messages, manager_agent.threads;
