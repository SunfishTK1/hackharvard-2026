--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: analytics; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA analytics;


--
-- Name: SCHEMA analytics; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA analytics IS 'Read-only views for trial managers and analysts. Pseudonymous (subject codes, never names or phone numbers) and automatically limited to the manager''s own trials for the manager_agent role.';


--
-- Name: clinical; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA clinical;


--
-- Name: SCHEMA clinical; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA clinical IS 'Patient-scoped clinical data from every source (the patient agent, synthetic generators, EHR exports, wearables, labs, site staff): observations, adverse events and visits, with provenance.';


--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: SCHEMA core; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA core IS 'Shared identity: people (patients and staff) and how to reach them. The only schema that holds direct identifiers such as phone numbers.';


--
-- Name: manager_agent; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA manager_agent;


--
-- Name: SCHEMA manager_agent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA manager_agent IS 'Working memory of the trial manager iMessage agent: threads, messages, memories, a log of analyses it ran, and alerts it delivers.';


--
-- Name: patient_agent; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA patient_agent;


--
-- Name: SCHEMA patient_agent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA patient_agent IS 'Working memory of the per-patient iMessage agent: one thread per participant, its messages, long-term memories and scheduled check-ins. Row-level security scopes the patient_agent role to one participant at a time.';


--
-- Name: trial; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA trial;


--
-- Name: SCHEMA trial; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA trial IS 'Trial design and configuration: trials, arms, sites, staff, eligibility, the data dictionary (measures), visit schedule, collection plans, enrollment (participants) and agent settings.';


--
-- Name: visible_trial(uuid); Type: FUNCTION; Schema: analytics; Owner: -
--

CREATE FUNCTION analytics.visible_trial(p_trial_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select current_user <> 'manager_agent' or p_trial_id = any (manager_agent.my_trial_ids())
$$;


--
-- Name: FUNCTION visible_trial(p_trial_id uuid); Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON FUNCTION analytics.visible_trial(p_trial_id uuid) IS 'True if the current role may see this trial. Limits manager_agent to its staff member''s trials.';


--
-- Name: alert_on_adverse_event(); Type: FUNCTION; Schema: clinical; Owner: -
--

CREATE FUNCTION clinical.alert_on_adverse_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION alert_on_adverse_event(); Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON FUNCTION clinical.alert_on_adverse_event() IS 'Raises a manager_agent.alerts row for grade 3+ or serious adverse events.';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  return new;
end $$;


--
-- Name: FUNCTION set_updated_at(); Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON FUNCTION core.set_updated_at() IS 'Trigger function: sets updated_at to now() on update.';


--
-- Name: current_staff_id(); Type: FUNCTION; Schema: manager_agent; Owner: -
--

CREATE FUNCTION manager_agent.current_staff_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select nullif(current_setting('app.staff_person_id', true), '')::uuid
$$;


--
-- Name: FUNCTION current_staff_id(); Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON FUNCTION manager_agent.current_staff_id() IS 'The staff member this session (transaction) is scoped to, or null.';


--
-- Name: find_staff(text); Type: FUNCTION; Schema: manager_agent; Owner: -
--

CREATE FUNCTION manager_agent.find_staff(p_handle text) RETURNS TABLE(person_id uuid, display_name text, trial_codes text[], thread_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select pe.id, pe.display_name, array_agg(distinct t.code order by t.code), min(th.id::text)::uuid
  from core.people pe
  join trial.staff s on s.person_id = pe.id
  join trial.trials t on t.id = s.trial_id
  left join manager_agent.threads th on th.person_id = pe.id and th.channel = 'imessage'
  where pe.phone_e164 = p_handle or lower(pe.email) = lower(p_handle) or th.handle = p_handle
  group by pe.id, pe.display_name
$$;


--
-- Name: FUNCTION find_staff(p_handle text); Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON FUNCTION manager_agent.find_staff(p_handle text) IS 'Who is texting? Resolves an iMessage handle to a staff member and their trials. Call before use_staff.';


--
-- Name: my_trial_ids(); Type: FUNCTION; Schema: manager_agent; Owner: -
--

CREATE FUNCTION manager_agent.my_trial_ids() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select coalesce(array_agg(distinct trial_id), '{}')
  from trial.staff
  where person_id = manager_agent.current_staff_id()
$$;


--
-- Name: FUNCTION my_trial_ids(); Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON FUNCTION manager_agent.my_trial_ids() IS 'Trials the current staff member works on. analytics.visible_trial() uses this to limit the manager_agent role.';


--
-- Name: use_staff(uuid); Type: FUNCTION; Schema: manager_agent; Owner: -
--

CREATE FUNCTION manager_agent.use_staff(p_person_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if not exists (select 1 from trial.staff where person_id = p_person_id) then
    raise exception 'Person % is not staff on any trial', p_person_id using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.staff_person_id', p_person_id::text, true);
  return p_person_id;
end $$;


--
-- Name: FUNCTION use_staff(p_person_id uuid); Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON FUNCTION manager_agent.use_staff(p_person_id uuid) IS 'Scopes the current transaction to one staff member and their trials.';


--
-- Name: current_participant_id(); Type: FUNCTION; Schema: patient_agent; Owner: -
--

CREATE FUNCTION patient_agent.current_participant_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select nullif(current_setting('app.participant_id', true), '')::uuid
$$;


--
-- Name: FUNCTION current_participant_id(); Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON FUNCTION patient_agent.current_participant_id() IS 'The participant this session (transaction) is scoped to, or null.';


--
-- Name: find_participant(text); Type: FUNCTION; Schema: patient_agent; Owner: -
--

CREATE FUNCTION patient_agent.find_participant(p_handle text) RETURNS TABLE(participant_id uuid, trial_id uuid, trial_code text, subject_code text, status text, thread_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select p.id, p.trial_id, t.code, p.subject_code, p.status, th.id
  from trial.participants p
  join core.people pe on pe.id = p.person_id
  join trial.trials t on t.id = p.trial_id
  left join patient_agent.threads th on th.participant_id = p.id and th.channel = 'imessage'
  where pe.phone_e164 = p_handle or lower(pe.email) = lower(p_handle) or th.handle = p_handle
  order by p.status in ('active', 'enrolled') desc, p.enrolled_at desc nulls last
$$;


--
-- Name: FUNCTION find_participant(p_handle text); Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON FUNCTION patient_agent.find_participant(p_handle text) IS 'Who is texting? Resolves an iMessage handle to enrollments, current ones first. Call before use_participant.';


--
-- Name: use_participant(uuid); Type: FUNCTION; Schema: patient_agent; Owner: -
--

CREATE FUNCTION patient_agent.use_participant(p_participant_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if not exists (select 1 from trial.participants where id = p_participant_id) then
    raise exception 'No participant %', p_participant_id using errcode = 'no_data_found';
  end if;
  perform set_config('app.participant_id', p_participant_id::text, true);
  return p_participant_id;
end $$;


--
-- Name: FUNCTION use_participant(p_participant_id uuid); Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON FUNCTION patient_agent.use_participant(p_participant_id uuid) IS 'Scopes the current transaction to one participant. Row-level security then limits the patient_agent role to that participant''s rows.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: adverse_events; Type: TABLE; Schema: clinical; Owner: -
--

CREATE TABLE clinical.adverse_events (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    term text NOT NULL,
    description text,
    grade smallint,
    is_serious boolean DEFAULT false NOT NULL,
    onset_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    relatedness text DEFAULT 'unknown'::text NOT NULL,
    action_taken text DEFAULT 'unknown'::text NOT NULL,
    outcome text DEFAULT 'ongoing'::text NOT NULL,
    status text DEFAULT 'reported'::text NOT NULL,
    source_id uuid NOT NULL,
    message_id uuid,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT adverse_events_action_taken_check CHECK ((action_taken = ANY (ARRAY['none'::text, 'dose_reduced'::text, 'dose_interrupted'::text, 'drug_withdrawn'::text, 'other'::text, 'unknown'::text]))),
    CONSTRAINT adverse_events_check CHECK (((resolved_at IS NULL) OR (resolved_at >= onset_at))),
    CONSTRAINT adverse_events_grade_check CHECK (((grade >= 1) AND (grade <= 5))),
    CONSTRAINT adverse_events_outcome_check CHECK ((outcome = ANY (ARRAY['ongoing'::text, 'recovered'::text, 'recovered_with_sequelae'::text, 'fatal'::text, 'unknown'::text]))),
    CONSTRAINT adverse_events_relatedness_check CHECK ((relatedness = ANY (ARRAY['unrelated'::text, 'unlikely'::text, 'possible'::text, 'probable'::text, 'definite'::text, 'unknown'::text]))),
    CONSTRAINT adverse_events_status_check CHECK ((status = ANY (ARRAY['reported'::text, 'under_review'::text, 'confirmed'::text, 'closed'::text, 'not_an_ae'::text])))
);


--
-- Name: TABLE adverse_events; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON TABLE clinical.adverse_events IS 'Safety events (AEs). The patient agent records what patients report; site staff review, grade and close them. Grade 3+ or serious events raise a manager alert automatically.';


--
-- Name: COLUMN adverse_events.term; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.adverse_events.term IS 'Short name of the event, ideally a MedDRA preferred term (Nausea, Dizziness).';


--
-- Name: COLUMN adverse_events.grade; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.adverse_events.grade IS 'CTCAE severity: 1 mild, 2 moderate, 3 severe, 4 life-threatening, 5 death.';


--
-- Name: COLUMN adverse_events.is_serious; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.adverse_events.is_serious IS 'Regulatory "serious" (hospitalization, disability...), separate from severity grade.';


--
-- Name: data_sources; Type: TABLE; Schema: clinical; Owner: -
--

CREATE TABLE clinical.data_sources (
    id uuid DEFAULT uuidv7() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_sources_code_check CHECK ((code ~ '^[a-z][a-z0-9_]{1,40}$'::text)),
    CONSTRAINT data_sources_kind_check CHECK ((kind = ANY (ARRAY['patient_agent'::text, 'synthetic'::text, 'ehr'::text, 'wearable'::text, 'lab'::text, 'manual'::text, 'import'::text, 'other'::text])))
);


--
-- Name: TABLE data_sources; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON TABLE clinical.data_sources IS 'Where data comes from. Every observation and adverse event names its source, so analytics can compare or filter agent-collected, synthetic and external data.';


--
-- Name: arms; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.arms (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    is_control boolean DEFAULT false NOT NULL,
    target_enrollment integer,
    allocation_ratio numeric(5,2) DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT arms_allocation_ratio_check CHECK ((allocation_ratio > (0)::numeric)),
    CONSTRAINT arms_code_check CHECK ((code ~ '^[a-z][a-z0-9_]{0,31}$'::text)),
    CONSTRAINT arms_target_enrollment_check CHECK ((target_enrollment > 0))
);


--
-- Name: TABLE arms; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.arms IS 'A treatment group (cohort) within a trial, such as placebo or a dose level.';


--
-- Name: participants; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.participants (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    person_id uuid NOT NULL,
    arm_id uuid,
    site_id uuid,
    subject_code text NOT NULL,
    status text DEFAULT 'screening'::text NOT NULL,
    consented_at timestamp with time zone,
    enrolled_at timestamp with time zone,
    completed_at timestamp with time zone,
    withdrawn_at timestamp with time zone,
    withdrawal_reason text,
    sex text,
    birth_year smallint,
    notes text,
    is_synthetic boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT participants_birth_year_check CHECK (((birth_year >= 1900) AND (birth_year <= 2100))),
    CONSTRAINT participants_check CHECK (((status <> ALL (ARRAY['enrolled'::text, 'active'::text, 'completed'::text])) OR (enrolled_at IS NOT NULL))),
    CONSTRAINT participants_check1 CHECK (((status <> 'withdrawn'::text) OR (withdrawn_at IS NOT NULL))),
    CONSTRAINT participants_sex_check CHECK ((sex = ANY (ARRAY['female'::text, 'male'::text, 'intersex'::text, 'unknown'::text]))),
    CONSTRAINT participants_status_check CHECK ((status = ANY (ARRAY['screening'::text, 'enrolled'::text, 'active'::text, 'completed'::text, 'withdrawn'::text, 'screen_failed'::text])))
);


--
-- Name: TABLE participants; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.participants IS 'Enrollment: a person taking part in a trial as a patient. The unit every patient-level row hangs off (participant_id). Pseudonymous: analytics shows subject_code, never the person''s name or phone.';


--
-- Name: COLUMN participants.subject_code; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.participants.subject_code IS 'Pseudonymous ID used in all reporting, for example NS2-007.';


--
-- Name: COLUMN participants.birth_year; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.participants.birth_year IS 'Year only, to keep data minimal.';


--
-- Name: trials; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.trials (
    id uuid DEFAULT uuidv7() NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    short_title text,
    phase text DEFAULT 'II'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    therapeutic_area text,
    intervention text,
    sponsor text,
    description text,
    primary_endpoint text,
    target_enrollment integer,
    start_date date,
    end_date date,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    protocol_version text DEFAULT '1.0'::text NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trials_check CHECK ((end_date >= start_date)),
    CONSTRAINT trials_code_check CHECK ((code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'::text)),
    CONSTRAINT trials_phase_check CHECK ((phase = ANY (ARRAY['0'::text, 'I'::text, 'I/II'::text, 'II'::text, 'II/III'::text, 'III'::text, 'IV'::text, 'observational'::text]))),
    CONSTRAINT trials_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'recruiting'::text, 'active'::text, 'paused'::text, 'completed'::text, 'terminated'::text]))),
    CONSTRAINT trials_target_enrollment_check CHECK ((target_enrollment > 0))
);


--
-- Name: TABLE trials; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.trials IS 'A clinical trial (study). The root of almost everything: arms, sites, staff, measures, participants and their data all belong to one trial.';


--
-- Name: COLUMN trials.code; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.trials.code IS 'Short unique code used everywhere humans see the trial, for example NORTHSTAR-2.';


--
-- Name: COLUMN trials.timezone; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.trials.timezone IS 'Time zone for local dates in analytics (what "today" means for daily measures).';


--
-- Name: COLUMN trials.settings; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.trials.settings IS 'Free-form trial settings that don''t deserve a column yet.';


--
-- Name: adverse_events; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.adverse_events AS
 SELECT e.id AS adverse_event_id,
    e.trial_id,
    t.code AS trial_code,
    e.participant_id,
    p.subject_code,
    a.code AS arm_code,
    e.term,
    e.description,
    e.grade,
    e.is_serious,
    e.relatedness,
    e.action_taken,
    e.outcome,
    e.status,
    e.onset_at,
    e.resolved_at,
    round((EXTRACT(epoch FROM (e.resolved_at - e.onset_at)) / 86400.0), 1) AS days_to_resolution,
    ds.code AS reported_via,
    (e.message_id IS NOT NULL) AS from_conversation
   FROM ((((clinical.adverse_events e
     JOIN trial.trials t ON ((t.id = e.trial_id)))
     JOIN trial.participants p ON ((p.id = e.participant_id)))
     LEFT JOIN trial.arms a ON ((a.id = p.arm_id)))
     JOIN clinical.data_sources ds ON ((ds.id = e.source_id)))
  WHERE analytics.visible_trial(e.trial_id);


--
-- Name: VIEW adverse_events; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.adverse_events IS 'Adverse events with subject code, arm, and how they were reported.';


--
-- Name: adverse_event_summary; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.adverse_event_summary AS
 SELECT trial_id,
    trial_code,
    arm_code,
    term,
    count(*) AS events,
    count(DISTINCT participant_id) AS participants,
    max(grade) AS max_grade,
    count(*) FILTER (WHERE is_serious) AS serious,
    count(*) FILTER (WHERE (status <> ALL (ARRAY['closed'::text, 'not_an_ae'::text]))) AS open
   FROM analytics.adverse_events
  WHERE (status <> 'not_an_ae'::text)
  GROUP BY trial_id, trial_code, arm_code, term;


--
-- Name: VIEW adverse_event_summary; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.adverse_event_summary IS 'Adverse event counts by trial, arm and term: the safety table.';


--
-- Name: check_in_adherence; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.check_in_adherence AS
SELECT
    NULL::uuid AS trial_id,
    NULL::text AS trial_code,
    NULL::uuid AS participant_id,
    NULL::text AS subject_code,
    NULL::text AS arm_code,
    NULL::date AS week_start,
    NULL::bigint AS prompted,
    NULL::bigint AS answered,
    NULL::bigint AS missed,
    NULL::numeric AS response_rate;


--
-- Name: VIEW check_in_adherence; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.check_in_adherence IS 'Weekly check-in response rate per participant: how reliably each patient answers the agent.';


--
-- Name: enrollment; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.enrollment AS
SELECT
    NULL::uuid AS trial_id,
    NULL::text AS trial_code,
    NULL::text AS arm_code,
    NULL::text AS arm_name,
    NULL::boolean AS is_control,
    NULL::integer AS target_enrollment,
    NULL::bigint AS enrolled,
    NULL::bigint AS active,
    NULL::bigint AS completed,
    NULL::bigint AS withdrawn;


--
-- Name: VIEW enrollment; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.enrollment IS 'Enrollment by arm against target.';


--
-- Name: observations; Type: TABLE; Schema: clinical; Owner: -
--

CREATE TABLE clinical.observations (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    measure_id uuid NOT NULL,
    value_number numeric,
    value_boolean boolean,
    value_text text,
    value_json jsonb,
    unit text,
    observed_at timestamp with time zone NOT NULL,
    source_id uuid NOT NULL,
    import_batch_id uuid,
    message_id uuid,
    check_in_id uuid,
    confidence numeric(3,2),
    status text DEFAULT 'final'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observations_check CHECK ((num_nonnulls(value_number, value_boolean, value_text, value_json) >= 1)),
    CONSTRAINT observations_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT observations_status_check CHECK ((status = ANY (ARRAY['preliminary'::text, 'final'::text, 'amended'::text, 'entered_in_error'::text])))
);


--
-- Name: TABLE observations; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON TABLE clinical.observations IS 'The central fact table: one value of one measure for one participant at one time, from one source. Long format, so a new measure needs a trial.measures row, not a migration.';


--
-- Name: COLUMN observations.observed_at; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.observations.observed_at IS 'When the value was true (the patient''s answer about today, the device reading time), not when it was stored.';


--
-- Name: COLUMN observations.message_id; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.observations.message_id IS 'For agent-collected values: the patient message the value came from.';


--
-- Name: COLUMN observations.confidence; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.observations.confidence IS 'For values a model extracted from free text: how sure it was (0 to 1). Null for direct measurements.';


--
-- Name: COLUMN observations.status; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON COLUMN clinical.observations.status IS 'Use amended or entered_in_error instead of deleting, so the audit trail stays intact.';


--
-- Name: measures; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.measures (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    description text,
    category text NOT NULL,
    value_type text NOT NULL,
    unit text,
    min_value numeric,
    max_value numeric,
    choices jsonb,
    is_primary_endpoint boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT measures_category_check CHECK ((category = ANY (ARRAY['symptom'::text, 'vital'::text, 'adherence'::text, 'patient_reported'::text, 'lab'::text, 'lifestyle'::text, 'safety'::text, 'other'::text]))),
    CONSTRAINT measures_check CHECK (((max_value IS NULL) OR (min_value IS NULL) OR (max_value >= min_value))),
    CONSTRAINT measures_check1 CHECK (((value_type <> 'choice'::text) OR (jsonb_typeof(choices) = 'array'::text))),
    CONSTRAINT measures_code_check CHECK ((code ~ '^[a-z][a-z0-9_]{1,62}$'::text)),
    CONSTRAINT measures_value_type_check CHECK ((value_type = ANY (ARRAY['number'::text, 'integer'::text, 'scale'::text, 'boolean'::text, 'choice'::text, 'text'::text, 'date'::text])))
);


--
-- Name: TABLE measures; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.measures IS 'The trial''s data dictionary: every kind of data point collected (pain score, dose taken, peak flow...). clinical.observations stores values against these.';


--
-- Name: COLUMN measures.value_type; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.measures.value_type IS 'How to read a value: number/integer/scale use value_number, boolean uses value_boolean, text/choice/date use value_text.';


--
-- Name: COLUMN measures.choices; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.measures.choices IS 'For value_type = choice: [{"value": "mild", "label": "Mild"}, ...].';


--
-- Name: observations; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.observations AS
 SELECT o.id AS observation_id,
    o.trial_id,
    t.code AS trial_code,
    o.participant_id,
    p.subject_code,
    a.code AS arm_code,
    m.code AS measure_code,
    m.label AS measure_label,
    m.category,
    m.value_type,
    o.value_number,
    o.value_boolean,
    o.value_text,
    o.value_json,
    COALESCE((o.value_number)::text, (o.value_boolean)::text, o.value_text, (o.value_json)::text) AS value_display,
    COALESCE(o.unit, m.unit) AS unit,
    o.observed_at,
    ((o.observed_at AT TIME ZONE t.timezone))::date AS local_date,
    ds.code AS source_code,
    ds.kind AS source_kind,
    o.confidence,
    o.status,
    (o.message_id IS NOT NULL) AS from_conversation
   FROM (((((clinical.observations o
     JOIN trial.trials t ON ((t.id = o.trial_id)))
     JOIN trial.participants p ON ((p.id = o.participant_id)))
     LEFT JOIN trial.arms a ON ((a.id = p.arm_id)))
     JOIN trial.measures m ON ((m.id = o.measure_id)))
     JOIN clinical.data_sources ds ON ((ds.id = o.source_id)))
  WHERE ((o.status <> 'entered_in_error'::text) AND analytics.visible_trial(o.trial_id));


--
-- Name: VIEW observations; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.observations IS 'Every valid observation in long format with measure, arm and source labels. The base for ad hoc analysis.';


--
-- Name: latest_observations; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.latest_observations AS
 SELECT DISTINCT ON (participant_id, measure_code) observation_id,
    trial_id,
    trial_code,
    participant_id,
    subject_code,
    arm_code,
    measure_code,
    measure_label,
    category,
    value_type,
    value_number,
    value_boolean,
    value_text,
    value_json,
    value_display,
    unit,
    observed_at,
    local_date,
    source_code,
    source_kind,
    confidence,
    status,
    from_conversation
   FROM analytics.observations
  ORDER BY participant_id, measure_code, observed_at DESC;


--
-- Name: VIEW latest_observations; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.latest_observations IS 'Most recent value of each measure for each participant.';


--
-- Name: measure_daily; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.measure_daily AS
 SELECT trial_id,
    trial_code,
    arm_code,
    measure_code,
    measure_label,
    value_type,
    unit,
    local_date,
    count(DISTINCT participant_id) AS participants,
    count(*) AS observations,
    round(avg(value_number), 2) AS mean_value,
    min(value_number) AS min_value,
    max(value_number) AS max_value,
    round(avg((value_boolean)::integer), 3) AS share_true
   FROM analytics.observations
  GROUP BY trial_id, trial_code, arm_code, measure_code, measure_label, value_type, unit, local_date;


--
-- Name: VIEW measure_daily; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.measure_daily IS 'Daily aggregates per trial, arm and measure: means for numbers, share true for yes/no measures.';


--
-- Name: check_ins; Type: TABLE; Schema: patient_agent; Owner: -
--

CREATE TABLE patient_agent.check_ins (
    id uuid DEFAULT uuidv7() NOT NULL,
    participant_id uuid NOT NULL,
    collection_plan_id uuid NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    prompt_message_id uuid,
    response_message_id uuid,
    answered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_ins_check CHECK (((status <> 'answered'::text) OR (answered_at IS NOT NULL))),
    CONSTRAINT check_ins_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'answered'::text, 'missed'::text, 'skipped'::text, 'cancelled'::text])))
);


--
-- Name: TABLE check_ins; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON TABLE patient_agent.check_ins IS 'One scheduled question for one participant, made from a trial.collection_plans row. Tracks sent, answered or missed, which drives adherence analytics.';


--
-- Name: messages; Type: TABLE; Schema: patient_agent; Owner: -
--

CREATE TABLE patient_agent.messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    thread_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    direction text NOT NULL,
    author text NOT NULL,
    body text,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    external_id text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    model text,
    usage jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_author_check CHECK ((author = ANY (ARRAY['patient'::text, 'agent'::text, 'staff'::text, 'system'::text]))),
    CONSTRAINT messages_check CHECK (((direction = 'inbound'::text) = (author = 'patient'::text))),
    CONSTRAINT messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);


--
-- Name: TABLE messages; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON TABLE patient_agent.messages IS 'Every message in a patient conversation, both directions. The transcript the agent rereads for short-term context.';


--
-- Name: COLUMN messages.content; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.messages.content IS 'Non-text parts: attachments, structured payloads, provider metadata.';


--
-- Name: COLUMN messages.external_id; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.messages.external_id IS 'Provider message ID (Photon pho_msg_...). Unique, so replaying an event can''t store a message twice.';


--
-- Name: COLUMN messages.usage; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.messages.usage IS 'For agent messages: token counts and latency from the model call.';


--
-- Name: threads; Type: TABLE; Schema: patient_agent; Owner: -
--

CREATE TABLE patient_agent.threads (
    id uuid DEFAULT uuidv7() NOT NULL,
    participant_id uuid NOT NULL,
    channel text DEFAULT 'imessage'::text NOT NULL,
    handle text NOT NULL,
    agent_handle text,
    external_space_id text,
    external_agent_user_id text,
    status text DEFAULT 'active'::text NOT NULL,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT threads_channel_check CHECK ((channel = ANY (ARRAY['imessage'::text, 'sms'::text, 'whatsapp'::text, 'email'::text, 'web'::text]))),
    CONSTRAINT threads_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'closed'::text])))
);


--
-- Name: TABLE threads; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON TABLE patient_agent.threads IS 'One conversation per participant per channel: the iMessage agent''s link between a patient''s phone and their enrollment.';


--
-- Name: COLUMN threads.handle; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.threads.handle IS 'The patient''s address on the channel (E.164 phone or iMessage email).';


--
-- Name: COLUMN threads.agent_handle; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.threads.agent_handle IS 'The agent''s line the patient texts, for example the Photon number.';


--
-- Name: COLUMN threads.external_space_id; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.threads.external_space_id IS 'Messaging provider''s conversation ID (Photon space, pho_spc_...).';


--
-- Name: COLUMN threads.state; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.threads.state IS 'Short-lived working state, for example {"awaiting": "pain_score", "check_in_id": "..."}.';


--
-- Name: sites; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.sites (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    city text,
    region text,
    country text DEFAULT 'US'::text NOT NULL,
    principal_investigator text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sites_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'closed'::text])))
);


--
-- Name: TABLE sites; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.sites IS 'A clinic or research center that enrolls participants for a trial.';


--
-- Name: participants; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.participants AS
 SELECT p.id AS participant_id,
    p.trial_id,
    t.code AS trial_code,
    p.subject_code,
    a.code AS arm_code,
    a.name AS arm_name,
    s.code AS site_code,
    p.status,
    p.sex,
    p.birth_year,
    p.enrolled_at,
    p.completed_at,
    p.withdrawn_at,
    p.withdrawal_reason,
    (((now() AT TIME ZONE t.timezone))::date - ((p.enrolled_at AT TIME ZONE t.timezone))::date) AS study_day,
    th.last_message_at,
    COALESCE(msg.from_patient_7d, (0)::bigint) AS messages_from_patient_7d,
    COALESCE(ci.prompted_14d, (0)::bigint) AS check_ins_14d,
    COALESCE(ci.answered_14d, (0)::bigint) AS check_ins_answered_14d,
    round(((ci.answered_14d)::numeric / (NULLIF(ci.prompted_14d, 0))::numeric), 2) AS check_in_response_rate_14d,
    COALESCE(obs.count_7d, (0)::bigint) AS observations_7d,
    obs.last_observed_at,
    COALESCE(ae.open_count, (0)::bigint) AS open_adverse_events,
    ae.max_grade AS max_adverse_event_grade,
    p.is_synthetic
   FROM ((((((((trial.participants p
     JOIN trial.trials t ON ((t.id = p.trial_id)))
     LEFT JOIN trial.arms a ON ((a.id = p.arm_id)))
     LEFT JOIN trial.sites s ON ((s.id = p.site_id)))
     LEFT JOIN patient_agent.threads th ON (((th.participant_id = p.id) AND (th.channel = 'imessage'::text))))
     LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE ((m.direction = 'inbound'::text) AND (m.sent_at > (now() - '7 days'::interval)))) AS from_patient_7d
           FROM patient_agent.messages m
          WHERE (m.participant_id = p.id)) msg ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE (c.status = ANY (ARRAY['sent'::text, 'answered'::text, 'missed'::text]))) AS prompted_14d,
            count(*) FILTER (WHERE (c.status = 'answered'::text)) AS answered_14d
           FROM patient_agent.check_ins c
          WHERE ((c.participant_id = p.id) AND (c.scheduled_for > (now() - '14 days'::interval)))) ci ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE (o.observed_at > (now() - '7 days'::interval))) AS count_7d,
            max(o.observed_at) AS last_observed_at
           FROM clinical.observations o
          WHERE ((o.participant_id = p.id) AND (o.status <> 'entered_in_error'::text))) obs ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) FILTER (WHERE (e.status <> ALL (ARRAY['closed'::text, 'not_an_ae'::text]))) AS open_count,
            max(e.grade) AS max_grade
           FROM clinical.adverse_events e
          WHERE (e.participant_id = p.id)) ae ON (true))
  WHERE analytics.visible_trial(p.trial_id);


--
-- Name: VIEW participants; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.participants IS 'Pseudonymous roster with engagement and safety signals per participant: check-in response rate, recent data, open AEs.';


--
-- Name: source_coverage; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.source_coverage AS
 SELECT trial_id,
    trial_code,
    source_code,
    source_kind,
    count(*) AS observations,
    count(DISTINCT participant_id) AS participants,
    count(DISTINCT measure_code) AS measures,
    min(observed_at) AS first_observed_at,
    max(observed_at) AS last_observed_at
   FROM analytics.observations
  GROUP BY trial_id, trial_code, source_code, source_kind;


--
-- Name: VIEW source_coverage; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.source_coverage IS 'How much data each source contributes per trial: agent-collected vs synthetic vs EHR, wearables and labs.';


--
-- Name: trials; Type: VIEW; Schema: analytics; Owner: -
--

CREATE VIEW analytics.trials AS
SELECT
    NULL::uuid AS trial_id,
    NULL::text AS trial_code,
    NULL::text AS title,
    NULL::text AS phase,
    NULL::text AS status,
    NULL::text AS therapeutic_area,
    NULL::text AS intervention,
    NULL::text AS primary_endpoint,
    NULL::integer AS target_enrollment,
    NULL::date AS start_date,
    NULL::date AS end_date,
    NULL::bigint AS enrolled,
    NULL::bigint AS active,
    NULL::bigint AS withdrawn,
    NULL::bigint AS screening,
    NULL::bigint AS open_adverse_events,
    NULL::bigint AS serious_adverse_events,
    NULL::bigint AS open_alerts,
    NULL::bigint AS observations_7d,
    NULL::boolean AS is_synthetic;


--
-- Name: VIEW trials; Type: COMMENT; Schema: analytics; Owner: -
--

COMMENT ON VIEW analytics.trials IS 'One row per trial: status, enrollment against target, open safety items, recent data volume.';


--
-- Name: import_batches; Type: TABLE; Schema: clinical; Owner: -
--

CREATE TABLE clinical.import_batches (
    id uuid DEFAULT uuidv7() NOT NULL,
    source_id uuid NOT NULL,
    trial_id uuid NOT NULL,
    label text NOT NULL,
    file_name text,
    row_count integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE import_batches; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON TABLE clinical.import_batches IS 'One bulk load (a CSV, an EHR extract, a synthetic run). Rows it created point here, so a bad import can be found and removed as a unit.';


--
-- Name: visits; Type: TABLE; Schema: clinical; Owner: -
--

CREATE TABLE clinical.visits (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    schedule_event_id uuid NOT NULL,
    scheduled_on date NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'scheduled'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT visits_check CHECK (((status <> 'completed'::text) OR (completed_at IS NOT NULL))),
    CONSTRAINT visits_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'missed'::text, 'cancelled'::text])))
);


--
-- Name: TABLE visits; Type: COMMENT; Schema: clinical; Owner: -
--

COMMENT ON TABLE clinical.visits IS 'Each participant''s actual visits against the protocol schedule (trial.schedule_events).';


--
-- Name: people; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.people (
    id uuid DEFAULT uuidv7() NOT NULL,
    display_name text NOT NULL,
    phone_e164 text,
    email text,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    locale text DEFAULT 'en-US'::text NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT people_phone_e164_check CHECK ((phone_e164 ~ '^\+[1-9][0-9]{6,14}$'::text))
);


--
-- Name: TABLE people; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.people IS 'A human: patient, trial manager, investigator or coordinator. A person takes part in a trial through trial.participants (as a patient) or trial.staff (as staff).';


--
-- Name: COLUMN people.phone_e164; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.people.phone_e164 IS 'Mobile number in E.164 (+16175550123). The iMessage agents look people up by this handle.';


--
-- Name: COLUMN people.email; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.people.email IS 'Optional; also an iMessage handle when the person''s Apple ID sends from email.';


--
-- Name: COLUMN people.is_synthetic; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.people.is_synthetic IS 'True for generated demo people. Synthetic phone numbers use the reserved 555-01xx range.';


--
-- Name: alerts; Type: TABLE; Schema: manager_agent; Owner: -
--

CREATE TABLE manager_agent.alerts (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    participant_id uuid,
    kind text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    title text NOT NULL,
    detail text,
    adverse_event_id uuid,
    observation_id uuid,
    recipient_person_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    delivered_message_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    CONSTRAINT alerts_kind_check CHECK ((kind = ANY (ARRAY['adverse_event'::text, 'missed_check_ins'::text, 'out_of_range'::text, 'withdrawal_risk'::text, 'data_quality'::text, 'other'::text]))),
    CONSTRAINT alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'sent'::text, 'acknowledged'::text, 'resolved'::text])))
);


--
-- Name: TABLE alerts; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON TABLE manager_agent.alerts IS 'Things a trial manager should hear about without asking: serious adverse events, missed check-ins, out-of-range values. Raised by triggers or the patient agent; texted by the manager agent.';


--
-- Name: COLUMN alerts.recipient_person_id; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON COLUMN manager_agent.alerts.recipient_person_id IS 'A specific staff member, or null for every staff member on the trial with receives_alerts.';


--
-- Name: analyses; Type: TABLE; Schema: manager_agent; Owner: -
--

CREATE TABLE manager_agent.analyses (
    id uuid DEFAULT uuidv7() NOT NULL,
    person_id uuid NOT NULL,
    trial_id uuid,
    thread_id uuid,
    request_message_id uuid,
    response_message_id uuid,
    question text NOT NULL,
    sql_text text,
    result jsonb,
    narrative text,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT analyses_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: TABLE analyses; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON TABLE manager_agent.analyses IS 'Audit log of every analysis the manager agent ran: the question, the SQL it wrote against analytics.*, the result and the iMessage-sized answer. Also a cache for repeat questions.';


--
-- Name: memories; Type: TABLE; Schema: manager_agent; Owner: -
--

CREATE TABLE manager_agent.memories (
    id uuid DEFAULT uuidv7() NOT NULL,
    person_id uuid NOT NULL,
    trial_id uuid,
    kind text NOT NULL,
    content text NOT NULL,
    importance smallint DEFAULT 3 NOT NULL,
    source_message_id uuid,
    covers_from timestamp with time zone,
    covers_to timestamp with time zone,
    embedding public.vector,
    embedding_model text,
    superseded_by uuid,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memories_check CHECK (((embedding IS NULL) = (embedding_model IS NULL))),
    CONSTRAINT memories_importance_check CHECK (((importance >= 1) AND (importance <= 5))),
    CONSTRAINT memories_kind_check CHECK ((kind = ANY (ARRAY['preference'::text, 'focus'::text, 'fact'::text, 'instruction'::text, 'saved_question'::text, 'summary'::text])))
);


--
-- Name: TABLE memories; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON TABLE manager_agent.memories IS 'Long-term memory about one manager: report preferences, what they are watching, standing instructions, saved questions, conversation summaries. trial_id null means it applies to all their trials.';


--
-- Name: messages; Type: TABLE; Schema: manager_agent; Owner: -
--

CREATE TABLE manager_agent.messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    thread_id uuid NOT NULL,
    person_id uuid NOT NULL,
    direction text NOT NULL,
    author text NOT NULL,
    body text,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    external_id text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    model text,
    usage jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_author_check CHECK ((author = ANY (ARRAY['manager'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT messages_check CHECK (((direction = 'inbound'::text) = (author = 'manager'::text))),
    CONSTRAINT messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);


--
-- Name: TABLE messages; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON TABLE manager_agent.messages IS 'Every message between a trial manager and the manager agent.';


--
-- Name: threads; Type: TABLE; Schema: manager_agent; Owner: -
--

CREATE TABLE manager_agent.threads (
    id uuid DEFAULT uuidv7() NOT NULL,
    person_id uuid NOT NULL,
    channel text DEFAULT 'imessage'::text NOT NULL,
    handle text NOT NULL,
    agent_handle text,
    external_space_id text,
    external_agent_user_id text,
    default_trial_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT threads_channel_check CHECK ((channel = ANY (ARRAY['imessage'::text, 'sms'::text, 'whatsapp'::text, 'email'::text, 'web'::text]))),
    CONSTRAINT threads_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'closed'::text])))
);


--
-- Name: TABLE threads; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON TABLE manager_agent.threads IS 'One conversation per staff member per channel with the trial manager agent.';


--
-- Name: COLUMN threads.default_trial_id; Type: COMMENT; Schema: manager_agent; Owner: -
--

COMMENT ON COLUMN manager_agent.threads.default_trial_id IS 'Trial assumed when the manager doesn''t name one ("how''s enrollment?").';


--
-- Name: memories; Type: TABLE; Schema: patient_agent; Owner: -
--

CREATE TABLE patient_agent.memories (
    id uuid DEFAULT uuidv7() NOT NULL,
    participant_id uuid NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    importance smallint DEFAULT 3 NOT NULL,
    source_message_id uuid,
    covers_from timestamp with time zone,
    covers_to timestamp with time zone,
    embedding public.vector,
    embedding_model text,
    superseded_by uuid,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memories_check CHECK (((embedding IS NULL) = (embedding_model IS NULL))),
    CONSTRAINT memories_check1 CHECK (((covers_to IS NULL) OR (covers_from IS NULL) OR (covers_to >= covers_from))),
    CONSTRAINT memories_importance_check CHECK (((importance >= 1) AND (importance <= 5))),
    CONSTRAINT memories_kind_check CHECK ((kind = ANY (ARRAY['fact'::text, 'preference'::text, 'concern'::text, 'goal'::text, 'routine'::text, 'relationship'::text, 'instruction'::text, 'summary'::text])))
);


--
-- Name: TABLE memories; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON TABLE patient_agent.memories IS 'Long-term memory about one patient, written by the agent: facts, preferences, concerns, routines, and rolling conversation summaries (kind = summary). Retrieved into the prompt on each turn.';


--
-- Name: COLUMN memories.importance; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.memories.importance IS '1 (trivia) to 5 (always include in the prompt).';


--
-- Name: COLUMN memories.covers_from; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.memories.covers_from IS 'For summaries: the span of conversation the summary covers.';


--
-- Name: COLUMN memories.embedding; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.memories.embedding IS 'Optional pgvector embedding of content for semantic recall. Dimension depends on embedding_model; compare only rows with the same model.';


--
-- Name: COLUMN memories.superseded_by; Type: COMMENT; Schema: patient_agent; Owner: -
--

COMMENT ON COLUMN patient_agent.memories.superseded_by IS 'Set when a newer memory replaces this one; current memories have superseded_by is null.';


--
-- Name: agent_profiles; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.agent_profiles (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    audience text NOT NULL,
    name text NOT NULL,
    model text DEFAULT 'claude-haiku-5-5'::text NOT NULL,
    system_prompt text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_profiles_audience_check CHECK ((audience = ANY (ARRAY['patient'::text, 'manager'::text])))
);


--
-- Name: TABLE agent_profiles; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.agent_profiles IS 'How each trial''s agents behave: persona and instructions for the patient agent and the manager agent. One active profile per trial and audience; keep old versions for audit.';


--
-- Name: COLUMN agent_profiles.settings; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.agent_profiles.settings IS 'Behavior knobs, for example {"quiet_hours": ["21:30", "08:00"], "escalate_ae_grade": 3}.';


--
-- Name: collection_plans; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.collection_plans (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    measure_id uuid NOT NULL,
    frequency text NOT NULL,
    local_time time without time zone,
    days_of_week smallint[],
    schedule_event_id uuid,
    prompt text NOT NULL,
    follow_up_prompt text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT collection_plans_check CHECK (((frequency <> 'weekly'::text) OR (days_of_week IS NOT NULL))),
    CONSTRAINT collection_plans_check1 CHECK (((frequency <> 'per_visit'::text) OR (schedule_event_id IS NOT NULL))),
    CONSTRAINT collection_plans_days_of_week_check CHECK ((days_of_week <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint, (7)::smallint])),
    CONSTRAINT collection_plans_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'per_visit'::text, 'once'::text, 'as_needed'::text])))
);


--
-- Name: TABLE collection_plans; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.collection_plans IS 'What the patient agent asks, and when: one row per measure and cadence. The scheduler turns these into patient_agent.check_ins.';


--
-- Name: COLUMN collection_plans.local_time; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.collection_plans.local_time IS 'Time of day to ask, in the participant''s time zone (core.people.timezone).';


--
-- Name: COLUMN collection_plans.days_of_week; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.collection_plans.days_of_week IS 'ISO weekdays for weekly plans (1 = Monday ... 7 = Sunday).';


--
-- Name: COLUMN collection_plans.prompt; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.collection_plans.prompt IS 'Suggested wording. The agent may rephrase it in its own voice; {first_name} is filled in.';


--
-- Name: eligibility_criteria; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.eligibility_criteria (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    kind text NOT NULL,
    "position" smallint NOT NULL,
    description text NOT NULL,
    rule jsonb,
    CONSTRAINT eligibility_criteria_kind_check CHECK ((kind = ANY (ARRAY['inclusion'::text, 'exclusion'::text])))
);


--
-- Name: TABLE eligibility_criteria; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.eligibility_criteria IS 'Inclusion and exclusion criteria, in protocol order. Useful for screening conversations.';


--
-- Name: COLUMN eligibility_criteria.rule; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.eligibility_criteria.rule IS 'Optional machine-readable version, for example {"measure": "age", "min": 18, "max": 65}.';


--
-- Name: schedule_events; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.schedule_events (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    day_offset integer NOT NULL,
    window_before_days integer DEFAULT 0 NOT NULL,
    window_after_days integer DEFAULT 0 NOT NULL,
    description text,
    CONSTRAINT schedule_events_window_after_days_check CHECK ((window_after_days >= 0)),
    CONSTRAINT schedule_events_window_before_days_check CHECK ((window_before_days >= 0))
);


--
-- Name: TABLE schedule_events; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.schedule_events IS 'The protocol''s visit schedule (schedule of assessments): baseline, week 2, week 4... clinical.visits tracks each participant''s actual visits.';


--
-- Name: COLUMN schedule_events.day_offset; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.schedule_events.day_offset IS 'Study day relative to enrollment (0 = baseline; negative = screening).';


--
-- Name: staff; Type: TABLE; Schema: trial; Owner: -
--

CREATE TABLE trial.staff (
    id uuid DEFAULT uuidv7() NOT NULL,
    trial_id uuid NOT NULL,
    person_id uuid NOT NULL,
    role text NOT NULL,
    receives_alerts boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_role_check CHECK ((role = ANY (ARRAY['manager'::text, 'investigator'::text, 'coordinator'::text, 'monitor'::text, 'data_manager'::text])))
);


--
-- Name: TABLE staff; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON TABLE trial.staff IS 'Links a person to a trial in a staff role. The trial manager agent serves people in this table and limits them to their own trials.';


--
-- Name: COLUMN staff.receives_alerts; Type: COMMENT; Schema: trial; Owner: -
--

COMMENT ON COLUMN trial.staff.receives_alerts IS 'Whether manager_agent.alerts for this trial are texted to this person.';


--
-- Name: adverse_events adverse_events_pkey; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.adverse_events
    ADD CONSTRAINT adverse_events_pkey PRIMARY KEY (id);


--
-- Name: data_sources data_sources_code_key; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.data_sources
    ADD CONSTRAINT data_sources_code_key UNIQUE (code);


--
-- Name: data_sources data_sources_pkey; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.data_sources
    ADD CONSTRAINT data_sources_pkey PRIMARY KEY (id);


--
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: visits visits_participant_id_schedule_event_id_key; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.visits
    ADD CONSTRAINT visits_participant_id_schedule_event_id_key UNIQUE (participant_id, schedule_event_id);


--
-- Name: visits visits_pkey; Type: CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.visits
    ADD CONSTRAINT visits_pkey PRIMARY KEY (id);


--
-- Name: people people_phone_e164_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.people
    ADD CONSTRAINT people_phone_e164_key UNIQUE (phone_e164);


--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: analyses analyses_pkey; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.analyses
    ADD CONSTRAINT analyses_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: messages messages_external_id_key; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.messages
    ADD CONSTRAINT messages_external_id_key UNIQUE (external_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: threads threads_id_person_id_key; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.threads
    ADD CONSTRAINT threads_id_person_id_key UNIQUE (id, person_id);


--
-- Name: threads threads_person_id_channel_key; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.threads
    ADD CONSTRAINT threads_person_id_channel_key UNIQUE (person_id, channel);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: check_ins check_ins_participant_id_collection_plan_id_scheduled_for_key; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.check_ins
    ADD CONSTRAINT check_ins_participant_id_collection_plan_id_scheduled_for_key UNIQUE (participant_id, collection_plan_id, scheduled_for);


--
-- Name: check_ins check_ins_pkey; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.check_ins
    ADD CONSTRAINT check_ins_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: messages messages_external_id_key; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.messages
    ADD CONSTRAINT messages_external_id_key UNIQUE (external_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: threads threads_id_participant_id_key; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.threads
    ADD CONSTRAINT threads_id_participant_id_key UNIQUE (id, participant_id);


--
-- Name: threads threads_participant_id_channel_key; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.threads
    ADD CONSTRAINT threads_participant_id_channel_key UNIQUE (participant_id, channel);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: agent_profiles agent_profiles_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.agent_profiles
    ADD CONSTRAINT agent_profiles_pkey PRIMARY KEY (id);


--
-- Name: arms arms_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.arms
    ADD CONSTRAINT arms_pkey PRIMARY KEY (id);


--
-- Name: arms arms_trial_id_code_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.arms
    ADD CONSTRAINT arms_trial_id_code_key UNIQUE (trial_id, code);


--
-- Name: arms arms_trial_id_id_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.arms
    ADD CONSTRAINT arms_trial_id_id_key UNIQUE (trial_id, id);


--
-- Name: collection_plans collection_plans_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.collection_plans
    ADD CONSTRAINT collection_plans_pkey PRIMARY KEY (id);


--
-- Name: eligibility_criteria eligibility_criteria_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.eligibility_criteria
    ADD CONSTRAINT eligibility_criteria_pkey PRIMARY KEY (id);


--
-- Name: eligibility_criteria eligibility_criteria_trial_id_kind_position_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.eligibility_criteria
    ADD CONSTRAINT eligibility_criteria_trial_id_kind_position_key UNIQUE (trial_id, kind, "position");


--
-- Name: measures measures_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.measures
    ADD CONSTRAINT measures_pkey PRIMARY KEY (id);


--
-- Name: measures measures_trial_id_code_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.measures
    ADD CONSTRAINT measures_trial_id_code_key UNIQUE (trial_id, code);


--
-- Name: measures measures_trial_id_id_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.measures
    ADD CONSTRAINT measures_trial_id_id_key UNIQUE (trial_id, id);


--
-- Name: participants participants_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (id);


--
-- Name: participants participants_trial_id_id_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_trial_id_id_key UNIQUE (trial_id, id);


--
-- Name: participants participants_trial_id_person_id_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_trial_id_person_id_key UNIQUE (trial_id, person_id);


--
-- Name: participants participants_trial_id_subject_code_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_trial_id_subject_code_key UNIQUE (trial_id, subject_code);


--
-- Name: schedule_events schedule_events_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.schedule_events
    ADD CONSTRAINT schedule_events_pkey PRIMARY KEY (id);


--
-- Name: schedule_events schedule_events_trial_id_code_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.schedule_events
    ADD CONSTRAINT schedule_events_trial_id_code_key UNIQUE (trial_id, code);


--
-- Name: schedule_events schedule_events_trial_id_id_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.schedule_events
    ADD CONSTRAINT schedule_events_trial_id_id_key UNIQUE (trial_id, id);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: sites sites_trial_id_code_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.sites
    ADD CONSTRAINT sites_trial_id_code_key UNIQUE (trial_id, code);


--
-- Name: sites sites_trial_id_id_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.sites
    ADD CONSTRAINT sites_trial_id_id_key UNIQUE (trial_id, id);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);


--
-- Name: staff staff_trial_id_person_id_role_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.staff
    ADD CONSTRAINT staff_trial_id_person_id_role_key UNIQUE (trial_id, person_id, role);


--
-- Name: trials trials_code_key; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.trials
    ADD CONSTRAINT trials_code_key UNIQUE (code);


--
-- Name: trials trials_pkey; Type: CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.trials
    ADD CONSTRAINT trials_pkey PRIMARY KEY (id);


--
-- Name: adverse_events_participant_id_idx; Type: INDEX; Schema: clinical; Owner: -
--

CREATE INDEX adverse_events_participant_id_idx ON clinical.adverse_events USING btree (participant_id);


--
-- Name: adverse_events_trial_id_status_idx; Type: INDEX; Schema: clinical; Owner: -
--

CREATE INDEX adverse_events_trial_id_status_idx ON clinical.adverse_events USING btree (trial_id, status);


--
-- Name: observations_participant_id_measure_id_observed_at_idx; Type: INDEX; Schema: clinical; Owner: -
--

CREATE INDEX observations_participant_id_measure_id_observed_at_idx ON clinical.observations USING btree (participant_id, measure_id, observed_at DESC);


--
-- Name: observations_source_id_idx; Type: INDEX; Schema: clinical; Owner: -
--

CREATE INDEX observations_source_id_idx ON clinical.observations USING btree (source_id);


--
-- Name: observations_trial_id_measure_id_observed_at_idx; Type: INDEX; Schema: clinical; Owner: -
--

CREATE INDEX observations_trial_id_measure_id_observed_at_idx ON clinical.observations USING btree (trial_id, measure_id, observed_at);


--
-- Name: people_email_key; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX people_email_key ON core.people USING btree (lower(email));


--
-- Name: alerts_trial_id_status_created_at_idx; Type: INDEX; Schema: manager_agent; Owner: -
--

CREATE INDEX alerts_trial_id_status_created_at_idx ON manager_agent.alerts USING btree (trial_id, status, created_at DESC);


--
-- Name: analyses_person_id_created_at_idx; Type: INDEX; Schema: manager_agent; Owner: -
--

CREATE INDEX analyses_person_id_created_at_idx ON manager_agent.analyses USING btree (person_id, created_at DESC);


--
-- Name: memories_person_id_kind_idx; Type: INDEX; Schema: manager_agent; Owner: -
--

CREATE INDEX memories_person_id_kind_idx ON manager_agent.memories USING btree (person_id, kind) WHERE (superseded_by IS NULL);


--
-- Name: messages_person_id_sent_at_idx; Type: INDEX; Schema: manager_agent; Owner: -
--

CREATE INDEX messages_person_id_sent_at_idx ON manager_agent.messages USING btree (person_id, sent_at DESC);


--
-- Name: messages_thread_id_sent_at_idx; Type: INDEX; Schema: manager_agent; Owner: -
--

CREATE INDEX messages_thread_id_sent_at_idx ON manager_agent.messages USING btree (thread_id, sent_at);


--
-- Name: threads_channel_handle_idx; Type: INDEX; Schema: manager_agent; Owner: -
--

CREATE INDEX threads_channel_handle_idx ON manager_agent.threads USING btree (channel, handle);


--
-- Name: check_ins_scheduled_for_idx; Type: INDEX; Schema: patient_agent; Owner: -
--

CREATE INDEX check_ins_scheduled_for_idx ON patient_agent.check_ins USING btree (scheduled_for) WHERE (status = ANY (ARRAY['scheduled'::text, 'sent'::text]));


--
-- Name: memories_participant_id_kind_idx; Type: INDEX; Schema: patient_agent; Owner: -
--

CREATE INDEX memories_participant_id_kind_idx ON patient_agent.memories USING btree (participant_id, kind) WHERE (superseded_by IS NULL);


--
-- Name: messages_participant_id_sent_at_idx; Type: INDEX; Schema: patient_agent; Owner: -
--

CREATE INDEX messages_participant_id_sent_at_idx ON patient_agent.messages USING btree (participant_id, sent_at DESC);


--
-- Name: messages_thread_id_sent_at_idx; Type: INDEX; Schema: patient_agent; Owner: -
--

CREATE INDEX messages_thread_id_sent_at_idx ON patient_agent.messages USING btree (thread_id, sent_at);


--
-- Name: threads_channel_handle_idx; Type: INDEX; Schema: patient_agent; Owner: -
--

CREATE INDEX threads_channel_handle_idx ON patient_agent.threads USING btree (channel, handle);


--
-- Name: agent_profiles_one_active; Type: INDEX; Schema: trial; Owner: -
--

CREATE UNIQUE INDEX agent_profiles_one_active ON trial.agent_profiles USING btree (trial_id, audience) WHERE is_active;


--
-- Name: collection_plans_trial_id_idx; Type: INDEX; Schema: trial; Owner: -
--

CREATE INDEX collection_plans_trial_id_idx ON trial.collection_plans USING btree (trial_id) WHERE is_active;


--
-- Name: participants_person_id_idx; Type: INDEX; Schema: trial; Owner: -
--

CREATE INDEX participants_person_id_idx ON trial.participants USING btree (person_id);


--
-- Name: staff_person_id_idx; Type: INDEX; Schema: trial; Owner: -
--

CREATE INDEX staff_person_id_idx ON trial.staff USING btree (person_id);


--
-- Name: check_in_adherence _RETURN; Type: RULE; Schema: analytics; Owner: -
--

CREATE OR REPLACE VIEW analytics.check_in_adherence AS
 SELECT p.trial_id,
    t.code AS trial_code,
    p.id AS participant_id,
    p.subject_code,
    a.code AS arm_code,
    (date_trunc('week'::text, (c.scheduled_for AT TIME ZONE t.timezone)))::date AS week_start,
    count(*) FILTER (WHERE (c.status = ANY (ARRAY['sent'::text, 'answered'::text, 'missed'::text]))) AS prompted,
    count(*) FILTER (WHERE (c.status = 'answered'::text)) AS answered,
    count(*) FILTER (WHERE (c.status = 'missed'::text)) AS missed,
    round(((count(*) FILTER (WHERE (c.status = 'answered'::text)))::numeric / (NULLIF(count(*) FILTER (WHERE (c.status = ANY (ARRAY['sent'::text, 'answered'::text, 'missed'::text]))), 0))::numeric), 2) AS response_rate
   FROM (((patient_agent.check_ins c
     JOIN trial.participants p ON ((p.id = c.participant_id)))
     JOIN trial.trials t ON ((t.id = p.trial_id)))
     LEFT JOIN trial.arms a ON ((a.id = p.arm_id)))
  WHERE analytics.visible_trial(p.trial_id)
  GROUP BY p.trial_id, t.id, p.id, a.code, ((date_trunc('week'::text, (c.scheduled_for AT TIME ZONE t.timezone)))::date);


--
-- Name: enrollment _RETURN; Type: RULE; Schema: analytics; Owner: -
--

CREATE OR REPLACE VIEW analytics.enrollment AS
 SELECT t.id AS trial_id,
    t.code AS trial_code,
    a.code AS arm_code,
    a.name AS arm_name,
    a.is_control,
    a.target_enrollment,
    count(p.id) FILTER (WHERE (p.status = ANY (ARRAY['enrolled'::text, 'active'::text, 'completed'::text]))) AS enrolled,
    count(p.id) FILTER (WHERE (p.status = 'active'::text)) AS active,
    count(p.id) FILTER (WHERE (p.status = 'completed'::text)) AS completed,
    count(p.id) FILTER (WHERE (p.status = 'withdrawn'::text)) AS withdrawn
   FROM ((trial.arms a
     JOIN trial.trials t ON ((t.id = a.trial_id)))
     LEFT JOIN trial.participants p ON ((p.arm_id = a.id)))
  WHERE analytics.visible_trial(t.id)
  GROUP BY t.id, a.id;


--
-- Name: trials _RETURN; Type: RULE; Schema: analytics; Owner: -
--

CREATE OR REPLACE VIEW analytics.trials AS
 SELECT t.id AS trial_id,
    t.code AS trial_code,
    t.title,
    t.phase,
    t.status,
    t.therapeutic_area,
    t.intervention,
    t.primary_endpoint,
    t.target_enrollment,
    t.start_date,
    t.end_date,
    count(p.id) FILTER (WHERE (p.status = ANY (ARRAY['enrolled'::text, 'active'::text, 'completed'::text]))) AS enrolled,
    count(p.id) FILTER (WHERE (p.status = 'active'::text)) AS active,
    count(p.id) FILTER (WHERE (p.status = 'withdrawn'::text)) AS withdrawn,
    count(p.id) FILTER (WHERE (p.status = 'screening'::text)) AS screening,
    ( SELECT count(*) AS count
           FROM clinical.adverse_events e
          WHERE ((e.trial_id = t.id) AND (e.status <> ALL (ARRAY['closed'::text, 'not_an_ae'::text])))) AS open_adverse_events,
    ( SELECT count(*) AS count
           FROM clinical.adverse_events e
          WHERE ((e.trial_id = t.id) AND e.is_serious)) AS serious_adverse_events,
    ( SELECT count(*) AS count
           FROM manager_agent.alerts a
          WHERE ((a.trial_id = t.id) AND (a.status = ANY (ARRAY['open'::text, 'sent'::text])))) AS open_alerts,
    ( SELECT count(*) AS count
           FROM clinical.observations o
          WHERE ((o.trial_id = t.id) AND (o.observed_at > (now() - '7 days'::interval)))) AS observations_7d,
    t.is_synthetic
   FROM (trial.trials t
     LEFT JOIN trial.participants p ON ((p.trial_id = t.id)))
  WHERE analytics.visible_trial(t.id)
  GROUP BY t.id;


--
-- Name: adverse_events alert_on_adverse_event; Type: TRIGGER; Schema: clinical; Owner: -
--

CREATE TRIGGER alert_on_adverse_event AFTER INSERT ON clinical.adverse_events FOR EACH ROW EXECUTE FUNCTION clinical.alert_on_adverse_event();


--
-- Name: adverse_events set_updated_at; Type: TRIGGER; Schema: clinical; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinical.adverse_events FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: observations set_updated_at; Type: TRIGGER; Schema: clinical; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinical.observations FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: visits set_updated_at; Type: TRIGGER; Schema: clinical; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinical.visits FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: people set_updated_at; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON core.people FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: memories set_updated_at; Type: TRIGGER; Schema: manager_agent; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON manager_agent.memories FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: threads set_updated_at; Type: TRIGGER; Schema: manager_agent; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON manager_agent.threads FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: check_ins set_updated_at; Type: TRIGGER; Schema: patient_agent; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON patient_agent.check_ins FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: memories set_updated_at; Type: TRIGGER; Schema: patient_agent; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON patient_agent.memories FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: threads set_updated_at; Type: TRIGGER; Schema: patient_agent; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON patient_agent.threads FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: agent_profiles set_updated_at; Type: TRIGGER; Schema: trial; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON trial.agent_profiles FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: collection_plans set_updated_at; Type: TRIGGER; Schema: trial; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON trial.collection_plans FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: measures set_updated_at; Type: TRIGGER; Schema: trial; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON trial.measures FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: participants set_updated_at; Type: TRIGGER; Schema: trial; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON trial.participants FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: trials set_updated_at; Type: TRIGGER; Schema: trial; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON trial.trials FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();


--
-- Name: adverse_events adverse_events_message_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.adverse_events
    ADD CONSTRAINT adverse_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES patient_agent.messages(id) ON DELETE SET NULL;


--
-- Name: adverse_events adverse_events_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.adverse_events
    ADD CONSTRAINT adverse_events_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES core.people(id);


--
-- Name: adverse_events adverse_events_source_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.adverse_events
    ADD CONSTRAINT adverse_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES clinical.data_sources(id);


--
-- Name: adverse_events adverse_events_trial_id_participant_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.adverse_events
    ADD CONSTRAINT adverse_events_trial_id_participant_id_fkey FOREIGN KEY (trial_id, participant_id) REFERENCES trial.participants(trial_id, id) ON DELETE CASCADE;


--
-- Name: import_batches import_batches_source_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.import_batches
    ADD CONSTRAINT import_batches_source_id_fkey FOREIGN KEY (source_id) REFERENCES clinical.data_sources(id);


--
-- Name: import_batches import_batches_trial_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.import_batches
    ADD CONSTRAINT import_batches_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: observations observations_check_in_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_check_in_id_fkey FOREIGN KEY (check_in_id) REFERENCES patient_agent.check_ins(id) ON DELETE SET NULL;


--
-- Name: observations observations_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES clinical.import_batches(id) ON DELETE CASCADE;


--
-- Name: observations observations_message_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_message_id_fkey FOREIGN KEY (message_id) REFERENCES patient_agent.messages(id) ON DELETE SET NULL;


--
-- Name: observations observations_source_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_source_id_fkey FOREIGN KEY (source_id) REFERENCES clinical.data_sources(id);


--
-- Name: observations observations_trial_id_measure_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_trial_id_measure_id_fkey FOREIGN KEY (trial_id, measure_id) REFERENCES trial.measures(trial_id, id) ON DELETE CASCADE;


--
-- Name: observations observations_trial_id_participant_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.observations
    ADD CONSTRAINT observations_trial_id_participant_id_fkey FOREIGN KEY (trial_id, participant_id) REFERENCES trial.participants(trial_id, id) ON DELETE CASCADE;


--
-- Name: visits visits_trial_id_participant_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.visits
    ADD CONSTRAINT visits_trial_id_participant_id_fkey FOREIGN KEY (trial_id, participant_id) REFERENCES trial.participants(trial_id, id) ON DELETE CASCADE;


--
-- Name: visits visits_trial_id_schedule_event_id_fkey; Type: FK CONSTRAINT; Schema: clinical; Owner: -
--

ALTER TABLE ONLY clinical.visits
    ADD CONSTRAINT visits_trial_id_schedule_event_id_fkey FOREIGN KEY (trial_id, schedule_event_id) REFERENCES trial.schedule_events(trial_id, id) ON DELETE CASCADE;


--
-- Name: alerts alerts_adverse_event_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_adverse_event_id_fkey FOREIGN KEY (adverse_event_id) REFERENCES clinical.adverse_events(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_delivered_message_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_delivered_message_id_fkey FOREIGN KEY (delivered_message_id) REFERENCES manager_agent.messages(id) ON DELETE SET NULL;


--
-- Name: alerts alerts_observation_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES clinical.observations(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_participant_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES trial.participants(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_recipient_person_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_recipient_person_id_fkey FOREIGN KEY (recipient_person_id) REFERENCES core.people(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_trial_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.alerts
    ADD CONSTRAINT alerts_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: analyses analyses_person_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.analyses
    ADD CONSTRAINT analyses_person_id_fkey FOREIGN KEY (person_id) REFERENCES core.people(id) ON DELETE CASCADE;


--
-- Name: analyses analyses_request_message_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.analyses
    ADD CONSTRAINT analyses_request_message_id_fkey FOREIGN KEY (request_message_id) REFERENCES manager_agent.messages(id) ON DELETE SET NULL;


--
-- Name: analyses analyses_response_message_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.analyses
    ADD CONSTRAINT analyses_response_message_id_fkey FOREIGN KEY (response_message_id) REFERENCES manager_agent.messages(id) ON DELETE SET NULL;


--
-- Name: analyses analyses_thread_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.analyses
    ADD CONSTRAINT analyses_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES manager_agent.threads(id) ON DELETE SET NULL;


--
-- Name: analyses analyses_trial_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.analyses
    ADD CONSTRAINT analyses_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: memories memories_person_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.memories
    ADD CONSTRAINT memories_person_id_fkey FOREIGN KEY (person_id) REFERENCES core.people(id) ON DELETE CASCADE;


--
-- Name: memories memories_source_message_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.memories
    ADD CONSTRAINT memories_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES manager_agent.messages(id) ON DELETE SET NULL;


--
-- Name: memories memories_superseded_by_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.memories
    ADD CONSTRAINT memories_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES manager_agent.memories(id) ON DELETE SET NULL;


--
-- Name: memories memories_trial_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.memories
    ADD CONSTRAINT memories_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: messages messages_thread_id_person_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.messages
    ADD CONSTRAINT messages_thread_id_person_id_fkey FOREIGN KEY (thread_id, person_id) REFERENCES manager_agent.threads(id, person_id) ON DELETE CASCADE;


--
-- Name: threads threads_default_trial_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.threads
    ADD CONSTRAINT threads_default_trial_id_fkey FOREIGN KEY (default_trial_id) REFERENCES trial.trials(id) ON DELETE SET NULL;


--
-- Name: threads threads_person_id_fkey; Type: FK CONSTRAINT; Schema: manager_agent; Owner: -
--

ALTER TABLE ONLY manager_agent.threads
    ADD CONSTRAINT threads_person_id_fkey FOREIGN KEY (person_id) REFERENCES core.people(id) ON DELETE CASCADE;


--
-- Name: check_ins check_ins_collection_plan_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.check_ins
    ADD CONSTRAINT check_ins_collection_plan_id_fkey FOREIGN KEY (collection_plan_id) REFERENCES trial.collection_plans(id) ON DELETE CASCADE;


--
-- Name: check_ins check_ins_participant_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.check_ins
    ADD CONSTRAINT check_ins_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES trial.participants(id) ON DELETE CASCADE;


--
-- Name: check_ins check_ins_prompt_message_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.check_ins
    ADD CONSTRAINT check_ins_prompt_message_id_fkey FOREIGN KEY (prompt_message_id) REFERENCES patient_agent.messages(id) ON DELETE SET NULL;


--
-- Name: check_ins check_ins_response_message_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.check_ins
    ADD CONSTRAINT check_ins_response_message_id_fkey FOREIGN KEY (response_message_id) REFERENCES patient_agent.messages(id) ON DELETE SET NULL;


--
-- Name: memories memories_participant_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.memories
    ADD CONSTRAINT memories_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES trial.participants(id) ON DELETE CASCADE;


--
-- Name: memories memories_source_message_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.memories
    ADD CONSTRAINT memories_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES patient_agent.messages(id) ON DELETE SET NULL;


--
-- Name: memories memories_superseded_by_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.memories
    ADD CONSTRAINT memories_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES patient_agent.memories(id) ON DELETE SET NULL;


--
-- Name: messages messages_thread_id_participant_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.messages
    ADD CONSTRAINT messages_thread_id_participant_id_fkey FOREIGN KEY (thread_id, participant_id) REFERENCES patient_agent.threads(id, participant_id) ON DELETE CASCADE;


--
-- Name: threads threads_participant_id_fkey; Type: FK CONSTRAINT; Schema: patient_agent; Owner: -
--

ALTER TABLE ONLY patient_agent.threads
    ADD CONSTRAINT threads_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES trial.participants(id) ON DELETE CASCADE;


--
-- Name: agent_profiles agent_profiles_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.agent_profiles
    ADD CONSTRAINT agent_profiles_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: arms arms_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.arms
    ADD CONSTRAINT arms_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: collection_plans collection_plans_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.collection_plans
    ADD CONSTRAINT collection_plans_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: collection_plans collection_plans_trial_id_measure_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.collection_plans
    ADD CONSTRAINT collection_plans_trial_id_measure_id_fkey FOREIGN KEY (trial_id, measure_id) REFERENCES trial.measures(trial_id, id) ON DELETE CASCADE;


--
-- Name: collection_plans collection_plans_trial_id_schedule_event_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.collection_plans
    ADD CONSTRAINT collection_plans_trial_id_schedule_event_id_fkey FOREIGN KEY (trial_id, schedule_event_id) REFERENCES trial.schedule_events(trial_id, id) ON DELETE CASCADE;


--
-- Name: eligibility_criteria eligibility_criteria_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.eligibility_criteria
    ADD CONSTRAINT eligibility_criteria_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: measures measures_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.measures
    ADD CONSTRAINT measures_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: participants participants_person_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_person_id_fkey FOREIGN KEY (person_id) REFERENCES core.people(id) ON DELETE RESTRICT;


--
-- Name: participants participants_trial_id_arm_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_trial_id_arm_id_fkey FOREIGN KEY (trial_id, arm_id) REFERENCES trial.arms(trial_id, id);


--
-- Name: participants participants_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: participants participants_trial_id_site_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.participants
    ADD CONSTRAINT participants_trial_id_site_id_fkey FOREIGN KEY (trial_id, site_id) REFERENCES trial.sites(trial_id, id);


--
-- Name: schedule_events schedule_events_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.schedule_events
    ADD CONSTRAINT schedule_events_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: sites sites_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.sites
    ADD CONSTRAINT sites_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: staff staff_person_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.staff
    ADD CONSTRAINT staff_person_id_fkey FOREIGN KEY (person_id) REFERENCES core.people(id) ON DELETE CASCADE;


--
-- Name: staff staff_trial_id_fkey; Type: FK CONSTRAINT; Schema: trial; Owner: -
--

ALTER TABLE ONLY trial.staff
    ADD CONSTRAINT staff_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES trial.trials(id) ON DELETE CASCADE;


--
-- Name: adverse_events; Type: ROW SECURITY; Schema: clinical; Owner: -
--

ALTER TABLE clinical.adverse_events ENABLE ROW LEVEL SECURITY;

--
-- Name: observations; Type: ROW SECURITY; Schema: clinical; Owner: -
--

ALTER TABLE clinical.observations ENABLE ROW LEVEL SECURITY;

--
-- Name: adverse_events patient_agent_own; Type: POLICY; Schema: clinical; Owner: -
--

CREATE POLICY patient_agent_own ON clinical.adverse_events TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: observations patient_agent_own; Type: POLICY; Schema: clinical; Owner: -
--

CREATE POLICY patient_agent_own ON clinical.observations TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: visits patient_agent_own; Type: POLICY; Schema: clinical; Owner: -
--

CREATE POLICY patient_agent_own ON clinical.visits TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: visits; Type: ROW SECURITY; Schema: clinical; Owner: -
--

ALTER TABLE clinical.visits ENABLE ROW LEVEL SECURITY;

--
-- Name: people patient_agent_self; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY patient_agent_self ON core.people FOR SELECT TO patient_agent USING ((id = ( SELECT participants.person_id
   FROM trial.participants
  WHERE (participants.id = patient_agent.current_participant_id()))));


--
-- Name: people; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.people ENABLE ROW LEVEL SECURITY;

--
-- Name: alerts; Type: ROW SECURITY; Schema: manager_agent; Owner: -
--

ALTER TABLE manager_agent.alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: analyses; Type: ROW SECURITY; Schema: manager_agent; Owner: -
--

ALTER TABLE manager_agent.analyses ENABLE ROW LEVEL SECURITY;

--
-- Name: analyses manager_agent_own; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY manager_agent_own ON manager_agent.analyses TO manager_agent USING ((person_id = manager_agent.current_staff_id())) WITH CHECK ((person_id = manager_agent.current_staff_id()));


--
-- Name: memories manager_agent_own; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY manager_agent_own ON manager_agent.memories TO manager_agent USING ((person_id = manager_agent.current_staff_id())) WITH CHECK ((person_id = manager_agent.current_staff_id()));


--
-- Name: messages manager_agent_own; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY manager_agent_own ON manager_agent.messages TO manager_agent USING ((person_id = manager_agent.current_staff_id())) WITH CHECK ((person_id = manager_agent.current_staff_id()));


--
-- Name: threads manager_agent_own; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY manager_agent_own ON manager_agent.threads TO manager_agent USING ((person_id = manager_agent.current_staff_id())) WITH CHECK ((person_id = manager_agent.current_staff_id()));


--
-- Name: alerts manager_agent_read; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY manager_agent_read ON manager_agent.alerts FOR SELECT TO manager_agent USING ((trial_id = ANY (manager_agent.my_trial_ids())));


--
-- Name: alerts manager_agent_update; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY manager_agent_update ON manager_agent.alerts FOR UPDATE TO manager_agent USING ((trial_id = ANY (manager_agent.my_trial_ids()))) WITH CHECK ((trial_id = ANY (manager_agent.my_trial_ids())));


--
-- Name: memories; Type: ROW SECURITY; Schema: manager_agent; Owner: -
--

ALTER TABLE manager_agent.memories ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: manager_agent; Owner: -
--

ALTER TABLE manager_agent.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: alerts patient_agent_raise; Type: POLICY; Schema: manager_agent; Owner: -
--

CREATE POLICY patient_agent_raise ON manager_agent.alerts FOR INSERT TO patient_agent WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: threads; Type: ROW SECURITY; Schema: manager_agent; Owner: -
--

ALTER TABLE manager_agent.threads ENABLE ROW LEVEL SECURITY;

--
-- Name: check_ins; Type: ROW SECURITY; Schema: patient_agent; Owner: -
--

ALTER TABLE patient_agent.check_ins ENABLE ROW LEVEL SECURITY;

--
-- Name: memories; Type: ROW SECURITY; Schema: patient_agent; Owner: -
--

ALTER TABLE patient_agent.memories ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: patient_agent; Owner: -
--

ALTER TABLE patient_agent.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: check_ins patient_agent_own; Type: POLICY; Schema: patient_agent; Owner: -
--

CREATE POLICY patient_agent_own ON patient_agent.check_ins TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: memories patient_agent_own; Type: POLICY; Schema: patient_agent; Owner: -
--

CREATE POLICY patient_agent_own ON patient_agent.memories TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: messages patient_agent_own; Type: POLICY; Schema: patient_agent; Owner: -
--

CREATE POLICY patient_agent_own ON patient_agent.messages TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: threads patient_agent_own; Type: POLICY; Schema: patient_agent; Owner: -
--

CREATE POLICY patient_agent_own ON patient_agent.threads TO patient_agent USING ((participant_id = patient_agent.current_participant_id())) WITH CHECK ((participant_id = patient_agent.current_participant_id()));


--
-- Name: threads; Type: ROW SECURITY; Schema: patient_agent; Owner: -
--

ALTER TABLE patient_agent.threads ENABLE ROW LEVEL SECURITY;

--
-- Name: participants; Type: ROW SECURITY; Schema: trial; Owner: -
--

ALTER TABLE trial.participants ENABLE ROW LEVEL SECURITY;

--
-- Name: participants patient_agent_self; Type: POLICY; Schema: trial; Owner: -
--

CREATE POLICY patient_agent_self ON trial.participants FOR SELECT TO patient_agent USING ((id = patient_agent.current_participant_id()));


--
-- PostgreSQL database dump complete
--


