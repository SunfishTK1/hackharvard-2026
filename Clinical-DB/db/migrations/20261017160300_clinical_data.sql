-- migrate:up
-- Patient-scoped clinical data from every source, with provenance on every row.
set local role app_owner;

create table clinical.data_sources (
  id           uuid primary key default uuidv7(),
  code         text not null unique check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text not null,
  kind         text not null check (kind in ('patient_agent', 'synthetic', 'ehr', 'wearable', 'lab', 'manual', 'import', 'other')),
  description  text,
  created_at   timestamptz not null default now()
);
comment on table clinical.data_sources is 'Where data comes from. Every observation and adverse event names its source, so analytics can compare or filter agent-collected, synthetic and external data.';

insert into clinical.data_sources (code, name, kind, description) values
  ('patient_agent', 'Patient iMessage agent', 'patient_agent', 'Values the patient agent extracted from a conversation; linked to the message.'),
  ('synthetic', 'Synthetic generator', 'synthetic', 'Generated demo or test data. Never mix with real patient data.'),
  ('ehr', 'EHR export', 'ehr', 'Imported from an electronic health record.'),
  ('wearable', 'Wearable or home device', 'wearable', 'Readings from a connected device, such as a peak-flow meter or watch.'),
  ('lab', 'Lab results', 'lab', 'Central or local laboratory results.'),
  ('manual', 'Site staff entry', 'manual', 'Entered by site staff, for example during a visit.');

create table clinical.import_batches (
  id          uuid primary key default uuidv7(),
  source_id   uuid not null references clinical.data_sources (id),
  trial_id    uuid not null references trial.trials (id) on delete cascade,
  label       text not null,
  file_name   text,
  row_count   integer,
  metadata    jsonb not null default '{}',
  created_by  text,
  imported_at timestamptz not null default now()
);
comment on table clinical.import_batches is 'One bulk load (a CSV, an EHR extract, a synthetic run). Rows it created point here, so a bad import can be found and removed as a unit.';

create table clinical.observations (
  id               uuid primary key default uuidv7(),
  trial_id         uuid not null,
  participant_id   uuid not null,
  measure_id       uuid not null,
  value_number     numeric,
  value_boolean    boolean,
  value_text       text,
  value_json       jsonb,
  unit             text,
  observed_at      timestamptz not null,
  source_id        uuid not null references clinical.data_sources (id),
  import_batch_id  uuid references clinical.import_batches (id) on delete cascade,
  message_id       uuid references patient_agent.messages (id) on delete set null,
  check_in_id      uuid references patient_agent.check_ins (id) on delete set null,
  confidence       numeric(3, 2) check (confidence between 0 and 1),
  status           text not null default 'final' check (status in ('preliminary', 'final', 'amended', 'entered_in_error')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (trial_id, participant_id) references trial.participants (trial_id, id) on delete cascade,
  foreign key (trial_id, measure_id) references trial.measures (trial_id, id) on delete cascade,
  check (num_nonnulls(value_number, value_boolean, value_text, value_json) >= 1)
);
create index on clinical.observations (participant_id, measure_id, observed_at desc);
create index on clinical.observations (trial_id, measure_id, observed_at);
create index on clinical.observations (source_id);
create trigger set_updated_at before update on clinical.observations for each row execute function core.set_updated_at();
comment on table clinical.observations is 'The central fact table: one value of one measure for one participant at one time, from one source. Long format, so a new measure needs a trial.measures row, not a migration.';
comment on column clinical.observations.observed_at is 'When the value was true (the patient''s answer about today, the device reading time), not when it was stored.';
comment on column clinical.observations.message_id is 'For agent-collected values: the patient message the value came from.';
comment on column clinical.observations.confidence is 'For values a model extracted from free text: how sure it was (0 to 1). Null for direct measurements.';
comment on column clinical.observations.status is 'Use amended or entered_in_error instead of deleting, so the audit trail stays intact.';

create table clinical.adverse_events (
  id              uuid primary key default uuidv7(),
  trial_id        uuid not null,
  participant_id  uuid not null,
  term            text not null,
  description     text,
  grade           smallint check (grade between 1 and 5),
  is_serious      boolean not null default false,
  onset_at        timestamptz not null,
  resolved_at     timestamptz,
  relatedness     text not null default 'unknown' check (relatedness in ('unrelated', 'unlikely', 'possible', 'probable', 'definite', 'unknown')),
  action_taken    text not null default 'unknown' check (action_taken in ('none', 'dose_reduced', 'dose_interrupted', 'drug_withdrawn', 'other', 'unknown')),
  outcome         text not null default 'ongoing' check (outcome in ('ongoing', 'recovered', 'recovered_with_sequelae', 'fatal', 'unknown')),
  status          text not null default 'reported' check (status in ('reported', 'under_review', 'confirmed', 'closed', 'not_an_ae')),
  source_id       uuid not null references clinical.data_sources (id),
  message_id      uuid references patient_agent.messages (id) on delete set null,
  reviewed_by     uuid references core.people (id),
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (trial_id, participant_id) references trial.participants (trial_id, id) on delete cascade,
  check (resolved_at is null or resolved_at >= onset_at)
);
create index on clinical.adverse_events (trial_id, status);
create index on clinical.adverse_events (participant_id);
create trigger set_updated_at before update on clinical.adverse_events for each row execute function core.set_updated_at();
comment on table clinical.adverse_events is 'Safety events (AEs). The patient agent records what patients report; site staff review, grade and close them. Grade 3+ or serious events raise a manager alert automatically.';
comment on column clinical.adverse_events.term is 'Short name of the event, ideally a MedDRA preferred term (Nausea, Dizziness).';
comment on column clinical.adverse_events.grade is 'CTCAE severity: 1 mild, 2 moderate, 3 severe, 4 life-threatening, 5 death.';
comment on column clinical.adverse_events.is_serious is 'Regulatory "serious" (hospitalization, disability...), separate from severity grade.';

create table clinical.visits (
  id                 uuid primary key default uuidv7(),
  trial_id           uuid not null,
  participant_id     uuid not null,
  schedule_event_id  uuid not null,
  scheduled_on       date not null,
  completed_at       timestamptz,
  status             text not null default 'scheduled' check (status in ('scheduled', 'completed', 'missed', 'cancelled')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (trial_id, participant_id) references trial.participants (trial_id, id) on delete cascade,
  foreign key (trial_id, schedule_event_id) references trial.schedule_events (trial_id, id) on delete cascade,
  unique (participant_id, schedule_event_id),
  check (status <> 'completed' or completed_at is not null)
);
create trigger set_updated_at before update on clinical.visits for each row execute function core.set_updated_at();
comment on table clinical.visits is 'Each participant''s actual visits against the protocol schedule (trial.schedule_events).';

-- migrate:down
set local role app_owner;
drop table clinical.visits, clinical.adverse_events, clinical.observations, clinical.import_batches, clinical.data_sources;
