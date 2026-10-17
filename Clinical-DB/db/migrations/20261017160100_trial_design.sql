-- migrate:up
-- Trial design and configuration. Everything a trial needs before the first patient texts in.
set local role app_owner;

create table trial.trials (
  id                 uuid primary key default uuidv7(),
  code               text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  title              text not null,
  short_title        text,
  phase              text not null default 'II' check (phase in ('0', 'I', 'I/II', 'II', 'II/III', 'III', 'IV', 'observational')),
  status             text not null default 'draft' check (status in ('draft', 'recruiting', 'active', 'paused', 'completed', 'terminated')),
  therapeutic_area   text,
  intervention       text,
  sponsor            text,
  description        text,
  primary_endpoint   text,
  target_enrollment  integer check (target_enrollment > 0),
  start_date         date,
  end_date           date,
  timezone           text not null default 'America/New_York',
  protocol_version   text not null default '1.0',
  is_synthetic       boolean not null default false,
  settings           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (end_date >= start_date)
);
comment on table trial.trials is 'A clinical trial (study). The root of almost everything: arms, sites, staff, measures, participants and their data all belong to one trial.';
comment on column trial.trials.code is 'Short unique code used everywhere humans see the trial, for example NORTHSTAR-2.';
comment on column trial.trials.timezone is 'Time zone for local dates in analytics (what "today" means for daily measures).';
comment on column trial.trials.settings is 'Free-form trial settings that don''t deserve a column yet.';

create table trial.arms (
  id                 uuid primary key default uuidv7(),
  trial_id           uuid not null references trial.trials (id) on delete cascade,
  code               text not null check (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name               text not null,
  description        text,
  is_control         boolean not null default false,
  target_enrollment  integer check (target_enrollment > 0),
  allocation_ratio   numeric(5, 2) not null default 1 check (allocation_ratio > 0),
  created_at         timestamptz not null default now(),
  unique (trial_id, code),
  unique (trial_id, id)
);
comment on table trial.arms is 'A treatment group (cohort) within a trial, such as placebo or a dose level.';

create table trial.sites (
  id                      uuid primary key default uuidv7(),
  trial_id                uuid not null references trial.trials (id) on delete cascade,
  code                    text not null,
  name                    text not null,
  city                    text,
  region                  text,
  country                 text not null default 'US',
  principal_investigator  text,
  status                  text not null default 'active' check (status in ('pending', 'active', 'closed')),
  created_at              timestamptz not null default now(),
  unique (trial_id, code),
  unique (trial_id, id)
);
comment on table trial.sites is 'A clinic or research center that enrolls participants for a trial.';

create table trial.staff (
  id               uuid primary key default uuidv7(),
  trial_id         uuid not null references trial.trials (id) on delete cascade,
  person_id        uuid not null references core.people (id) on delete cascade,
  role             text not null check (role in ('manager', 'investigator', 'coordinator', 'monitor', 'data_manager')),
  receives_alerts  boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (trial_id, person_id, role)
);
create index on trial.staff (person_id);
comment on table trial.staff is 'Links a person to a trial in a staff role. The trial manager agent serves people in this table and limits them to their own trials.';
comment on column trial.staff.receives_alerts is 'Whether manager_agent.alerts for this trial are texted to this person.';

create table trial.eligibility_criteria (
  id           uuid primary key default uuidv7(),
  trial_id     uuid not null references trial.trials (id) on delete cascade,
  kind         text not null check (kind in ('inclusion', 'exclusion')),
  position     smallint not null,
  description  text not null,
  rule         jsonb,
  unique (trial_id, kind, position)
);
comment on table trial.eligibility_criteria is 'Inclusion and exclusion criteria, in protocol order. Useful for screening conversations.';
comment on column trial.eligibility_criteria.rule is 'Optional machine-readable version, for example {"measure": "age", "min": 18, "max": 65}.';

create table trial.measures (
  id                   uuid primary key default uuidv7(),
  trial_id             uuid not null references trial.trials (id) on delete cascade,
  code                 text not null check (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  label                text not null,
  description          text,
  category             text not null check (category in ('symptom', 'vital', 'adherence', 'patient_reported', 'lab', 'lifestyle', 'safety', 'other')),
  value_type           text not null check (value_type in ('number', 'integer', 'scale', 'boolean', 'choice', 'text', 'date')),
  unit                 text,
  min_value            numeric,
  max_value            numeric,
  choices              jsonb,
  is_primary_endpoint  boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (trial_id, code),
  unique (trial_id, id),
  check (max_value is null or min_value is null or max_value >= min_value),
  check (value_type <> 'choice' or jsonb_typeof(choices) = 'array')
);
create trigger set_updated_at before update on trial.measures for each row execute function core.set_updated_at();
comment on table trial.measures is 'The trial''s data dictionary: every kind of data point collected (pain score, dose taken, peak flow...). clinical.observations stores values against these.';
comment on column trial.measures.value_type is 'How to read a value: number/integer/scale use value_number, boolean uses value_boolean, text/choice/date use value_text.';
comment on column trial.measures.choices is 'For value_type = choice: [{"value": "mild", "label": "Mild"}, ...].';

create table trial.schedule_events (
  id                  uuid primary key default uuidv7(),
  trial_id            uuid not null references trial.trials (id) on delete cascade,
  code                text not null,
  name                text not null,
  day_offset          integer not null,
  window_before_days  integer not null default 0 check (window_before_days >= 0),
  window_after_days   integer not null default 0 check (window_after_days >= 0),
  description         text,
  unique (trial_id, code),
  unique (trial_id, id)
);
comment on table trial.schedule_events is 'The protocol''s visit schedule (schedule of assessments): baseline, week 2, week 4... clinical.visits tracks each participant''s actual visits.';
comment on column trial.schedule_events.day_offset is 'Study day relative to enrollment (0 = baseline; negative = screening).';

create table trial.collection_plans (
  id                 uuid primary key default uuidv7(),
  trial_id           uuid not null references trial.trials (id) on delete cascade,
  measure_id         uuid not null,
  frequency          text not null check (frequency in ('daily', 'weekly', 'per_visit', 'once', 'as_needed')),
  local_time         time,
  days_of_week       smallint[] check (days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  schedule_event_id  uuid,
  prompt             text not null,
  follow_up_prompt   text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (trial_id, measure_id) references trial.measures (trial_id, id) on delete cascade,
  foreign key (trial_id, schedule_event_id) references trial.schedule_events (trial_id, id) on delete cascade,
  check (frequency <> 'weekly' or days_of_week is not null),
  check (frequency <> 'per_visit' or schedule_event_id is not null)
);
create index on trial.collection_plans (trial_id) where is_active;
create trigger set_updated_at before update on trial.collection_plans for each row execute function core.set_updated_at();
comment on table trial.collection_plans is 'What the patient agent asks, and when: one row per measure and cadence. The scheduler turns these into patient_agent.check_ins.';
comment on column trial.collection_plans.local_time is 'Time of day to ask, in the participant''s time zone (core.people.timezone).';
comment on column trial.collection_plans.days_of_week is 'ISO weekdays for weekly plans (1 = Monday ... 7 = Sunday).';
comment on column trial.collection_plans.prompt is 'Suggested wording. The agent may rephrase it in its own voice; {first_name} is filled in.';

create table trial.participants (
  id                 uuid primary key default uuidv7(),
  trial_id           uuid not null references trial.trials (id) on delete cascade,
  person_id          uuid not null references core.people (id) on delete restrict,
  arm_id             uuid,
  site_id            uuid,
  subject_code       text not null,
  status             text not null default 'screening' check (status in ('screening', 'enrolled', 'active', 'completed', 'withdrawn', 'screen_failed')),
  consented_at       timestamptz,
  enrolled_at        timestamptz,
  completed_at       timestamptz,
  withdrawn_at       timestamptz,
  withdrawal_reason  text,
  sex                text check (sex in ('female', 'male', 'intersex', 'unknown')),
  birth_year         smallint check (birth_year between 1900 and 2100),
  notes              text,
  is_synthetic       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (trial_id, subject_code),
  unique (trial_id, person_id),
  unique (trial_id, id),
  foreign key (trial_id, arm_id) references trial.arms (trial_id, id),
  foreign key (trial_id, site_id) references trial.sites (trial_id, id),
  check (status not in ('enrolled', 'active', 'completed') or enrolled_at is not null),
  check (status <> 'withdrawn' or withdrawn_at is not null)
);
create index on trial.participants (person_id);
create trigger set_updated_at before update on trial.participants for each row execute function core.set_updated_at();
comment on table trial.participants is 'Enrollment: a person taking part in a trial as a patient. The unit every patient-level row hangs off (participant_id). Pseudonymous: analytics shows subject_code, never the person''s name or phone.';
comment on column trial.participants.subject_code is 'Pseudonymous ID used in all reporting, for example NS2-007.';
comment on column trial.participants.birth_year is 'Year only, to keep data minimal.';

create table trial.agent_profiles (
  id             uuid primary key default uuidv7(),
  trial_id       uuid not null references trial.trials (id) on delete cascade,
  audience       text not null check (audience in ('patient', 'manager')),
  name           text not null,
  model          text not null default 'claude-haiku-5-5',
  system_prompt  text not null,
  settings       jsonb not null default '{}',
  version        integer not null default 1,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index agent_profiles_one_active on trial.agent_profiles (trial_id, audience) where is_active;
create trigger set_updated_at before update on trial.agent_profiles for each row execute function core.set_updated_at();
create trigger set_updated_at before update on trial.trials for each row execute function core.set_updated_at();
comment on table trial.agent_profiles is 'How each trial''s agents behave: persona and instructions for the patient agent and the manager agent. One active profile per trial and audience; keep old versions for audit.';
comment on column trial.agent_profiles.settings is 'Behavior knobs, for example {"quiet_hours": ["21:30", "08:00"], "escalate_ae_grade": 3}.';

-- migrate:down
set local role app_owner;
drop table trial.agent_profiles, trial.participants, trial.collection_plans, trial.schedule_events,
  trial.measures, trial.eligibility_criteria, trial.staff, trial.sites, trial.arms, trial.trials;
