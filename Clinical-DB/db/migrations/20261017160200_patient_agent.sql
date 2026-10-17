-- migrate:up
-- The per-patient iMessage agent: conversations, long-term memory and scheduled check-ins.
-- Every row carries participant_id, which is what row-level security scopes on.
set local role app_owner;

create table patient_agent.threads (
  id                      uuid primary key default uuidv7(),
  participant_id          uuid not null references trial.participants (id) on delete cascade,
  channel                 text not null default 'imessage' check (channel in ('imessage', 'sms', 'whatsapp', 'email', 'web')),
  handle                  text not null,
  agent_handle            text,
  external_space_id       text,
  external_agent_user_id  text,
  status                  text not null default 'active' check (status in ('active', 'paused', 'closed')),
  state                   jsonb not null default '{}',
  last_message_at         timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (participant_id, channel),
  unique (id, participant_id)
);
create index on patient_agent.threads (channel, handle);
create trigger set_updated_at before update on patient_agent.threads for each row execute function core.set_updated_at();
comment on table patient_agent.threads is 'One conversation per participant per channel: the iMessage agent''s link between a patient''s phone and their enrollment.';
comment on column patient_agent.threads.handle is 'The patient''s address on the channel (E.164 phone or iMessage email).';
comment on column patient_agent.threads.agent_handle is 'The agent''s line the patient texts, for example the Photon number.';
comment on column patient_agent.threads.external_space_id is 'Messaging provider''s conversation ID (Photon space, pho_spc_...).';
comment on column patient_agent.threads.state is 'Short-lived working state, for example {"awaiting": "pain_score", "check_in_id": "..."}.';

create table patient_agent.messages (
  id              uuid primary key default uuidv7(),
  thread_id       uuid not null,
  participant_id  uuid not null,
  direction       text not null check (direction in ('inbound', 'outbound')),
  author          text not null check (author in ('patient', 'agent', 'staff', 'system')),
  body            text,
  content         jsonb not null default '{}',
  external_id     text unique,
  sent_at         timestamptz not null default now(),
  model           text,
  usage           jsonb,
  created_at      timestamptz not null default now(),
  foreign key (thread_id, participant_id) references patient_agent.threads (id, participant_id) on delete cascade,
  check ((direction = 'inbound') = (author = 'patient'))
);
create index on patient_agent.messages (participant_id, sent_at desc);
create index on patient_agent.messages (thread_id, sent_at);
comment on table patient_agent.messages is 'Every message in a patient conversation, both directions. The transcript the agent rereads for short-term context.';
comment on column patient_agent.messages.external_id is 'Provider message ID (Photon pho_msg_...). Unique, so replaying an event can''t store a message twice.';
comment on column patient_agent.messages.content is 'Non-text parts: attachments, structured payloads, provider metadata.';
comment on column patient_agent.messages.usage is 'For agent messages: token counts and latency from the model call.';

create table patient_agent.memories (
  id                 uuid primary key default uuidv7(),
  participant_id     uuid not null references trial.participants (id) on delete cascade,
  kind               text not null check (kind in ('fact', 'preference', 'concern', 'goal', 'routine', 'relationship', 'instruction', 'summary')),
  content            text not null,
  importance         smallint not null default 3 check (importance between 1 and 5),
  source_message_id  uuid references patient_agent.messages (id) on delete set null,
  covers_from        timestamptz,
  covers_to          timestamptz,
  embedding          vector,
  embedding_model    text,
  superseded_by      uuid references patient_agent.memories (id) on delete set null,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((embedding is null) = (embedding_model is null)),
  check (covers_to is null or covers_from is null or covers_to >= covers_from)
);
create index on patient_agent.memories (participant_id, kind) where superseded_by is null;
create trigger set_updated_at before update on patient_agent.memories for each row execute function core.set_updated_at();
comment on table patient_agent.memories is 'Long-term memory about one patient, written by the agent: facts, preferences, concerns, routines, and rolling conversation summaries (kind = summary). Retrieved into the prompt on each turn.';
comment on column patient_agent.memories.importance is '1 (trivia) to 5 (always include in the prompt).';
comment on column patient_agent.memories.covers_from is 'For summaries: the span of conversation the summary covers.';
comment on column patient_agent.memories.embedding is 'Optional pgvector embedding of content for semantic recall. Dimension depends on embedding_model; compare only rows with the same model.';
comment on column patient_agent.memories.superseded_by is 'Set when a newer memory replaces this one; current memories have superseded_by is null.';

create table patient_agent.check_ins (
  id                   uuid primary key default uuidv7(),
  participant_id       uuid not null references trial.participants (id) on delete cascade,
  collection_plan_id   uuid not null references trial.collection_plans (id) on delete cascade,
  scheduled_for        timestamptz not null,
  status               text not null default 'scheduled' check (status in ('scheduled', 'sent', 'answered', 'missed', 'skipped', 'cancelled')),
  prompt_message_id    uuid references patient_agent.messages (id) on delete set null,
  response_message_id  uuid references patient_agent.messages (id) on delete set null,
  answered_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (participant_id, collection_plan_id, scheduled_for),
  check (status <> 'answered' or answered_at is not null)
);
create index on patient_agent.check_ins (scheduled_for) where status in ('scheduled', 'sent');
create trigger set_updated_at before update on patient_agent.check_ins for each row execute function core.set_updated_at();
comment on table patient_agent.check_ins is 'One scheduled question for one participant, made from a trial.collection_plans row. Tracks sent, answered or missed, which drives adherence analytics.';

-- Scoping. A patient agent session works on exactly one participant:
--   begin;
--   select patient_agent.use_participant(participant_id) from patient_agent.find_participant('+16175550123') limit 1;
--   ... reads and writes, all limited to that participant by row-level security ...
--   commit;
create function patient_agent.current_participant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.participant_id', true), '')::uuid
$$;
comment on function patient_agent.current_participant_id() is 'The participant this session (transaction) is scoped to, or null.';

create function patient_agent.find_participant(p_handle text)
returns table (participant_id uuid, trial_id uuid, trial_code text, subject_code text, status text, thread_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id, p.trial_id, t.code, p.subject_code, p.status, th.id
  from trial.participants p
  join core.people pe on pe.id = p.person_id
  join trial.trials t on t.id = p.trial_id
  left join patient_agent.threads th on th.participant_id = p.id and th.channel = 'imessage'
  where pe.phone_e164 = p_handle or lower(pe.email) = lower(p_handle) or th.handle = p_handle
  order by p.status in ('active', 'enrolled') desc, p.enrolled_at desc nulls last
$$;
comment on function patient_agent.find_participant(text) is 'Who is texting? Resolves an iMessage handle to enrollments, current ones first. Call before use_participant.';

create function patient_agent.use_participant(p_participant_id uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (select 1 from trial.participants where id = p_participant_id) then
    raise exception 'No participant %', p_participant_id using errcode = 'no_data_found';
  end if;
  perform set_config('app.participant_id', p_participant_id::text, true);
  return p_participant_id;
end $$;
comment on function patient_agent.use_participant(uuid) is 'Scopes the current transaction to one participant. Row-level security then limits the patient_agent role to that participant''s rows.';

-- migrate:down
set local role app_owner;
drop function patient_agent.use_participant(uuid), patient_agent.find_participant(text), patient_agent.current_participant_id();
drop table patient_agent.check_ins, patient_agent.memories, patient_agent.messages, patient_agent.threads;
