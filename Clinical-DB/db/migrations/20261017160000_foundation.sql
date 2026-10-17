-- migrate:up
-- Foundation: extensions, roles, one schema per domain, and the shared `core` identity schema.
-- Every later migration starts with `set local role app_owner` so app_owner owns all objects.

create extension if not exists vector;

-- Roles are created without login so these migrations run on any Postgres (a laptop, CI, the
-- server). scripts/roles.sql gives the login roles their passwords on the server.
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_owner') then create role app_owner nologin; end if;
  if not exists (select from pg_roles where rolname = 'developer') then create role developer nologin; end if;
  if not exists (select from pg_roles where rolname = 'patient_agent') then create role patient_agent nologin; end if;
  if not exists (select from pg_roles where rolname = 'manager_agent') then create role manager_agent nologin; end if;
  if not exists (select from pg_roles where rolname = 'analyst') then create role analyst nologin bypassrls; end if;
  execute format('grant create on database %I to app_owner', current_database());
  -- Lets developers run dbmate themselves (dbmate records versions in this table).
  if to_regclass('public.schema_migrations') is not null then
    grant select, insert, delete on public.schema_migrations to app_owner;
  end if;
end $$;
grant app_owner to developer;

set local role app_owner;

create schema core;
comment on schema core is 'Shared identity: people (patients and staff) and how to reach them. The only schema that holds direct identifiers such as phone numbers.';
create schema trial;
comment on schema trial is 'Trial design and configuration: trials, arms, sites, staff, eligibility, the data dictionary (measures), visit schedule, collection plans, enrollment (participants) and agent settings.';
create schema patient_agent;
comment on schema patient_agent is 'Working memory of the per-patient iMessage agent: one thread per participant, its messages, long-term memories and scheduled check-ins. Row-level security scopes the patient_agent role to one participant at a time.';
create schema clinical;
comment on schema clinical is 'Patient-scoped clinical data from every source (the patient agent, synthetic generators, EHR exports, wearables, labs, site staff): observations, adverse events and visits, with provenance.';
create schema manager_agent;
comment on schema manager_agent is 'Working memory of the trial manager iMessage agent: threads, messages, memories, a log of analyses it ran, and alerts it delivers.';
create schema analytics;
comment on schema analytics is 'Read-only views for trial managers and analysts. Pseudonymous (subject codes, never names or phone numbers) and automatically limited to the manager''s own trials for the manager_agent role.';

-- Keeps updated_at current on every table that has one.
create function core.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
comment on function core.set_updated_at() is 'Trigger function: sets updated_at to now() on update.';

create table core.people (
  id            uuid primary key default uuidv7(),
  display_name  text not null,
  phone_e164    text unique check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email         text,
  timezone      text not null default 'America/New_York',
  locale        text not null default 'en-US',
  is_synthetic  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index people_email_key on core.people (lower(email));
create trigger set_updated_at before update on core.people for each row execute function core.set_updated_at();
comment on table core.people is 'A human: patient, trial manager, investigator or coordinator. A person takes part in a trial through trial.participants (as a patient) or trial.staff (as staff).';
comment on column core.people.phone_e164 is 'Mobile number in E.164 (+16175550123). The iMessage agents look people up by this handle.';
comment on column core.people.email is 'Optional; also an iMessage handle when the person''s Apple ID sends from email.';
comment on column core.people.is_synthetic is 'True for generated demo people. Synthetic phone numbers use the reserved 555-01xx range.';

-- migrate:down
set local role app_owner;
drop schema analytics cascade;
drop schema manager_agent cascade;
drop schema clinical cascade;
drop schema patient_agent cascade;
drop schema trial cascade;
drop schema core cascade;
