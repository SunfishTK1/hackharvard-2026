-- migrate:up
-- The patient assistant: an iMessage agent that walks one person through a trial journey, from
-- prequalification through consent, scheduling and active participation. Unlike patient_agent
-- (scoped to an enrolled participant), everything here is scoped to a PERSON, because most of the
-- journey happens before enrollment. Additive: no existing table changes.
do $$
begin
  if not exists (select from pg_roles where rolname = 'patient_assistant') then create role patient_assistant nologin; end if;
end $$;

set local role app_owner;

create schema assistant;
comment on schema assistant is 'Person-scoped patient assistant: journey state (engagement, phase, goals), conversation and long-term memory, prescreen answers, mini-app forms, e-consent with signatures and Face ID passkeys, appointments, and an audit log. Row-level security scopes the patient_assistant role to one person at a time.';

-- Journey ----------------------------------------------------------------------------

create table assistant.engagements (
  id                   uuid primary key default uuidv7(),
  person_id            uuid not null references core.people (id) on delete cascade,
  trial_id             uuid not null references trial.trials (id) on delete cascade,
  participant_id       uuid references trial.participants (id) on delete set null,
  phase                text not null default 'prequalification' check (phase in (
                         'prequalification', 'consent', 'scheduling', 'screening', 'active', 'completed',
                         'not_eligible', 'declined', 'withdrawn')),
  phase_entered_at     timestamptz not null default now(),
  eligibility          text not null default 'unknown' check (eligibility in ('unknown', 'likely_eligible', 'needs_review', 'not_eligible')),
  eligibility_reasons  jsonb not null default '[]',
  source               text not null default 'inbound_text' check (source in ('inbound_text', 'referral', 'staff', 'import')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (person_id, trial_id)
);
create index on assistant.engagements (trial_id, phase);
create trigger set_updated_at before update on assistant.engagements for each row execute function core.set_updated_at();
comment on table assistant.engagements is 'One person''s journey with one trial. The phase decides what the assistant is trying to do; transitions are guarded in code and logged to audit_events.';
comment on column assistant.engagements.phase is 'prequalification → consent → scheduling → screening → active → completed; or not_eligible, declined, withdrawn.';
comment on column assistant.engagements.participant_id is 'Set when site staff enroll the person (trial.participants); null before that.';
comment on column assistant.engagements.eligibility_reasons is 'Why, as [{"criterion": "...", "result": "met|not_met|unknown", "detail": "..."}].';

create table assistant.goals (
  id             uuid primary key default uuidv7(),
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
  person_id      uuid not null references core.people (id) on delete cascade,
  phase          text not null,
  key            text not null check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  title          text not null,
  instructions   text not null,
  status         text not null default 'pending' check (status in ('pending', 'active', 'done', 'skipped', 'blocked')),
  priority       smallint not null default 50,
  source         text not null default 'playbook' check (source in ('playbook', 'trial_knowledge', 'agent', 'staff')),
  data           jsonb not null default '{}',
  due_at         timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (engagement_id, key)
);
create index on assistant.goals (person_id, status);
create trigger set_updated_at before update on assistant.goals for each row execute function core.set_updated_at();
comment on table assistant.goals is 'What the assistant is working toward in the current phase, in priority order. Generated from the phase playbook plus trial knowledge; staff or the agent can add more. The open goals go into every prompt.';
comment on column assistant.goals.instructions is 'Guidance for the model: what done looks like and how to get there.';

-- Conversation and memory --------------------------------------------------------------

create table assistant.threads (
  id                 uuid primary key default uuidv7(),
  person_id          uuid not null references core.people (id) on delete cascade,
  channel            text not null default 'imessage' check (channel in ('imessage', 'sms', 'whatsapp', 'web', 'console')),
  handle             text not null,
  external_space_id  text unique,
  status             text not null default 'active' check (status in ('active', 'paused', 'closed')),
  last_message_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (person_id, channel),
  unique (id, person_id)
);
create trigger set_updated_at before update on assistant.threads for each row execute function core.set_updated_at();
comment on table assistant.threads is 'One conversation per person per channel. external_space_id is the Spectrum space (iMessage chat).';

create table assistant.messages (
  id           uuid primary key default uuidv7(),
  thread_id    uuid not null,
  person_id    uuid not null,
  direction    text not null check (direction in ('inbound', 'outbound')),
  author       text not null check (author in ('person', 'assistant', 'staff', 'system')),
  kind         text not null default 'text' check (kind in ('text', 'card', 'event')),
  body         text,
  content      jsonb not null default '{}',
  external_id  text unique,
  form_id      uuid,
  sent_at      timestamptz not null default now(),
  model        text,
  usage        jsonb,
  created_at   timestamptz not null default now(),
  foreign key (thread_id, person_id) references assistant.threads (id, person_id) on delete cascade,
  check (direction = 'outbound' or author = 'person' or kind = 'event')
);
create index on assistant.messages (person_id, sent_at desc);
comment on table assistant.messages is 'The transcript: texts both ways, cards the assistant sent (kind = card, with form_id), and system events such as "prescreen submitted" (kind = event) that the model should see.';

create table assistant.memories (
  id                 uuid primary key default uuidv7(),
  person_id          uuid not null references core.people (id) on delete cascade,
  trial_id           uuid references trial.trials (id) on delete cascade,
  kind               text not null check (kind in ('fact', 'preference', 'concern', 'goal', 'routine', 'relationship', 'instruction', 'health', 'summary')),
  content            text not null,
  importance         smallint not null default 3 check (importance between 1 and 5),
  source_message_id  uuid references assistant.messages (id) on delete set null,
  embedding          vector,
  embedding_model    text,
  superseded_by      uuid references assistant.memories (id) on delete set null,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((embedding is null) = (embedding_model is null))
);
create index on assistant.memories (person_id, importance desc) where superseded_by is null;
create trigger set_updated_at before update on assistant.memories for each row execute function core.set_updated_at();
comment on table assistant.memories is 'Long-term memory about one person, written by the assistant: who they are, what they prefer, what worries them, health context they shared. trial_id null means it applies to every trial. Current memories have superseded_by is null.';

-- Trial content the assistant presents (until the trial knowledge database replaces it) --

create table assistant.prescreen_questions (
  id             uuid primary key default uuidv7(),
  trial_id       uuid not null references trial.trials (id) on delete cascade,
  key            text not null check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  position       smallint not null,
  prompt         text not null,
  help           text,
  type           text not null check (type in ('yes_no', 'number', 'choice', 'multi_choice', 'scale', 'date', 'text')),
  options        jsonb,
  unit           text,
  min_value      numeric,
  max_value      numeric,
  required       boolean not null default true,
  show_if        jsonb,
  criterion      jsonb,
  eligibility_criterion_id uuid references trial.eligibility_criteria (id) on delete set null,
  unique (trial_id, key),
  check (type not in ('choice', 'multi_choice') or jsonb_typeof(options) = 'array')
);
comment on table assistant.prescreen_questions is 'Prequalification questions shown in the prescreen mini-app, each optionally tied to an eligibility criterion.';
comment on column assistant.prescreen_questions.show_if is 'Only ask when an earlier answer matches, e.g. {"key": "sex", "in": ["female"]}.';
comment on column assistant.prescreen_questions.criterion is 'How the answer decides eligibility, e.g. {"kind": "inclusion", "min": 18, "max": 65, "label": "Age 18-65"} or {"kind": "exclusion", "equals": true, "label": "Pregnant"}.';

create table assistant.consent_documents (
  id             uuid primary key default uuidv7(),
  trial_id       uuid not null references trial.trials (id) on delete cascade,
  version        text not null,
  title          text not null,
  summary        text not null,
  sections       jsonb not null check (jsonb_typeof(sections) = 'array'),
  comprehension  jsonb not null default '[]' check (jsonb_typeof(comprehension) = 'array'),
  content_hash   text not null default '',
  is_active      boolean not null default true,
  effective_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (trial_id, version)
);
create unique index consent_documents_one_active on assistant.consent_documents (trial_id) where is_active;

-- The hash is computed here, never by clients, so every signature refers to exactly what was stored.
create function assistant.hash_consent_document() returns trigger
language plpgsql as $$
begin
  new.content_hash := encode(sha256(convert_to(
    new.title || E'\n' || new.summary || E'\n' || new.sections::text || E'\n' || new.comprehension::text, 'UTF8')), 'hex');
  return new;
end $$;
create trigger hash_content before insert or update on assistant.consent_documents
  for each row execute function assistant.hash_consent_document();
comment on table assistant.consent_documents is 'The informed consent form, versioned. sections: [{"id", "heading", "body", "key_point"}]; comprehension: teach-back questions [{"id", "question", "options", "answer"}]. content_hash (SHA-256 of title + sections) is recorded with every signature.';

create table assistant.site_hours (
  site_id       uuid not null references trial.sites (id) on delete cascade,
  weekday       smallint not null check (weekday between 1 and 7),
  opens         time not null,
  closes        time not null,
  slot_minutes  smallint not null default 60 check (slot_minutes between 10 and 240),
  primary key (site_id, weekday),
  check (closes > opens)
);
comment on table assistant.site_hours is 'When a site takes screening visits (ISO weekday 1 = Monday), used to offer appointment slots.';

-- What the assistant collects and produces ----------------------------------------------

create table assistant.forms (
  id             uuid primary key default uuidv7(),
  token          text not null unique check (token ~ '^[A-Za-z0-9_-]{20,64}$'),
  person_id      uuid not null references core.people (id) on delete cascade,
  engagement_id  uuid references assistant.engagements (id) on delete cascade,
  kind           text not null check (kind in ('prescreen', 'info', 'consent', 'schedule', 'checkin', 'document')),
  title          text not null,
  payload        jsonb not null default '{}',
  status         text not null default 'created' check (status in ('created', 'sent', 'opened', 'submitted', 'expired', 'cancelled')),
  result         jsonb,
  card           jsonb,
  expires_at     timestamptz not null default now() + interval '14 days',
  created_at     timestamptz not null default now(),
  opened_at      timestamptz,
  submitted_at   timestamptz
);
create index on assistant.forms (person_id, kind, created_at desc);
comment on table assistant.forms is 'One mini-app card the assistant sent: a prescreen, consent, scheduler, info page, check-in or document. The token is the capability in the card URL; payload snapshots what was shown; card keeps the iMessage message and session needed to update the bubble in place.';
comment on column assistant.forms.token is 'Random URL token. Anyone holding it can open this form, so it is long, single-person, and expires.';

create table assistant.answers (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references core.people (id) on delete cascade,
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
  key            text not null,
  value          jsonb not null,
  source         text not null check (source in ('form', 'chat', 'staff')),
  form_id        uuid references assistant.forms (id) on delete set null,
  message_id     uuid references assistant.messages (id) on delete set null,
  confidence     numeric(3, 2) check (confidence between 0 and 1),
  answered_at    timestamptz not null default now(),
  unique (engagement_id, key)
);
comment on table assistant.answers is 'Structured answers collected before enrollment (prescreen questions, contact preferences), from a form or extracted from chat. One current value per key; source records how it was collected.';

create table assistant.passkeys (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references core.people (id) on delete cascade,
  credential_id  text not null unique,
  public_key     bytea not null,
  counter        bigint not null default 0,
  transports     text[],
  device_type    text,
  backed_up      boolean,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
comment on table assistant.passkeys is 'WebAuthn passkeys. On iPhone, creating or using one asks for Face ID, which is how the assistant verifies identity before signing or opening documents.';

create table assistant.verifications (
  id          uuid primary key default uuidv7(),
  person_id   uuid not null references core.people (id) on delete cascade,
  form_id     uuid references assistant.forms (id) on delete cascade,
  action      text not null check (action in ('sign_consent', 'view_document', 'confirm_appointment')),
  method      text not null check (method in ('passkey', 'typed_name')),
  passkey_id  uuid references assistant.passkeys (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz
);
comment on table assistant.verifications is 'Short-lived proof that the person verified themselves for one action: Face ID (passkey) or, where Face ID isn''t available, typing their name.';

create table assistant.signatures (
  id                  uuid primary key default uuidv7(),
  person_id           uuid not null references core.people (id) on delete cascade,
  engagement_id       uuid not null references assistant.engagements (id) on delete cascade,
  document_id         uuid not null references assistant.consent_documents (id),
  form_id             uuid references assistant.forms (id) on delete set null,
  verification_id     uuid not null references assistant.verifications (id),
  signed_name         text not null,
  method              text not null check (method in ('passkey', 'typed_name')),
  document_hash       text not null,
  agreements          jsonb not null default '[]',
  comprehension_score numeric(3, 2),
  ip_address          inet,
  user_agent          text,
  signed_at           timestamptz not null default now(),
  revoked_at          timestamptz,
  revoked_reason      text
);
create unique index signatures_one_current on assistant.signatures (engagement_id, document_id) where revoked_at is null;
comment on table assistant.signatures is 'E-signatures on consent documents, with the exact document hash, how identity was verified, what was agreed to, and the comprehension check score. Withdrawal sets revoked_at instead of deleting.';

create table assistant.appointments (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references core.people (id) on delete cascade,
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
  site_id        uuid not null references trial.sites (id),
  kind           text not null default 'screening_visit' check (kind in ('screening_visit', 'baseline_visit', 'phone_call', 'follow_up')),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text not null default 'booked' check (status in ('booked', 'cancelled', 'completed', 'no_show')),
  location       text,
  notes          text,
  form_id        uuid references assistant.forms (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);
create unique index appointments_one_per_slot on assistant.appointments (site_id, starts_at) where status = 'booked';
create trigger set_updated_at before update on assistant.appointments for each row execute function core.set_updated_at();
comment on table assistant.appointments is 'Visits and calls booked through the scheduler mini-app. One booking per site slot.';

create table assistant.audit_events (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references core.people (id) on delete cascade,
  engagement_id  uuid references assistant.engagements (id) on delete cascade,
  actor          text not null check (actor in ('person', 'assistant', 'system', 'staff')),
  action         text not null,
  detail         jsonb not null default '{}',
  ip_address     inet,
  user_agent     text,
  at             timestamptz not null default now()
);
create index on assistant.audit_events (person_id, at desc);
comment on table assistant.audit_events is 'Append-only trail of consequential events: phase changes, forms opened and submitted, identity checks, documents viewed, consent signed, appointments booked.';

-- Scoping --------------------------------------------------------------------------------
-- An assistant session works on one person:
--   begin; select assistant.use_person(assistant.person_for_handle('+16175550123')); ...; commit;
-- The web server resolves a form token first: select * from assistant.form_by_token($1).

create function assistant.current_person_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.person_id', true), '')::uuid
$$;

create function assistant.use_person(p_person_id uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (select 1 from core.people where id = p_person_id) then
    raise exception 'No person %', p_person_id using errcode = 'no_data_found';
  end if;
  perform set_config('app.person_id', p_person_id::text, true);
  return p_person_id;
end $$;
comment on function assistant.use_person(uuid) is 'Scopes the current transaction to one person; row-level security does the rest.';

create function assistant.person_for_handle(p_handle text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  found uuid;
  is_phone boolean := p_handle ~ '^\+[1-9][0-9]{6,14}$';
begin
  select id into found from core.people
  where (is_phone and phone_e164 = p_handle) or (not is_phone and lower(email) = lower(p_handle))
  limit 1;
  if found is null then
    insert into core.people (display_name, phone_e164, email)
    values (coalesce(nullif(trim(p_display_name), ''), 'New contact'),
            case when is_phone then p_handle end, case when not is_phone then lower(p_handle) end)
    returning id into found;
  end if;
  return found;
end $$;
comment on function assistant.person_for_handle(text, text) is 'Finds the person behind an iMessage handle (phone or email), creating them on first contact.';

create function assistant.form_by_token(p_token text)
returns table (form_id uuid, person_id uuid, engagement_id uuid, kind text, status text, expires_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select id, person_id, engagement_id, kind, status, expires_at from assistant.forms where token = p_token
$$;
comment on function assistant.form_by_token(text) is 'Resolves a mini-app URL token to its form and person. The caller then calls use_person.';

create function assistant.set_display_name(p_name text) returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  update core.people set display_name = left(trim(p_name), 120)
  where id = assistant.current_person_id() and nullif(trim(p_name), '') is not null
$$;
comment on function assistant.set_display_name(text) is 'Lets the assistant record the current person''s name once they share it.';

-- Staff action: enrolling is a site decision, so the assistant role can't call this.
create function assistant.enroll(p_engagement_id uuid, p_arm_code text default null) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements%rowtype;
  t trial.trials%rowtype;
  arm uuid;
  site uuid;
  code text;
  participant uuid;
begin
  select * into e from assistant.engagements where id = p_engagement_id for update;
  if not found then raise exception 'No engagement %', p_engagement_id; end if;
  if e.participant_id is not null then return e.participant_id; end if;
  select * into t from trial.trials where id = e.trial_id;
  select id into arm from trial.arms where trial_id = t.id and (p_arm_code is null or code = p_arm_code)
    order by case when p_arm_code is null then random() end limit 1;
  select site_id into site from assistant.appointments where engagement_id = e.id order by starts_at desc limit 1;
  select format('%s-A%s', split_part(t.code, '-', 1), lpad((count(*) + 1)::text, 3, '0')) into code
    from trial.participants where trial_id = t.id and subject_code like split_part(t.code, '-', 1) || '-A%';
  insert into trial.participants (trial_id, person_id, arm_id, site_id, subject_code, status, consented_at, enrolled_at)
  values (t.id, e.person_id, arm, site, code, 'active',
          (select min(signed_at) from assistant.signatures where engagement_id = e.id and revoked_at is null), now())
  returning id into participant;
  update assistant.engagements set participant_id = participant, phase = 'active', phase_entered_at = now() where id = e.id;
  insert into assistant.audit_events (person_id, engagement_id, actor, action, detail)
  values (e.person_id, e.id, 'staff', 'enrolled', jsonb_build_object('participant_id', participant, 'subject_code', code));
  return participant;
end $$;
comment on function assistant.enroll(uuid, text) is 'Site staff action: create the trial.participants row (randomizing the arm unless given), link it, and move the engagement to active.';

-- The manager's view of recruitment -------------------------------------------------------

create view analytics.recruitment_funnel as
select
  t.id as trial_id, t.code as trial_code, e.phase,
  count(*) as people,
  count(*) filter (where e.eligibility = 'likely_eligible') as likely_eligible,
  count(*) filter (where e.eligibility = 'not_eligible') as not_eligible,
  min(e.created_at) as first_contact_at,
  max(e.phase_entered_at) as last_phase_change_at
from assistant.engagements e
join trial.trials t on t.id = e.trial_id
where analytics.visible_trial(t.id)
group by t.id, e.phase;
comment on view analytics.recruitment_funnel is 'How many people are at each phase of the patient assistant journey, per trial.';

-- Access ---------------------------------------------------------------------------------

grant usage on schema assistant to analyst;
grant select on all tables in schema assistant to analyst;
alter default privileges in schema assistant grant select on tables to analyst;
grant select on analytics.recruitment_funnel to analyst, manager_agent;

grant usage on schema core, trial, clinical, assistant, manager_agent to patient_assistant;
grant select on trial.trials, trial.arms, trial.sites, trial.measures, trial.schedule_events,
  trial.collection_plans, trial.eligibility_criteria, trial.agent_profiles, trial.participants, core.people to patient_assistant;
grant select on clinical.data_sources to patient_assistant;
grant select, insert, update on clinical.observations, clinical.adverse_events to patient_assistant;
grant insert on manager_agent.alerts to patient_assistant;
grant select on assistant.prescreen_questions, assistant.consent_documents, assistant.site_hours to patient_assistant;
grant select, insert, update on assistant.engagements, assistant.goals, assistant.threads, assistant.messages,
  assistant.memories, assistant.forms, assistant.answers, assistant.passkeys, assistant.verifications,
  assistant.signatures, assistant.appointments to patient_assistant;
grant insert, select on assistant.audit_events to patient_assistant;
grant delete on assistant.memories to patient_assistant;
revoke execute on function assistant.use_person(uuid), assistant.person_for_handle(text, text),
  assistant.form_by_token(text), assistant.set_display_name(text), assistant.enroll(uuid, text) from public;
grant execute on function assistant.use_person(uuid), assistant.person_for_handle(text, text),
  assistant.form_by_token(text), assistant.set_display_name(text) to patient_assistant;

-- Row-level security: the patient_assistant role sees one person (assistant.use_person).
do $$
declare
  t text;
begin
  foreach t in array array[
    'assistant.engagements', 'assistant.goals', 'assistant.threads', 'assistant.messages', 'assistant.memories',
    'assistant.forms', 'assistant.answers', 'assistant.passkeys', 'assistant.verifications', 'assistant.signatures',
    'assistant.appointments', 'assistant.audit_events'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format(
      'create policy patient_assistant_own on %s to patient_assistant
         using (person_id = assistant.current_person_id())
         with check (person_id = assistant.current_person_id())', t);
  end loop;
end $$;

create policy patient_assistant_self on core.people for select to patient_assistant
  using (id = assistant.current_person_id());
create policy patient_assistant_self on trial.participants for select to patient_assistant
  using (person_id = assistant.current_person_id());
create policy patient_assistant_own on clinical.observations to patient_assistant
  using (participant_id in (select id from trial.participants where person_id = assistant.current_person_id()))
  with check (participant_id in (select id from trial.participants where person_id = assistant.current_person_id()));
create policy patient_assistant_own on clinical.adverse_events to patient_assistant
  using (participant_id in (select id from trial.participants where person_id = assistant.current_person_id()))
  with check (participant_id in (select id from trial.participants where person_id = assistant.current_person_id()));
create policy patient_assistant_raise on manager_agent.alerts for insert to patient_assistant
  with check (trial_id in (select trial_id from assistant.engagements where person_id = assistant.current_person_id()));

-- migrate:down
set local role app_owner;
drop policy patient_assistant_raise on manager_agent.alerts;
drop policy patient_assistant_own on clinical.adverse_events;
drop policy patient_assistant_own on clinical.observations;
drop policy patient_assistant_self on trial.participants;
drop policy patient_assistant_self on core.people;
drop view analytics.recruitment_funnel;
revoke all on all tables in schema core, trial, clinical, manager_agent from patient_assistant;
revoke usage on schema core, trial, clinical, manager_agent from patient_assistant;
drop schema assistant cascade;
