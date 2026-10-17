-- migrate:up
-- The patient assistant, added alongside the consent-first platform (schemas public, private,
-- audit, analytics). Purely additive: it creates the assistant schema and grants read access to
-- study content, and changes no platform table, trigger or rule.
--
-- The platform starts at the consent invitation (participants are created consent_pending).
-- Everything before that (a person texting in, learning about the study, prequalifying) lives
-- here, scoped to a PERSON. To hand someone to the platform, or act for them in it, the assistant
-- calls the functions in "Platform bridge" below; the platform's own triggers still validate every
-- row they write (opt-in, approved ICF, lifecycle, value types).
do $$
begin
  if not exists (select from pg_roles where rolname = 'patient_assistant') then create role patient_assistant nologin; end if;
end $$;

-- The platform keeps schema public closed to other roles, and only the database owner can open it.
-- Reading study content needs USAGE (table access is still granted table by table below).
do $$
begin
  if not has_schema_privilege('patient_assistant', 'public', 'USAGE') then
    raise exception 'patient_assistant needs USAGE on schema public. As the database owner (postgres), run: grant usage on schema public to patient_assistant;';
  end if;
end $$;

set local role app_owner;

create schema assistant;
comment on schema assistant is 'Patient assistant (iMessage): person-scoped memory, goals and journey phase; prequalification; mini-app forms; Face ID passkeys and identity checks; screening-visit booking; and patient-facing presentation of the platform''s studies. Writes to the platform go through assistant.* functions only.';

create table assistant.schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);
comment on table assistant.schema_migrations is 'Migrations applied from Patient-AI-Agent/db/migrations (npm run migrate). Separate from the platform''s public.schema_migrations.';

create function assistant.touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- People and journeys ------------------------------------------------------------------

create table assistant.people (
  id            uuid primary key default uuidv7(),
  handle        text not null unique,
  display_name  text,
  time_zone     text not null default 'America/New_York',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger touch before update on assistant.people for each row execute function assistant.touch();
comment on table assistant.people is 'Someone texting the assistant, before and after they become a platform participant. handle is their iMessage address (E.164 phone or Apple ID email); it becomes private.participant_contacts.secure_handle.';

create table assistant.engagements (
  id                   uuid primary key default uuidv7(),
  person_id            uuid not null references assistant.people (id) on delete cascade,
  study_id             uuid not null references public.studies (id) on delete cascade,
  site_id              uuid references public.sites (id),
  participant_id       uuid unique references public.participants (id) on delete set null,
  phase                text not null default 'prequalification' check (phase in (
                         'prequalification', 'consent', 'scheduling', 'screening', 'active', 'completed',
                         'not_eligible', 'declined', 'withdrawn')),
  phase_entered_at     timestamptz not null default now(),
  eligibility          text not null default 'unknown' check (eligibility in ('unknown', 'likely_eligible', 'needs_review', 'not_eligible')),
  eligibility_reasons  jsonb not null default '[]',
  contact_opt_in_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (person_id, study_id)
);
create index on assistant.engagements (study_id, phase);
create trigger touch before update on assistant.engagements for each row execute function assistant.touch();
comment on table assistant.engagements is 'One person''s journey with one study. phase is the assistant''s view; once a platform participant exists, assistant.sync_phase() keeps it in step with public.participants.status.';
comment on column assistant.engagements.participant_id is 'The platform participant, created by assistant.ensure_participant() when the prescreen passes or needs review. Null during prequalification.';
comment on column assistant.engagements.contact_opt_in_at is 'When the person agreed to be texted about the study (becomes the platform contact''s opted_in_at).';

create table assistant.goals (
  id             uuid primary key default uuidv7(),
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
  person_id      uuid not null references assistant.people (id) on delete cascade,
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
create trigger touch before update on assistant.goals for each row execute function assistant.touch();
comment on table assistant.goals is 'What the assistant is working toward in the current phase, generated from the phase playbook plus the study''s knowledge. The open goals go into every prompt.';

-- Conversation and memory ----------------------------------------------------------------

create table assistant.threads (
  id                 uuid primary key default uuidv7(),
  person_id          uuid not null references assistant.people (id) on delete cascade,
  channel            text not null default 'imessage' check (channel in ('imessage', 'console', 'web')),
  handle             text not null,
  external_space_id  text unique,
  last_message_at    timestamptz,
  created_at         timestamptz not null default now(),
  unique (person_id, channel),
  unique (id, person_id)
);
comment on table assistant.threads is 'One conversation per person per channel; external_space_id is the Spectrum (iMessage) chat.';

create table assistant.messages (
  id                   uuid primary key default uuidv7(),
  thread_id            uuid not null,
  person_id            uuid not null,
  direction            text not null check (direction in ('inbound', 'outbound')),
  author               text not null check (author in ('person', 'assistant', 'staff', 'system')),
  kind                 text not null default 'text' check (kind in ('text', 'card', 'event')),
  body                 text,
  external_id          text unique,
  form_id              uuid,
  platform_message_id  uuid references public.messages (id) on delete set null,
  model                text,
  sent_at              timestamptz not null default now(),
  foreign key (thread_id, person_id) references assistant.threads (id, person_id) on delete cascade
);
create index on assistant.messages (person_id, sent_at desc);
comment on table assistant.messages is 'The full transcript, including prequalification chat the platform does not model. Once a participant exists, messages the platform accepts are mirrored to public.messages (platform_message_id).';

create table assistant.memories (
  id                 uuid primary key default uuidv7(),
  person_id          uuid not null references assistant.people (id) on delete cascade,
  study_id           uuid references public.studies (id) on delete cascade,
  kind               text not null check (kind in ('fact', 'preference', 'concern', 'goal', 'routine', 'relationship', 'instruction', 'health', 'summary')),
  content            text not null,
  importance         smallint not null default 3 check (importance between 1 and 5),
  source_message_id  uuid references assistant.messages (id) on delete set null,
  superseded_by      uuid references assistant.memories (id) on delete set null,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now()
);
create index on assistant.memories (person_id, importance desc) where superseded_by is null;
comment on table assistant.memories is 'Long-term memory about one person. study_id null means it applies across studies. Current memories have superseded_by is null.';

-- Patient-facing presentation of platform studies -----------------------------------------
-- The platform holds the rules and the legal documents; these optional tables say how the
-- assistant presents them. Each has a sensible default when a study has no rows here.

create table assistant.study_profiles (
  study_id            uuid primary key references public.studies (id) on delete cascade,
  short_name          text,
  patient_summary     text,
  time_commitment     text,
  compensation        text,
  contact_phone       text,
  agent_instructions  text,
  updated_at          timestamptz not null default now()
);
create trigger touch before update on assistant.study_profiles for each row execute function assistant.touch();
comment on table assistant.study_profiles is 'Plain-language study details for patients and instructions for the assistant. Optional: without a row the assistant uses public.studies.';

create table assistant.prescreen_questions (
  id          uuid primary key default uuidv7(),
  study_id    uuid not null references public.studies (id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  position    smallint not null,
  prompt      text not null,
  help        text,
  type        text not null check (type in ('yes_no', 'number', 'choice', 'multi_choice', 'text')),
  options     jsonb,
  unit        text,
  min_value   numeric,
  max_value   numeric,
  required    boolean not null default true,
  show_if     jsonb,
  unique (study_id, key)
);
comment on table assistant.prescreen_questions is 'Patient-friendly wording for prescreen questions. A row whose key equals an eligibility_rules.field_name rewords the question for that field; other rows add questions no rule covers. Fields without a row get a generated question.';

create table assistant.consent_presentations (
  consent_document_id  uuid primary key references public.consent_documents (id) on delete cascade,
  summary              text not null,
  sections             jsonb not null check (jsonb_typeof(sections) = 'array'),
  comprehension        jsonb not null default '[]' check (jsonb_typeof(comprehension) = 'array'),
  presentation_hash    text not null default '',
  created_at           timestamptz not null default now()
);
create function assistant.hash_presentation() returns trigger language plpgsql as $$
begin
  new.presentation_hash := encode(sha256(convert_to(new.summary || E'\n' || new.sections::text || E'\n' || new.comprehension::text, 'UTF8')), 'hex');
  return new;
end $$;
create trigger hash_presentation before insert or update on assistant.consent_presentations
  for each row execute function assistant.hash_presentation();
comment on table assistant.consent_presentations is 'The readable, sectioned text of an approved ICF for the e-consent mini-app, plus teach-back questions. Without a row the assistant builds a summary from the study record. The signature records this hash.';

create table assistant.site_hours (
  site_id       uuid not null references public.sites (id) on delete cascade,
  weekday       smallint not null check (weekday between 1 and 7),
  opens         time not null,
  closes        time not null,
  slot_minutes  smallint not null default 60 check (slot_minutes between 10 and 240),
  primary key (site_id, weekday),
  check (closes > opens)
);
comment on table assistant.site_hours is 'When a site takes screening visits, in the site''s time zone (ISO weekday 1 = Monday). Sites without rows default to weekdays 9:00-16:00.';

-- What the assistant collects -------------------------------------------------------------

create table assistant.forms (
  id             uuid primary key default uuidv7(),
  token          text not null unique check (token ~ '^[A-Za-z0-9_-]{20,64}$'),
  person_id      uuid not null references assistant.people (id) on delete cascade,
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
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
create index on assistant.forms (engagement_id, kind, created_at desc);
comment on table assistant.forms is 'One mini-app card the assistant sent. token is the capability in the card URL; card keeps the iMessage message and session for in-place updates.';

create table assistant.answers (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references assistant.people (id) on delete cascade,
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
  key            text not null,
  value          jsonb not null,
  source         text not null check (source in ('form', 'chat', 'staff')),
  form_id        uuid references assistant.forms (id) on delete set null,
  confidence     numeric(3, 2) check (confidence between 0 and 1),
  answered_at    timestamptz not null default now(),
  unique (engagement_id, key)
);
comment on table assistant.answers is 'Prescreen answers keyed by eligibility_rules.field_name (or an assistant question key), from the form or extracted from chat.';

create table assistant.passkeys (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references assistant.people (id) on delete cascade,
  credential_id  text not null unique,
  public_key     bytea not null,
  counter        bigint not null default 0,
  transports     text[],
  device_type    text,
  backed_up      boolean,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
comment on table assistant.passkeys is 'WebAuthn passkeys; on iPhone, using one means Face ID.';

create table assistant.verifications (
  id          uuid primary key default uuidv7(),
  person_id   uuid not null references assistant.people (id) on delete cascade,
  form_id     uuid references assistant.forms (id) on delete cascade,
  action      text not null check (action in ('sign_consent', 'view_document', 'confirm_appointment')),
  method      text not null check (method in ('passkey', 'typed_name')),
  passkey_id  uuid references assistant.passkeys (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz
);
comment on table assistant.verifications is 'Short-lived proof of identity for one action: Face ID (passkey), or a typed full name where Face ID is unavailable. The consent signature records which was used.';

create table assistant.appointments (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references assistant.people (id) on delete cascade,
  engagement_id  uuid not null references assistant.engagements (id) on delete cascade,
  site_id        uuid not null references public.sites (id),
  kind           text not null default 'screening_visit' check (kind in ('screening_visit', 'phone_call', 'follow_up')),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text not null default 'booked' check (status in ('booked', 'cancelled', 'completed', 'no_show')),
  location       text,
  form_id        uuid references assistant.forms (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);
create unique index appointments_one_per_slot on assistant.appointments (site_id, starts_at) where status = 'booked';
create trigger touch before update on assistant.appointments for each row execute function assistant.touch();
comment on table assistant.appointments is 'Screening visits booked through the scheduler mini-app. One booking per site slot.';

create table assistant.audit_events (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references assistant.people (id) on delete cascade,
  engagement_id  uuid references assistant.engagements (id) on delete cascade,
  actor          text not null check (actor in ('person', 'assistant', 'system', 'staff')),
  action         text not null,
  detail         jsonb not null default '{}',
  ip_address     inet,
  user_agent     text,
  at             timestamptz not null default now()
);
create index on assistant.audit_events (person_id, at desc);
comment on table assistant.audit_events is 'Append-only trail of the assistant''s consequential events: phase changes, forms opened and submitted, identity checks, signatures, bookings. Platform writes are also recorded in audit.events.';

create table assistant.conversation_routes (
  external_space_id  text primary key,
  route              text not null check (route in ('patient_assistant', 'other')),
  reason             text,
  decided_at         timestamptz not null default now(),
  messages_routed    integer not null default 1
);
comment on table assistant.conversation_routes is 'Which bot answers each iMessage chat on a shared line, as last decided by the AI router. Holds no personal data, only the Spectrum chat id.';

-- Person scope -----------------------------------------------------------------------------

create function assistant.current_person_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.person_id', true), '')::uuid $$;

create function assistant.use_person(p_person_id uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (select 1 from assistant.people where id = p_person_id) then
    raise exception 'No person %', p_person_id using errcode = 'no_data_found';
  end if;
  perform set_config('app.person_id', p_person_id::text, true);
  return p_person_id;
end $$;
comment on function assistant.use_person(uuid) is 'Scopes the rest of the transaction to one person: row-level security then shows the patient_assistant role only their rows.';

create function assistant.person_for_handle(p_handle text) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare found_id uuid;
begin
  select id into found_id from assistant.people where handle = p_handle;
  if found_id is null then
    insert into assistant.people (handle) values (p_handle) on conflict (handle) do nothing returning id into found_id;
    if found_id is null then select id into found_id from assistant.people where handle = p_handle; end if;
  end if;
  return found_id;
end $$;

create function assistant.has_thread(p_handle text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from assistant.threads t join assistant.people p on p.id = t.person_id where p.handle = p_handle)
$$;

create function assistant.form_by_token(p_token text)
returns table (form_id uuid, person_id uuid, engagement_id uuid, kind text, status text, expires_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select id, person_id, engagement_id, kind, status, expires_at from assistant.forms where token = p_token
$$;

create function assistant.set_display_name(p_name text) returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  update assistant.people set display_name = left(trim(p_name), 120)
  where id = assistant.current_person_id() and nullif(trim(p_name), '') is not null
$$;

create function assistant.booked_slots(p_study_id uuid) returns table (site_id uuid, starts_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.site_id, a.starts_at from assistant.appointments a join public.sites s on s.id = a.site_id
  where s.study_id = p_study_id and a.status = 'booked' and a.starts_at > now()
$$;
comment on function assistant.booked_slots(uuid) is 'Taken screening-visit slots across a study (times only, no people), so the scheduler hides them.';

-- Platform bridge ---------------------------------------------------------------------------
-- Each function acts only on an engagement of the current person (assistant.use_person).

create function assistant.my_engagement(p_engagement uuid) returns assistant.engagements
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare e assistant.engagements;
begin
  select * into e from assistant.engagements where id = p_engagement and person_id = assistant.current_person_id();
  if not found then raise exception 'Engagement % is not the current person''s', p_engagement using errcode = 'insufficient_privilege'; end if;
  return e;
end $$;

create function assistant.platform_state(p_engagement uuid)
returns table (participant_code text, participant_status text, eligibility_status text, has_current_consent boolean, site_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  return query
  select p.participant_code, p.status, p.eligibility_status, public.has_current_consent(p.study_id, p.id), p.site_id
  from public.participants p where p.id = e.participant_id;
end $$;
comment on function assistant.platform_state(uuid) is 'The platform''s view of the current person''s participant: code, lifecycle status, eligibility and whether consent is current. No row before a participant exists.';

create function assistant.current_consent(p_engagement uuid)
returns table (consent_document_id uuid, document_name text, version text, status text, presented_at timestamptz,
               opened_at timestamptz, signed_at timestamptz, signed_by text, method text, presentation_hash text)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  return query
  select d.id, d.document_name, d.version, c.status, c.presented_at, c.opened_at, c.signed_at, c.signed_by,
         c.audit_metadata->>'method', c.audit_metadata->>'presentation_hash'
  from public.participant_consents c join public.consent_documents d on d.id = c.consent_document_id
  where c.participant_id = e.participant_id
  order by (d.id = public.current_consent_document(e.study_id, e.participant_id)) desc, c.presented_at desc
  limit 1;
end $$;
comment on function assistant.current_consent(uuid) is 'The current person''s consent record on the platform (current ICF first), with how they verified their identity.';

create function assistant.due_assessments(p_engagement uuid)
returns table (measure_code text, label text, due_at timestamptz, window_closes_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  return query
  select m.measure_code, m.label, a.due_at, a.window_closes_at
  from public.scheduled_assessments a join public.measure_definitions m on m.id = a.measure_id
  where a.participant_id = e.participant_id and a.status = 'pending' and now() between a.window_opens_at and a.window_closes_at
  order by a.due_at;
end $$;
comment on function assistant.due_assessments(uuid) is 'Platform assessments whose window is open now for the current person.';

-- Keeps the assistant's phase in step with what staff do in the platform (enroll, activate, complete).
create function assistant.sync_phase(p_engagement uuid) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  platform_status text;
  target text;
begin
  if e.participant_id is null then return e.phase; end if;
  select status into platform_status from public.participants where id = e.participant_id;
  target := case platform_status
    when 'enrolled' then 'active' when 'active' then 'active' when 'completed' then 'completed'
    when 'withdrawn' then case when e.phase in ('declined', 'withdrawn') then e.phase else 'withdrawn' end
    when 'screen_failed' then 'not_eligible' else e.phase end;
  if target <> e.phase then
    update assistant.engagements set phase = target, phase_entered_at = now() where id = e.id;
    insert into assistant.audit_events (person_id, engagement_id, actor, action, detail)
    values (e.person_id, e.id, 'staff', 'phase_changed', jsonb_build_object('from', e.phase, 'to', target, 'reason', 'participant is ' || platform_status));
  end if;
  return target;
end $$;

-- Hands a prequalified person to the platform: participant (consent_pending) plus contact.
create function assistant.ensure_participant(p_engagement uuid, p_site uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  person assistant.people;
  study public.studies;
  new_code text;
  new_participant uuid;
  is_phone boolean;
begin
  if e.participant_id is not null then return e.participant_id; end if;
  if e.eligibility not in ('likely_eligible', 'needs_review') then
    raise exception 'The prescreen has not passed (%)', e.eligibility using errcode = '23514';
  end if;
  select * into person from assistant.people where id = e.person_id;
  select * into study from public.studies where id = e.study_id;
  if not exists (select 1 from public.sites where id = p_site and study_id = e.study_id) then
    raise exception 'Site % is not part of study %', p_site, study.study_code using errcode = '23514';
  end if;
  is_phone := person.handle ~ '^\+[1-9][0-9]{6,14}$';
  -- Continue the study's numbering (STUDY-002-P004 -> STUDY-002-P005); retry if someone else took it.
  for attempt in 1..5 loop
    select format('%s-P%s', study.study_code, lpad((coalesce(max(substring(participant_code from '-P(\d+)$')::int), 0) + attempt)::text, 3, '0'))
      into new_code from public.participants where study_id = e.study_id;
    begin
      insert into public.participants (study_id, site_id, participant_code, eligibility_status, time_zone, is_synthetic)
      values (e.study_id, p_site, new_code,
              case e.eligibility when 'needs_review' then 'needs_review' else 'pending_review' end,
              person.time_zone, study.is_synthetic)
      returning id into new_participant;
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;
  insert into private.participant_contacts (study_id, participant_id, preferred_name, phone_number, email, secure_handle,
                                            preferred_channel, messaging_opt_in, opted_in_at)
  values (e.study_id, new_participant, person.display_name, case when is_phone then person.handle end,
          case when not is_phone then lower(person.handle) end, person.handle, 'secure_message',
          e.contact_opt_in_at is not null, e.contact_opt_in_at);
  update assistant.engagements set participant_id = new_participant, site_id = p_site where id = e.id;
  insert into assistant.audit_events (person_id, engagement_id, actor, action, detail)
  values (e.person_id, e.id, 'assistant', 'participant_created', jsonb_build_object('participant_id', new_participant, 'participant_code', new_code));
  return new_participant;
end $$;
comment on function assistant.ensure_participant(uuid, uuid) is 'Creates the platform participant (consent_pending, eligibility pending_review or needs_review) and contact (secure_message; opted in only if the person agreed) for the current person''s engagement.';

-- The platform thread for a participant's iMessage chat. Internal: not granted to the assistant.
create function assistant.platform_thread(p_engagement uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  space text;
  thread uuid;
begin
  select id into thread from public.message_threads
  where participant_id = e.participant_id and provider = 'photon' and channel = 'secure_message' and status = 'open'
  order by created_at desc limit 1;
  if thread is not null then return thread; end if;
  select external_space_id into space from assistant.threads where person_id = e.person_id order by last_message_at desc nulls last limit 1;
  begin
    insert into public.message_threads (study_id, participant_id, provider, channel, external_thread_id)
    values (e.study_id, e.participant_id, 'photon', 'secure_message', space) returning id into thread;
  exception when unique_violation then -- the chat is already linked to another study's participant
    insert into public.message_threads (study_id, participant_id, provider, channel)
    values (e.study_id, e.participant_id, 'photon', 'secure_message') returning id into thread;
  end;
  return thread;
end $$;

-- Mirrors one message into public.messages when the platform accepts it, else returns null
-- (for example a reminder before enrollment); it always stays in assistant.messages.
create function assistant.mirror_message(p_engagement uuid, p_direction text, p_message_type text, p_body text,
                                         p_external_id text, p_consent_document uuid default null) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  new_id uuid;
begin
  if e.participant_id is null or nullif(trim(p_body), '') is null then return null; end if;
  begin
    insert into public.messages (study_id, participant_id, thread_id, consent_document_id, direction, channel, provider,
                                 message_type, body, external_message_id, status, sent_at, received_at)
    values (e.study_id, e.participant_id, assistant.platform_thread(e.id), p_consent_document, p_direction, 'secure_message', 'photon',
            p_message_type, p_body, p_external_id,
            case p_direction when 'inbound' then 'received' else 'sent' end,
            case p_direction when 'outbound' then now() end,
            case p_direction when 'inbound' then now() end)
    on conflict (provider, external_message_id) do nothing
    returning id into new_id;
  exception when check_violation then
    return null;
  end;
  return new_id;
end $$;

create function assistant.present_consent(p_engagement uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  doc uuid;
  consent uuid;
begin
  if e.participant_id is null then raise exception 'No participant yet' using errcode = '23514'; end if;
  doc := public.current_consent_document(e.study_id, e.participant_id);
  if doc is null then raise exception 'The study has no active consent document' using errcode = '23514'; end if;
  insert into public.participant_consents (study_id, participant_id, consent_document_id, status, presented_at)
  values (e.study_id, e.participant_id, doc, 'sent', now())
  on conflict (participant_id, consent_document_id) do nothing returning id into consent;
  return coalesce(consent, (select c.id from public.participant_consents c where c.participant_id = e.participant_id and c.consent_document_id = doc));
end $$;
comment on function assistant.present_consent(uuid) is 'Records that the current ICF was sent to the current person (participant_consents status sent). Idempotent.';

create function assistant.consent_opened(p_engagement uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  update public.participant_consents set status = 'opened', opened_at = now()
  where participant_id = e.participant_id and status = 'sent'
    and consent_document_id = public.current_consent_document(e.study_id, e.participant_id);
end $$;

-- Records the e-signature on the platform and moves the participant to consented.
create function assistant.sign_consent(p_engagement uuid, p_signed_by text, p_evidence jsonb) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  signed timestamptz := now();
begin
  update public.participant_consents
  set status = 'signed', opened_at = coalesce(opened_at, signed), signed_at = signed, signed_by = left(p_signed_by, 200),
      copy_provided_at = signed, audit_metadata = audit_metadata || p_evidence || jsonb_build_object('via', 'patient_assistant')
  where participant_id = e.participant_id and status in ('sent', 'opened')
    and consent_document_id = public.current_consent_document(e.study_id, e.participant_id);
  if not found then raise exception 'No outstanding consent to sign' using errcode = '23514'; end if;
  update public.participants set status = 'consented' where id = e.participant_id and status = 'consent_pending';
  return signed;
end $$;
comment on function assistant.sign_consent(uuid, text, jsonb) is 'Signs the outstanding current ICF (the platform checks it is active, approved and in effect) with identity evidence in audit_metadata, and moves the participant to consented.';

-- Declining before enrolling, or withdrawing later. The platform has no separate declined status.
create function assistant.leave_study(p_engagement uuid, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  if e.participant_id is null then return; end if;
  update public.participant_consents set status = 'declined', declined_at = now(),
         audit_metadata = audit_metadata || jsonb_build_object('declined_via', 'patient_assistant', 'reason', left(p_reason, 300))
  where participant_id = e.participant_id and status in ('sent', 'opened');
  update public.participants set status = 'withdrawn', withdrawn_at = now()
  where id = e.participant_id and status in ('consent_pending', 'consented', 'enrolled', 'active');
end $$;

-- A study value the participant reported (check-in or chat). The platform requires enrollment and
-- current consent, matches type, choices and unit, and flags out-of-range values for review.
create function assistant.record_observation(p_engagement uuid, p_measure_code text, p_value jsonb, p_source_type text,
                                             p_raw text, p_platform_message uuid, p_confidence numeric) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  m public.measure_definitions;
  due uuid;
  new_id uuid;
begin
  select * into m from public.measure_definitions where study_id = e.study_id and measure_code = p_measure_code and is_active;
  if not found then raise exception 'Unknown measure %', p_measure_code using errcode = '23514'; end if;
  select a.id into due from public.scheduled_assessments a
  where a.participant_id = e.participant_id and a.measure_id = m.id and a.status = 'pending'
    and now() between a.window_opens_at and a.window_closes_at
  order by a.due_at limit 1;
  insert into public.observations (study_id, participant_id, measure_id, scheduled_assessment_id, source_type, raw_value, source_payload,
                                   numeric_value, boolean_value, text_value, json_value, unit, raw_message_id, parser_confidence, captured_at, metadata)
  values (e.study_id, e.participant_id, m.id, due, p_source_type, left(p_raw, 2000), jsonb_build_object('value', p_value, 'via', 'patient_assistant'),
          case when m.data_type in ('numeric', 'integer') then (p_value #>> '{}')::numeric end,
          case when m.data_type = 'boolean' then (p_value #>> '{}')::boolean end,
          case when m.data_type in ('text', 'choice') then p_value #>> '{}' end,
          case when m.data_type = 'json' then p_value end,
          m.unit, p_platform_message, p_confidence, now(), jsonb_build_object('engagement_id', e.id))
  returning id into new_id;
  return new_id;
end $$;
comment on function assistant.record_observation(uuid, text, jsonb, text, text, uuid, numeric) is 'Inserts a participant-reported observation, completing the matching open scheduled assessment if there is one.';

-- Asks staff to act. With a participant: a platform alert at their site. Before one: a notify_staff task.
-- p_dedupe names what the alert is about (e.g. 'symptom:dizziness'), so it isn't raised twice while open.
create function assistant.notify_staff(p_engagement uuid, p_severity text, p_reason text, p_action text,
                                       p_alert_type text default 'patient_assistant', p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  site uuid;
  dedupe text := 'assistant:' || e.id || ':' || coalesce(p_dedupe, md5(p_alert_type || p_reason));
  new_id uuid;
begin
  if e.participant_id is not null then
    select p.site_id into site from public.participants p where p.id = e.participant_id;
    begin
      insert into public.alerts (study_id, participant_id, assigned_site_id, alert_type, severity, reason, recommended_action, deduplication_key)
      values (e.study_id, e.participant_id, site, p_alert_type, p_severity, left(p_reason, 2000), left(p_action, 1000), dedupe)
      returning id into new_id;
    exception when unique_violation then
      return null; -- the same alert is already open
    end;
  else
    insert into public.workflow_tasks (study_id, action_type, payload, deduplication_key, requires_approval)
    values (e.study_id, 'notify_staff', jsonb_build_object('reason', left(p_reason, 2000), 'recommended_action', left(p_action, 1000),
            'severity', p_severity, 'alert_type', p_alert_type, 'source', 'patient_assistant', 'engagement_id', e.id, 'phase', e.phase),
            dedupe, false)
    on conflict (study_id, deduplication_key) do nothing returning id into new_id;
  end if;
  return new_id;
end $$;

-- After the screening visit is booked, ask staff to confirm enrollment (the platform requires them to).
create function assistant.request_enrollment(p_engagement uuid, p_visit_at timestamptz) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  new_id uuid;
begin
  if e.participant_id is null then raise exception 'No participant yet' using errcode = '23514'; end if;
  insert into public.workflow_tasks (study_id, participant_id, action_type, payload, deduplication_key, requires_approval, run_after)
  values (e.study_id, e.participant_id, 'confirm_enrollment',
          jsonb_build_object('source', 'patient_assistant', 'screening_visit_at', p_visit_at, 'prescreen', e.eligibility),
          'confirm_enrollment:' || e.participant_id, true, now())
  on conflict (study_id, deduplication_key) do update set payload = excluded.payload
  returning id into new_id;
  return new_id;
end $$;

-- Reporting -----------------------------------------------------------------------------------

create view assistant.recruitment_funnel as
select s.id as study_id, s.study_code,
       count(e.id) as people,
       count(e.id) filter (where e.eligibility <> 'unknown') as prescreened,
       count(e.id) filter (where e.eligibility = 'likely_eligible') as likely_eligible,
       count(e.id) filter (where e.eligibility = 'needs_review') as needs_review,
       count(e.id) filter (where e.eligibility = 'not_eligible') as not_eligible,
       count(e.participant_id) as handed_to_platform,
       count(e.id) filter (where e.phase in ('scheduling', 'screening', 'active', 'completed')) as consented,
       count(e.id) filter (where e.phase in ('screening', 'active', 'completed')) as visit_booked,
       count(e.id) filter (where e.phase in ('active', 'completed')) as enrolled,
       count(e.id) filter (where e.phase = 'declined') as declined
from public.studies s left join assistant.engagements e on e.study_id = s.id
group by s.id, s.study_code;
comment on view assistant.recruitment_funnel is 'Counts only: how many people reached each step of the assistant''s journey, per study.';

-- Access -------------------------------------------------------------------------------------

grant usage on schema assistant to patient_assistant, analyst, manager_agent;
grant select on assistant.recruitment_funnel to analyst, manager_agent;
grant select on public.studies, public.sites, public.study_arms, public.eligibility_rules, public.measure_definitions,
  public.assessment_schedules, public.consent_documents, public.study_documents to patient_assistant;
grant select on assistant.study_profiles, assistant.prescreen_questions, assistant.consent_presentations, assistant.site_hours to patient_assistant;
grant select, insert, update on assistant.people, assistant.engagements, assistant.goals, assistant.threads, assistant.messages,
  assistant.memories, assistant.forms, assistant.answers, assistant.passkeys, assistant.verifications, assistant.appointments,
  assistant.conversation_routes to patient_assistant;
grant select, insert on assistant.audit_events to patient_assistant;
grant delete on assistant.memories to patient_assistant;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p where p.pronamespace = 'assistant'::regnamespace loop
    execute format('revoke execute on function %s from public', f.sig);
    if f.proname not in ('touch', 'hash_presentation', 'platform_thread', 'my_engagement') then
      execute format('grant execute on function %s to patient_assistant', f.sig);
    end if;
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['assistant.engagements', 'assistant.goals', 'assistant.threads', 'assistant.messages', 'assistant.memories',
    'assistant.forms', 'assistant.answers', 'assistant.passkeys', 'assistant.verifications', 'assistant.appointments', 'assistant.audit_events'] loop
    execute format('alter table %s enable row level security', t);
    execute format('create policy own_person on %s to patient_assistant using (person_id = assistant.current_person_id()) with check (person_id = assistant.current_person_id())', t);
  end loop;
  alter table assistant.people enable row level security;
  create policy own_person on assistant.people to patient_assistant using (id = assistant.current_person_id()) with check (id = assistant.current_person_id());
end $$;

-- migrate:down
set local role app_owner;
revoke select on public.studies, public.sites, public.study_arms, public.eligibility_rules, public.measure_definitions,
  public.assessment_schedules, public.consent_documents, public.study_documents from patient_assistant;
drop schema assistant cascade;
