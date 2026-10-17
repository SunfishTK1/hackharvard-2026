-- DESTRUCTIVE, one-time migration from the original clinical-trials demo.
-- Back up first. Run with psql -X -v ON_ERROR_STOP=1 as postgres.
-- DDL and the replacement are atomic: any error rolls everything back.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('trial.trials') IS NULL
     OR to_regclass('public.studies') IS NOT NULL THEN
    RAISE EXCEPTION 'Expected the original demo schema. Refusing to reset a different or migrated database.';
  END IF;
END $$;

DROP SCHEMA analytics, clinical, core, manager_agent, patient_agent, trial CASCADE;
DROP TABLE public.schema_migrations;
-- Keep installed extensions, database settings, login roles, and passwords.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
CREATE SCHEMA private AUTHORIZATION app_owner;
CREATE SCHEMA audit AUTHORIZATION app_owner;
CREATE SCHEMA analytics AUTHORIZATION app_owner;
SET LOCAL ROLE app_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE private.staff_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.studies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_code TEXT UNIQUE NOT NULL CHECK (btrim(study_code) <> ''),
  title TEXT NOT NULL,
  condition TEXT,
  phase TEXT,
  study_type TEXT,
  design TEXT,
  intervention TEXT,
  sponsor TEXT,
  protocol_id TEXT,
  protocol_version TEXT,
  target_enrollment INTEGER CHECK (target_enrollment > 0),
  duration_weeks INTEGER CHECK (duration_weeks > 0),
  primary_outcome TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','approved','active','paused','closed')),
  approved_by UUID REFERENCES private.staff_users(id),
  approved_at TIMESTAMPTZ,
  is_synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved','active','paused','closed')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE public.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  site_code TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  city TEXT,
  state TEXT,
  country TEXT NOT NULL DEFAULT 'US',
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','active','paused','closed')),
  principal_investigator TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (study_id, site_code),
  UNIQUE (study_id, id)
);

CREATE TABLE public.study_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  site_id UUID,
  staff_user_id UUID NOT NULL REFERENCES private.staff_users(id),
  role TEXT NOT NULL CHECK (role IN ('trial_manager','principal_investigator','coordinator','analyst')),
  receives_alerts BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, site_id) REFERENCES public.sites(study_id, id),
  UNIQUE NULLS NOT DISTINCT (study_id, site_id, staff_user_id, role),
  UNIQUE (study_id, id)
);

CREATE TABLE public.study_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  site_id UUID,
  document_type TEXT NOT NULL CHECK (document_type IN
    ('protocol','icf','schedule_of_activities','epro','crf','site_roster','participant_roster','other')),
  version TEXT NOT NULL,
  file_name TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  sha256 TEXT CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  review_status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (review_status IN ('pending_review','approved','rejected','superseded')),
  uploaded_by UUID REFERENCES private.staff_users(id),
  reviewed_by UUID REFERENCES private.staff_users(id),
  reviewed_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, site_id) REFERENCES public.sites(study_id, id),
  UNIQUE NULLS NOT DISTINCT (study_id, site_id, document_type, version),
  UNIQUE (study_id, id),
  CHECK (NOT is_current OR review_status = 'approved'),
  CHECK (review_status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX study_documents_one_current
  ON public.study_documents(study_id, site_id, document_type) NULLS NOT DISTINCT
  WHERE is_current;

CREATE TABLE public.document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  source_document_id UUID NOT NULL,
  extractor TEXT NOT NULL,
  proposed_data JSONB NOT NULL CHECK (jsonb_typeof(proposed_data) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  reviewed_by UUID REFERENCES private.staff_users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, source_document_id) REFERENCES public.study_documents(study_id, id),
  CHECK (status = 'draft' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE public.study_arms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  arm_code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  intervention_name TEXT,
  dose TEXT,
  frequency TEXT,
  is_control BOOLEAN NOT NULL DEFAULT FALSE,
  allocation_ratio NUMERIC CHECK (allocation_ratio > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (study_id, arm_code),
  UNIQUE (study_id, id)
);

CREATE TABLE public.eligibility_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  source_document_id UUID,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('inclusion','exclusion')),
  description TEXT NOT NULL,
  field_name TEXT,
  operator TEXT,
  rule_value JSONB,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  FOREIGN KEY (study_id, source_document_id) REFERENCES public.study_documents(study_id, id)
);

CREATE TABLE public.consent_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  site_id UUID,
  source_document_id UUID NOT NULL,
  document_name TEXT NOT NULL,
  version TEXT NOT NULL,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_on DATE,
  requires_reconsent BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, site_id) REFERENCES public.sites(study_id, id),
  FOREIGN KEY (study_id, source_document_id) REFERENCES public.study_documents(study_id, id),
  UNIQUE NULLS NOT DISTINCT (study_id, site_id, version),
  UNIQUE (study_id, id),
  CHECK (expires_on IS NULL OR expires_on >= effective_date)
);
CREATE UNIQUE INDEX consent_documents_one_active
  ON public.consent_documents(study_id, site_id) NULLS NOT DISTINCT WHERE is_active;

CREATE TABLE public.participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  site_id UUID NOT NULL,
  participant_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'consent_pending' CHECK (status IN
    ('consent_pending','consented','enrolled','active','completed','withdrawn','screen_failed')),
  eligibility_status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (eligibility_status IN ('pending_review','eligible','ineligible','needs_review')),
  assigned_arm_id UUID,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  enrollment_confirmed_by UUID REFERENCES private.staff_users(id),
  status_changed_by UUID REFERENCES private.staff_users(id),
  enrolled_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  is_synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, site_id) REFERENCES public.sites(study_id, id),
  FOREIGN KEY (study_id, assigned_arm_id) REFERENCES public.study_arms(study_id, id),
  UNIQUE (study_id, participant_code),
  UNIQUE (study_id, id),
  UNIQUE (study_id, site_id, id),
  CHECK (status NOT IN ('enrolled','active','completed')
    OR (enrolled_at IS NOT NULL AND enrollment_confirmed_by IS NOT NULL)),
  CHECK (status NOT IN ('active','completed') OR activated_at IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL),
  CHECK (status NOT IN ('consent_pending','consented','screen_failed')
    OR num_nonnulls(enrolled_at,activated_at,enrollment_confirmed_by)=0),
  CHECK (completed_at IS NULL OR status='completed'),
  CHECK (withdrawn_at IS NULL OR status='withdrawn'),
  CHECK (activated_at IS NULL OR (enrolled_at IS NOT NULL AND activated_at >= enrolled_at)),
  CHECK (completed_at IS NULL OR (activated_at IS NOT NULL AND completed_at >= activated_at)),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= coalesce(activated_at,enrolled_at,created_at))
);

CREATE TABLE private.participant_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID UNIQUE NOT NULL,
  preferred_name TEXT,
  phone_number TEXT,
  email TEXT,
  secure_handle TEXT,
  preferred_channel TEXT NOT NULL DEFAULT 'secure_message'
    CHECK (preferred_channel IN ('sms','email','secure_message')),
  messaging_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  opted_in_at TIMESTAMPTZ,
  opted_out_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  CHECK (NOT messaging_opt_in OR (opted_in_at IS NOT NULL AND opted_out_at IS NULL)),
  CHECK (NOT messaging_opt_in OR CASE preferred_channel
    WHEN 'sms' THEN nullif(btrim(phone_number),'') IS NOT NULL
    WHEN 'email' THEN nullif(btrim(email),'') IS NOT NULL
    ELSE nullif(btrim(secure_handle),'') IS NOT NULL END)
);

CREATE TABLE public.participant_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  consent_document_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','opened','signed','declined','revoked')),
  presented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  signed_by TEXT,
  person_obtaining_consent_id UUID REFERENCES private.staff_users(id),
  copy_provided_at TIMESTAMPTZ,
  audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  FOREIGN KEY (study_id, consent_document_id) REFERENCES public.consent_documents(study_id, id),
  UNIQUE (participant_id, consent_document_id),
  CHECK (status <> 'opened' OR opened_at IS NOT NULL),
  CHECK (status NOT IN ('signed','revoked') OR (signed_at IS NOT NULL AND nullif(btrim(signed_by),'') IS NOT NULL)),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (status <> 'declined' OR declined_at IS NOT NULL),
  CHECK (opened_at IS NULL OR opened_at >= presented_at),
  CHECK (signed_at IS NULL OR signed_at >= coalesce(opened_at,presented_at)),
  CHECK (revoked_at IS NULL OR (signed_at IS NOT NULL AND revoked_at >= signed_at)),
  CHECK (copy_provided_at IS NULL OR (signed_at IS NOT NULL AND copy_provided_at >= signed_at))
);

CREATE TABLE public.measure_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  source_document_id UUID,
  measure_code TEXT NOT NULL,
  label TEXT NOT NULL,
  prompt TEXT,
  data_type TEXT NOT NULL CHECK (data_type IN ('numeric','integer','boolean','text','choice','json')),
  unit TEXT,
  min_value NUMERIC,
  max_value NUMERIC,
  choices JSONB,
  source_type TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, source_document_id) REFERENCES public.study_documents(study_id, id),
  UNIQUE (study_id, measure_code),
  UNIQUE (study_id, id),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CHECK (data_type <> 'choice' OR (choices IS NOT NULL AND jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) > 0))
);

CREATE TABLE public.assessment_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  measure_id UUID NOT NULL,
  schedule_code TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('once','daily','weekly','custom_days')),
  anchor_event TEXT NOT NULL DEFAULT 'activation' CHECK (anchor_event IN ('enrollment','activation')),
  start_day INTEGER NOT NULL DEFAULT 0 CHECK (start_day >= 0),
  end_day INTEGER CHECK (end_day >= start_day),
  times_of_day TIME[] NOT NULL DEFAULT ARRAY['09:00'::time],
  weekdays SMALLINT[],
  study_days INTEGER[],
  grace_period_minutes INTEGER NOT NULL DEFAULT 240 CHECK (grace_period_minutes >= 0),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, measure_id) REFERENCES public.measure_definitions(study_id, id),
  UNIQUE (study_id, schedule_code),
  UNIQUE (study_id, measure_id, id),
  CHECK (cardinality(times_of_day) > 0 AND array_position(times_of_day,NULL) IS NULL),
  CHECK (frequency <> 'weekly' OR (weekdays IS NOT NULL AND cardinality(weekdays) > 0)),
  CHECK (weekdays IS NULL OR (weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[] AND array_position(weekdays,NULL) IS NULL)),
  CHECK (frequency <> 'custom_days' OR (study_days IS NOT NULL AND cardinality(study_days) > 0)),
  CHECK (study_days IS NULL OR (0 <= ALL(study_days) AND array_position(study_days,NULL) IS NULL))
);

CREATE TABLE public.scheduled_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  measure_id UUID NOT NULL,
  schedule_id UUID,
  window_opens_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  window_closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','skipped','cancelled')),
  completed_at TIMESTAMPTZ,
  status_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  FOREIGN KEY (study_id, measure_id) REFERENCES public.measure_definitions(study_id, id),
  FOREIGN KEY (study_id, measure_id, schedule_id) REFERENCES public.assessment_schedules(study_id, measure_id, id),
  UNIQUE (participant_id, measure_id, due_at),
  UNIQUE (study_id, participant_id, id),
  UNIQUE (study_id, participant_id, measure_id, id),
  CHECK (window_opens_at <= due_at AND due_at <= window_closes_at),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status NOT IN ('skipped','cancelled') OR nullif(btrim(status_reason),'') IS NOT NULL)
);

CREATE TABLE public.message_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  provider TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','secure_message')),
  external_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  UNIQUE (provider, channel, external_thread_id),
  UNIQUE (study_id, participant_id, id)
);

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  thread_id UUID,
  consent_document_id UUID,
  scheduled_assessment_id UUID,
  workflow_task_id UUID,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','secure_message')),
  provider TEXT NOT NULL DEFAULT 'internal',
  message_type TEXT NOT NULL CHECK (message_type IN
    ('consent_invitation','consent_reminder','welcome','assessment','assessment_reminder','visit_reminder','support')),
  body TEXT NOT NULL,
  external_message_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','queued','sending','sent','delivered','received','failed','cancelled')),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  FOREIGN KEY (study_id, consent_document_id) REFERENCES public.consent_documents(study_id, id),
  FOREIGN KEY (study_id, participant_id, thread_id) REFERENCES public.message_threads(study_id, participant_id, id),
  FOREIGN KEY (study_id, participant_id, scheduled_assessment_id) REFERENCES public.scheduled_assessments(study_id, participant_id, id),
  UNIQUE (provider, external_message_id),
  UNIQUE (study_id, idempotency_key),
  UNIQUE (study_id, participant_id, id),
  CHECK (direction <> 'inbound' OR (status = 'received' AND received_at IS NOT NULL)),
  CHECK (direction <> 'outbound' OR status <> 'received'),
  CHECK (status NOT IN ('sent','delivered') OR sent_at IS NOT NULL),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  CHECK (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at))
);

CREATE TABLE public.observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  measure_id UUID NOT NULL,
  scheduled_assessment_id UUID,
  source_type TEXT NOT NULL CHECK (source_type IN
    ('patient_message','questionnaire','device','site_visit','laboratory','import','app_event')),
  raw_value TEXT,
  source_payload JSONB,
  numeric_value NUMERIC CHECK (numeric_value NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  boolean_value BOOLEAN,
  text_value TEXT,
  json_value JSONB,
  unit TEXT,
  raw_message_id UUID,
  supersedes_observation_id UUID,
  parser_confidence NUMERIC CHECK (parser_confidence BETWEEN 0 AND 1),
  requires_review BOOLEAN NOT NULL DEFAULT FALSE,
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','accepted','rejected')),
  reviewed_by UUID REFERENCES private.staff_users(id),
  reviewed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  FOREIGN KEY (study_id, measure_id) REFERENCES public.measure_definitions(study_id, id),
  FOREIGN KEY (study_id, participant_id, measure_id, scheduled_assessment_id)
    REFERENCES public.scheduled_assessments(study_id, participant_id, measure_id, id),
  FOREIGN KEY (study_id, participant_id, raw_message_id) REFERENCES public.messages(study_id, participant_id, id),
  UNIQUE (study_id, participant_id, measure_id, id),
  UNIQUE (supersedes_observation_id),
  FOREIGN KEY (study_id, participant_id, measure_id, supersedes_observation_id)
    REFERENCES public.observations(study_id, participant_id, measure_id, id),
  CHECK (supersedes_observation_id IS DISTINCT FROM id),
  CHECK (num_nonnulls(numeric_value,boolean_value,text_value,json_value) = 1),
  CHECK (raw_value IS NOT NULL OR source_payload IS NOT NULL OR raw_message_id IS NOT NULL),
  CHECK (source_type <> 'patient_message' OR raw_message_id IS NOT NULL),
  CHECK (review_status = 'unreviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE public.participant_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  actor_staff_id UUID REFERENCES private.staff_users(id),
  database_actor TEXT NOT NULL DEFAULT session_user,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id)
);

CREATE TABLE public.alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  measure_id UUID,
  source_document_id UUID,
  rule_code TEXT NOT NULL,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN
    ('consent_overdue','missing_assessments','value_threshold','safety_review','custom')),
  condition JSONB NOT NULL CHECK (jsonb_typeof(condition) = 'object'),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  action_type TEXT NOT NULL CHECK (action_type IN ('remind','notify_staff','require_review')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID REFERENCES private.staff_users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, measure_id) REFERENCES public.measure_definitions(study_id, id),
  FOREIGN KEY (study_id, source_document_id) REFERENCES public.study_documents(study_id, id),
  UNIQUE (study_id, rule_code),
  UNIQUE (study_id, id),
  CHECK (NOT enabled OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (rule_type <> 'safety_review' OR action_type = 'require_review')
);

CREATE TABLE public.alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  rule_id UUID,
  assigned_site_id UUID NOT NULL,
  assigned_staff_id UUID,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  reason TEXT NOT NULL,
  recommended_action TEXT,
  deduplication_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by UUID REFERENCES private.staff_users(id),
  resolved_by UUID REFERENCES private.staff_users(id),
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  FOREIGN KEY (study_id, assigned_site_id, participant_id) REFERENCES public.participants(study_id, site_id, id),
  FOREIGN KEY (study_id, rule_id) REFERENCES public.alert_rules(study_id, id),
  FOREIGN KEY (study_id, assigned_staff_id) REFERENCES public.study_staff(study_id, id),
  UNIQUE (study_id, id),
  CHECK (status <> 'acknowledged' OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)),
  CHECK (status <> 'resolved' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_notes IS NOT NULL))
);
CREATE UNIQUE INDEX alerts_one_unresolved ON public.alerts(study_id, deduplication_key)
  WHERE status IN ('open','acknowledged');

CREATE TABLE public.workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id UUID NOT NULL REFERENCES public.studies(id),
  participant_id UUID,
  rule_id UUID,
  assigned_staff_id UUID,
  action_type TEXT NOT NULL CHECK (action_type IN
    ('send_consent','send_assessment','send_reminder','notify_staff','confirm_enrollment','review_safety')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  deduplication_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','waiting_review','running','completed','failed','cancelled')),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID REFERENCES private.staff_users(id),
  approved_at TIMESTAMPTZ,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  completed_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (study_id, participant_id) REFERENCES public.participants(study_id, id),
  FOREIGN KEY (study_id, rule_id) REFERENCES public.alert_rules(study_id, id),
  FOREIGN KEY (study_id, assigned_staff_id) REFERENCES public.study_staff(study_id, id),
  UNIQUE (study_id, deduplication_key),
  UNIQUE (study_id, participant_id, id),
  CHECK (action_type NOT IN ('confirm_enrollment','review_safety') OR requires_approval),
  CHECK (action_type NOT IN ('send_consent','send_assessment','send_reminder') OR participant_id IS NOT NULL),
  CHECK (NOT requires_approval OR status NOT IN ('running','completed')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (status <> 'running' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL AND attempts < max_attempts)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
ALTER TABLE public.messages ADD FOREIGN KEY (study_id, participant_id, workflow_task_id)
  REFERENCES public.workflow_tasks(study_id, participant_id, id);

CREATE TABLE audit.events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  study_id UUID,
  entity_schema TEXT NOT NULL,
  entity_table TEXT NOT NULL,
  entity_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  changed_columns TEXT[],
  database_actor TEXT NOT NULL,
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- All privileged writes go through a trusted backend. These helpers are not
-- authentication APIs and do not trust client-set participant/staff variables.
CREATE FUNCTION public.staff_authorized(p_study UUID, p_staff UUID, p_site UUID DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.study_staff s JOIN private.staff_users u ON u.id = s.staff_user_id
    WHERE s.study_id = p_study AND s.staff_user_id = p_staff AND s.is_active AND u.is_active
      AND s.role IN ('trial_manager','principal_investigator','coordinator')
      AND (s.site_id IS NULL OR s.site_id = p_site)
  )
$$;

CREATE FUNCTION public.current_consent_document(p_study UUID, p_participant UUID)
RETURNS UUID LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT d.id FROM public.participants p
  JOIN public.consent_documents d ON d.study_id=p.study_id AND (d.site_id IS NULL OR d.site_id=p.site_id)
  WHERE p.study_id=p_study AND p.id=p_participant AND d.is_active
  ORDER BY (d.site_id IS NOT NULL) DESC LIMIT 1
$$;

CREATE FUNCTION public.has_current_consent(p_study UUID, p_participant UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.participant_consents c
    JOIN public.consent_documents d ON d.id=c.consent_document_id
    JOIN public.study_documents source ON source.id = d.source_document_id
    WHERE c.study_id=p_study AND c.participant_id=p_participant AND c.status='signed'
      AND d.id=public.current_consent_document(p_study,p_participant)
      AND d.effective_date <= CURRENT_DATE
      AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)
      AND source.review_status = 'approved'
  )
$$;

CREATE FUNCTION public.validate_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE reviewer UUID; reviewed BOOLEAN; scope UUID;
BEGIN
  IF TG_TABLE_NAME = 'study_documents' THEN
    reviewer := NEW.reviewed_by; reviewed := NEW.review_status = 'approved'; scope := NEW.site_id;
    IF TG_OP = 'UPDATE' AND OLD.review_status IN ('approved','superseded')
      AND (NEW.study_id,NEW.site_id,NEW.document_type,NEW.version,NEW.storage_uri,NEW.sha256)
        IS DISTINCT FROM (OLD.study_id,OLD.site_id,OLD.document_type,OLD.version,OLD.storage_uri,OLD.sha256) THEN
      RAISE EXCEPTION 'Approved source documents are immutable; upload a new version' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'document_extractions' THEN
    reviewer := NEW.reviewed_by; reviewed := NEW.status <> 'draft';
    IF TG_OP = 'UPDATE' AND OLD.status = 'approved'
      AND (NEW.study_id,NEW.source_document_id,NEW.proposed_data,NEW.status)
        IS DISTINCT FROM (OLD.study_id,OLD.source_document_id,OLD.proposed_data,OLD.status) THEN
      RAISE EXCEPTION 'Approved extractions are immutable; create another extraction' USING ERRCODE = '23514';
    END IF;
  ELSE
    reviewer := NEW.approved_by; reviewed := NEW.enabled;
  END IF;
  IF reviewed AND NOT public.staff_authorized(NEW.study_id, reviewer, scope) THEN
    RAISE EXCEPTION 'Review requires authorized study/site staff' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_review BEFORE INSERT OR UPDATE ON public.study_documents
  FOR EACH ROW EXECUTE FUNCTION public.validate_review();
CREATE TRIGGER extraction_review BEFORE INSERT OR UPDATE ON public.document_extractions
  FOR EACH ROW EXECUTE FUNCTION public.validate_review();
CREATE TRIGGER alert_rule_review BEFORE INSERT OR UPDATE ON public.alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.validate_review();

CREATE FUNCTION public.validate_study_activation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status IN ('approved','active','paused','closed') THEN
    IF NOT public.staff_authorized(NEW.id, NEW.approved_by)
      OR NOT EXISTS (
        SELECT 1 FROM public.document_extractions e
        JOIN public.study_documents d ON d.id=e.source_document_id
        WHERE e.study_id=NEW.id AND e.status='approved'
          AND d.document_type='protocol' AND d.review_status='approved'
      ) THEN
      RAISE EXCEPTION 'Study activation requires staff approval and an approved protocol extraction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER study_activation BEFORE INSERT OR UPDATE ON public.studies
  FOR EACH ROW EXECUTE FUNCTION public.validate_study_activation();

CREATE FUNCTION public.validate_consent_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE source public.study_documents;
BEGIN
  SELECT * INTO source FROM public.study_documents WHERE id=NEW.source_document_id AND study_id=NEW.study_id;
  IF NOT FOUND OR source.document_type <> 'icf'
    OR source.site_id IS DISTINCT FROM NEW.site_id OR source.version <> NEW.version
    OR (NEW.is_active AND source.review_status <> 'approved') THEN
    RAISE EXCEPTION 'Consent must reference the matching study/site/version ICF; active ICFs require approval' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.study_id,NEW.site_id,NEW.source_document_id,NEW.version)
    IS DISTINCT FROM (OLD.study_id,OLD.site_id,OLD.source_document_id,OLD.version) THEN
    RAISE EXCEPTION 'Consent document identity is immutable; create a new version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_document_validation BEFORE INSERT OR UPDATE ON public.consent_documents
  FOR EACH ROW EXECUTE FUNCTION public.validate_consent_document();

CREATE FUNCTION public.validate_participant_consent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE participant_site UUID; document_site UUID;
BEGIN
  SELECT site_id INTO participant_site FROM public.participants WHERE study_id=NEW.study_id AND id=NEW.participant_id;
  SELECT site_id INTO document_site FROM public.consent_documents WHERE study_id=NEW.study_id AND id=NEW.consent_document_id;
  IF document_site IS NOT NULL AND document_site IS DISTINCT FROM participant_site THEN
    RAISE EXCEPTION 'Consent belongs to a different site' USING ERRCODE='23514';
  END IF;
  IF NEW.status='signed' AND (TG_OP='INSERT' OR OLD.status <> 'signed') AND NOT EXISTS (
    SELECT 1 FROM public.consent_documents d JOIN public.study_documents s ON s.id=d.source_document_id
    WHERE d.id=NEW.consent_document_id AND d.is_active AND s.review_status='approved'
      AND d.effective_date <= NEW.signed_at::date AND (d.expires_on IS NULL OR d.expires_on >= NEW.signed_at::date)
  ) THEN
    RAISE EXCEPTION 'Cannot sign an inactive, unapproved, or ineffective ICF' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.signed_at IS NOT NULL THEN
    IF (NEW.study_id,NEW.participant_id,NEW.consent_document_id,NEW.presented_at,NEW.opened_at,NEW.signed_at,NEW.signed_by)
      IS DISTINCT FROM (OLD.study_id,OLD.participant_id,OLD.consent_document_id,OLD.presented_at,OLD.opened_at,OLD.signed_at,OLD.signed_by)
      OR NEW.status NOT IN ('signed','revoked') OR (OLD.status='revoked' AND NEW.status <> 'revoked') THEN
      RAISE EXCEPTION 'Signed consent evidence cannot be rewritten' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participant_consent_validation BEFORE INSERT OR UPDATE ON public.participant_consents
  FOR EACH ROW EXECUTE FUNCTION public.validate_participant_consent();

CREATE FUNCTION public.validate_participant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'consent_pending' OR num_nonnulls(NEW.enrolled_at,NEW.activated_at,NEW.completed_at,NEW.withdrawn_at,NEW.enrollment_confirmed_by) > 0 THEN
      RAISE EXCEPTION 'New participants must start consent_pending without lifecycle milestones' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.study_id,NEW.site_id) IS DISTINCT FROM (OLD.id,OLD.study_id,OLD.site_id) THEN
      RAISE EXCEPTION 'Participant identity and site are immutable; site transfers need a reviewed workflow' USING ERRCODE='23514';
    END IF;
    IF OLD.enrolled_at IS NOT NULL AND (NEW.enrolled_at,NEW.enrollment_confirmed_by)
      IS DISTINCT FROM (OLD.enrolled_at,OLD.enrollment_confirmed_by) THEN
      RAISE EXCEPTION 'Enrollment confirmation is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (
        (OLD.status='consent_pending' AND NEW.status IN ('consented','withdrawn','screen_failed'))
        OR (OLD.status='consented' AND NEW.status IN ('enrolled','withdrawn','screen_failed'))
        OR (OLD.status='enrolled' AND NEW.status IN ('active','withdrawn'))
        OR (OLD.status='active' AND NEW.status IN ('completed','withdrawn'))
      ) THEN
        RAISE EXCEPTION 'Invalid participant transition: % -> %', OLD.status, NEW.status USING ERRCODE='23514';
      END IF;
      IF NEW.status IN ('consented','enrolled','active') AND NOT public.has_current_consent(NEW.study_id,NEW.id) THEN
        RAISE EXCEPTION 'Current, applicable signed consent is required' USING ERRCODE='23514';
      END IF;
      IF NEW.status IN ('enrolled','active') AND (
        NEW.eligibility_status <> 'eligible'
        OR NOT EXISTS (SELECT 1 FROM public.studies WHERE id=NEW.study_id AND status='active')
      ) THEN
        RAISE EXCEPTION 'Enrollment/activation requires eligibility and an active study' USING ERRCODE='23514';
      END IF;
      IF NEW.status='enrolled' AND NOT public.staff_authorized(NEW.study_id,NEW.enrollment_confirmed_by,NEW.site_id) THEN
        RAISE EXCEPTION 'Enrollment requires confirmation by authorized staff' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participant_validation BEFORE INSERT OR UPDATE ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.validate_participant();

CREATE FUNCTION public.validate_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown IANA time zone' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER site_timezone BEFORE INSERT OR UPDATE OF time_zone ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.validate_timezone();
CREATE TRIGGER participant_timezone BEFORE INSERT OR UPDATE OF time_zone ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.validate_timezone();

CREATE FUNCTION public.validate_outbound_message() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE p public.participants; contact private.participant_contacts;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.status IN ('sent','delivered','received') OR OLD.sent_at IS NOT NULL OR OLD.received_at IS NOT NULL) AND
    (NEW.study_id,NEW.participant_id,NEW.thread_id,NEW.consent_document_id,NEW.direction,NEW.channel,NEW.provider,NEW.message_type,NEW.body,NEW.external_message_id,NEW.sent_at,NEW.received_at)
      IS DISTINCT FROM (OLD.study_id,OLD.participant_id,OLD.thread_id,OLD.consent_document_id,OLD.direction,OLD.channel,OLD.provider,OLD.message_type,OLD.body,OLD.external_message_id,OLD.sent_at,OLD.received_at) THEN
    RAISE EXCEPTION 'Source message content and identity cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF NEW.direction='outbound' AND (
    NEW.status IN ('queued','sending','sent')
    OR (NEW.status='delivered' AND (TG_OP='INSERT' OR OLD.status NOT IN ('sent','delivered')))
  ) THEN
    SELECT * INTO p FROM public.participants WHERE study_id=NEW.study_id AND id=NEW.participant_id;
    SELECT * INTO contact FROM private.participant_contacts WHERE participant_id=NEW.participant_id;
    IF NOT coalesce(contact.messaging_opt_in,FALSE) OR contact.opted_out_at IS NOT NULL
      OR NOT coalesce(CASE NEW.channel WHEN 'sms' THEN nullif(btrim(contact.phone_number),'') IS NOT NULL
        WHEN 'email' THEN nullif(btrim(contact.email),'') IS NOT NULL
        ELSE nullif(btrim(contact.secure_handle),'') IS NOT NULL END,FALSE) THEN
      RAISE EXCEPTION 'Outbound messages require opt-in and a matching contact channel' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.studies WHERE id=NEW.study_id AND status='active')
      OR NOT EXISTS (SELECT 1 FROM public.sites WHERE id=p.site_id AND status='active') THEN
      RAISE EXCEPTION 'Outbound messages require an active study and site' USING ERRCODE='23514';
    END IF;
    IF NEW.message_type IN ('consent_invitation','consent_reminder') THEN
      IF p.status NOT IN ('consent_pending','consented','enrolled','active')
        OR public.has_current_consent(NEW.study_id,p.id)
        OR NEW.consent_document_id IS DISTINCT FROM public.current_consent_document(NEW.study_id,p.id)
        OR NEW.consent_document_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.consent_documents d JOIN public.study_documents s ON s.id=d.source_document_id
          WHERE d.id=NEW.consent_document_id AND s.review_status='approved'
            AND d.effective_date <= CURRENT_DATE AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)
        ) THEN
        RAISE EXCEPTION 'Consent invitations require an outstanding consent action' USING ERRCODE='23514';
      END IF;
    ELSIF p.status NOT IN ('enrolled','active') OR NOT public.has_current_consent(NEW.study_id,p.id) THEN
      RAISE EXCEPTION 'Study messages require enrollment and current signed consent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_message_validation BEFORE INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.validate_outbound_message();

CREATE FUNCTION public.validate_observation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE m public.measure_definitions; p public.participants;
BEGIN
  IF TG_OP='UPDATE' AND
    (NEW.study_id,NEW.participant_id,NEW.measure_id,NEW.scheduled_assessment_id,NEW.source_type,NEW.raw_value,NEW.source_payload,
     NEW.numeric_value,NEW.boolean_value,NEW.text_value,NEW.json_value,NEW.unit,NEW.raw_message_id,NEW.supersedes_observation_id,NEW.captured_at)
    IS DISTINCT FROM
    (OLD.study_id,OLD.participant_id,OLD.measure_id,OLD.scheduled_assessment_id,OLD.source_type,OLD.raw_value,OLD.source_payload,
     OLD.numeric_value,OLD.boolean_value,OLD.text_value,OLD.json_value,OLD.unit,OLD.raw_message_id,OLD.supersedes_observation_id,OLD.captured_at) THEN
    RAISE EXCEPTION 'Observation source and values are immutable; insert a superseding correction' USING ERRCODE='23514';
  END IF;
  SELECT * INTO m FROM public.measure_definitions WHERE study_id=NEW.study_id AND id=NEW.measure_id;
  SELECT * INTO p FROM public.participants WHERE study_id=NEW.study_id AND id=NEW.participant_id;
  IF TG_OP='INSERT' AND (p.status NOT IN ('enrolled','active') OR NOT public.has_current_consent(NEW.study_id,p.id)) THEN
    RAISE EXCEPTION 'Study observations require enrollment and current consent' USING ERRCODE='23514';
  END IF;
  IF NEW.supersedes_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.observations prior WHERE prior.id=NEW.supersedes_observation_id
      AND prior.scheduled_assessment_id IS NOT DISTINCT FROM NEW.scheduled_assessment_id
  ) THEN
    RAISE EXCEPTION 'A correction must refer to the same expected assessment' USING ERRCODE='23514';
  END IF;
  IF (m.data_type IN ('numeric','integer') AND NEW.numeric_value IS NULL)
    OR (m.data_type='boolean' AND NEW.boolean_value IS NULL)
    OR (m.data_type IN ('text','choice') AND NEW.text_value IS NULL)
    OR (m.data_type='json' AND (NEW.json_value IS NULL OR NEW.json_value='null'::jsonb))
    OR (m.data_type='integer' AND NEW.numeric_value <> trunc(NEW.numeric_value))
    OR (m.data_type='choice' AND NOT (m.choices ? NEW.text_value))
    OR NEW.unit IS DISTINCT FROM m.unit THEN
    RAISE EXCEPTION 'Observation value type/choice/unit does not match the measure' USING ERRCODE='23514';
  END IF;
  -- Preserve extreme values as safety signals instead of silently discarding them.
  IF NEW.numeric_value < m.min_value OR NEW.numeric_value > m.max_value THEN
    NEW.requires_review := TRUE;
  END IF;
  IF NEW.review_status <> 'unreviewed' AND NOT public.staff_authorized(NEW.study_id,NEW.reviewed_by,p.site_id) THEN
    RAISE EXCEPTION 'Observation review requires authorized staff' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_validation BEFORE INSERT OR UPDATE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public.validate_observation();

CREATE FUNCTION public.preserve_measure_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.measure_code,NEW.data_type,NEW.unit,NEW.min_value,NEW.max_value,NEW.choices)
    IS DISTINCT FROM (OLD.measure_code,OLD.data_type,OLD.unit,OLD.min_value,OLD.max_value,OLD.choices)
    AND (EXISTS (SELECT 1 FROM public.observations WHERE measure_id=OLD.id)
      OR EXISTS (SELECT 1 FROM public.scheduled_assessments WHERE measure_id=OLD.id)) THEN
    RAISE EXCEPTION 'An in-use measure definition is immutable; create a new measure version/code' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER measure_definition_retention BEFORE UPDATE ON public.measure_definitions
  FOR EACH ROW EXECUTE FUNCTION public.preserve_measure_definition();

CREATE FUNCTION public.validate_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE target_site UUID; approver UUID;
BEGIN
  IF TG_TABLE_NAME='alerts' THEN
    target_site:=NEW.assigned_site_id;
    IF NEW.status='acknowledged' THEN approver:=NEW.acknowledged_by;
    ELSIF NEW.status='resolved' THEN approver:=NEW.resolved_by; END IF;
  ELSE
    SELECT site_id INTO target_site FROM public.participants WHERE id=NEW.participant_id AND study_id=NEW.study_id;
    approver:=NEW.approved_by;
  END IF;
  IF NEW.assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.study_staff s JOIN private.staff_users u ON u.id=s.staff_user_id
    WHERE s.id=NEW.assigned_staff_id AND s.study_id=NEW.study_id AND s.is_active AND u.is_active
      AND (s.site_id IS NULL OR s.site_id=target_site) AND s.receives_alerts
  ) THEN
    RAISE EXCEPTION 'Assignee must be active staff for this study/site' USING ERRCODE='23514';
  END IF;
  IF approver IS NOT NULL AND NOT public.staff_authorized(NEW.study_id,approver,target_site) THEN
    RAISE EXCEPTION 'Approval/review requires authorized staff' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_assignment BEFORE INSERT OR UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.validate_assignment();
CREATE TRIGGER task_assignment BEFORE INSERT OR UPDATE ON public.workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION public.validate_assignment();

CREATE FUNCTION public.sync_assessment_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE first_response TIMESTAMPTZ;
BEGIN
  IF NEW.scheduled_assessment_id IS NOT NULL THEN
    -- Serialize responses/corrections for the same expected assessment.
    PERFORM 1 FROM public.scheduled_assessments WHERE id=NEW.scheduled_assessment_id FOR UPDATE;
    SELECT min(o.captured_at) INTO first_response FROM public.observations o
    WHERE o.scheduled_assessment_id=NEW.scheduled_assessment_id AND o.review_status <> 'rejected'
      AND NOT EXISTS (SELECT 1 FROM public.observations newer WHERE newer.supersedes_observation_id=o.id);
    UPDATE public.scheduled_assessments SET
      status=CASE WHEN first_response IS NULL THEN 'pending' ELSE 'completed' END,
      completed_at=first_response
    WHERE id=NEW.scheduled_assessment_id AND status IN ('pending','completed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_completion AFTER INSERT OR UPDATE OF review_status ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public.sync_assessment_completion();

CREATE FUNCTION public.validate_assessment_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status='completed' AND NOT EXISTS (
    SELECT 1 FROM public.observations o WHERE o.scheduled_assessment_id=NEW.id AND o.review_status <> 'rejected'
      AND NOT EXISTS (SELECT 1 FROM public.observations newer WHERE newer.supersedes_observation_id=o.id)
  ) THEN
    RAISE EXCEPTION 'Assessment completion requires a non-rejected source observation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_completion_validation BEFORE INSERT OR UPDATE ON public.scheduled_assessments
  FOR EACH ROW EXECUTE FUNCTION public.validate_assessment_completion();

CREATE FUNCTION public.record_participant_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO public.participant_events(study_id,participant_id,event_type,new_status,actor_staff_id)
      VALUES(NEW.study_id,NEW.id,'participant_created',NEW.status,NEW.status_changed_by);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.participant_events(study_id,participant_id,event_type,previous_status,new_status,actor_staff_id)
      VALUES(NEW.study_id,NEW.id,'status_changed',OLD.status,NEW.status,NEW.status_changed_by);
    IF NEW.status IN ('completed','withdrawn','screen_failed') THEN
      UPDATE public.scheduled_assessments SET status='cancelled',status_reason='participant_'||NEW.status
        WHERE participant_id=NEW.id AND status='pending';
      UPDATE public.workflow_tasks SET status='cancelled',locked_at=NULL,locked_by=NULL
        WHERE participant_id=NEW.id AND status IN ('pending','waiting_review');
      UPDATE public.messages SET status='cancelled'
        WHERE participant_id=NEW.id AND direction='outbound' AND status IN ('draft','queued');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participant_lifecycle_event AFTER INSERT OR UPDATE OF status ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.record_participant_event();

CREATE FUNCTION audit.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Append-only evidence cannot be updated, deleted, or truncated' USING ERRCODE='23514';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER participant_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.participant_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();
DO $$
DECLARE source_table TEXT;
BEGIN
  FOREACH source_table IN ARRAY ARRAY['study_documents','document_extractions','consent_documents','participant_consents','messages','observations']
  LOOP
    EXECUTE format('CREATE TRIGGER preserve_source_evidence BEFORE DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation()',source_table);
  END LOOP;
END $$;

CREATE FUNCTION audit.record_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE item JSONB; changed TEXT[];
BEGIN
  IF TG_OP='DELETE' THEN item:=to_jsonb(OLD); ELSE item:=to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key) INTO changed
      FROM jsonb_each(to_jsonb(NEW)) n WHERE n.value IS DISTINCT FROM to_jsonb(OLD)->n.key;
  END IF;
  -- Deliberately store identifiers and changed column names, not contact details,
  -- message bodies, source observations, or other sensitive before/after values.
  INSERT INTO audit.events(study_id,entity_schema,entity_table,entity_id,operation,changed_columns,database_actor,request_id)
    VALUES(coalesce((item->>'study_id')::uuid,CASE WHEN TG_TABLE_NAME='studies' THEN (item->>'id')::uuid END),
      TG_TABLE_SCHEMA,TG_TABLE_NAME,(item->>'id')::uuid,TG_OP,changed,session_user,
      nullif(current_setting('app.request_id',TRUE),''));
  RETURN NULL;
END $$;

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN NEW.updated_at:=clock_timestamp(); RETURN NEW; END $$;

CREATE FUNCTION public.preserve_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR to_jsonb(NEW)->'study_id' IS DISTINCT FROM to_jsonb(OLD)->'study_id' THEN
    RAISE EXCEPTION 'Record identity and study are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='study_staff' AND
    (to_jsonb(NEW)->'site_id',to_jsonb(NEW)->'staff_user_id',to_jsonb(NEW)->'role')
      IS DISTINCT FROM (to_jsonb(OLD)->'site_id',to_jsonb(OLD)->'staff_user_id',to_jsonb(OLD)->'role') THEN
    RAISE EXCEPTION 'Staff scope is immutable; deactivate and create another assignment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schemaname,tablename FROM pg_catalog.pg_tables
    WHERE schemaname IN ('public','private') AND tablename NOT IN ('schema_migrations','participant_events')
  LOOP
    EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change()',r.schemaname,r.tablename);
    EXECUTE format('CREATE TRIGGER preserve_identity BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.preserve_identity()',r.schemaname,r.tablename);
  END LOOP;
  FOR r IN SELECT table_schema,table_name FROM information_schema.columns
    WHERE table_schema IN ('public','private') AND column_name='updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',r.table_schema,r.table_name);
  END LOOP;
END $$;

CREATE INDEX study_staff_user ON public.study_staff(staff_user_id,study_id) WHERE is_active;
CREATE INDEX extractions_document ON public.document_extractions(source_document_id,created_at DESC);
CREATE INDEX eligibility_study ON public.eligibility_rules(study_id,sort_order);
CREATE INDEX participants_site_status ON public.participants(study_id,site_id,status);
CREATE INDEX participants_status ON public.participants(status) WHERE status NOT IN ('completed','withdrawn','screen_failed');
CREATE INDEX consents_document ON public.participant_consents(consent_document_id,status);
CREATE INDEX assessments_due ON public.scheduled_assessments(window_closes_at,participant_id) WHERE status='pending';
CREATE INDEX assessments_participant_time ON public.scheduled_assessments(participant_id,due_at DESC);
CREATE INDEX messages_participant_time ON public.messages(participant_id,created_at DESC);
CREATE INDEX messages_queue ON public.messages(created_at) WHERE direction='outbound' AND status='queued';
CREATE INDEX observations_measure_time ON public.observations(participant_id,measure_id,captured_at DESC);
CREATE INDEX observations_assessment ON public.observations(scheduled_assessment_id) WHERE scheduled_assessment_id IS NOT NULL;
CREATE INDEX observations_source_message ON public.observations(raw_message_id) WHERE raw_message_id IS NOT NULL;
CREATE INDEX observations_review ON public.observations(study_id,created_at) WHERE requires_review AND review_status='unreviewed';
CREATE INDEX events_participant_time ON public.participant_events(participant_id,occurred_at DESC);
CREATE INDEX alerts_queue ON public.alerts(study_id,assigned_site_id,severity,created_at) WHERE status IN ('open','acknowledged');
CREATE INDEX tasks_due ON public.workflow_tasks(run_after,id) WHERE status='pending';
CREATE INDEX tasks_participant ON public.workflow_tasks(participant_id,status);
CREATE INDEX audit_entity ON audit.events(entity_schema,entity_table,entity_id,occurred_at DESC);
CREATE INDEX audit_study_time ON audit.events(study_id,occurred_at DESC);

-- Views intentionally exclude contact information, raw messages, signatures,
-- free-text alert reasons, and observation values.
CREATE VIEW analytics.assessment_status WITH (security_barrier=TRUE) AS
SELECT a.id AS assessment_id,a.study_id,p.site_id,a.participant_id,p.participant_code,
  a.measure_id,m.measure_code,a.due_at,a.window_closes_at,
  CASE WHEN a.status='pending' AND a.window_closes_at < now() THEN 'overdue' ELSE a.status END AS status,
  a.completed_at,
  extract(epoch FROM (a.completed_at-a.due_at)) AS response_latency_seconds
FROM public.scheduled_assessments a
JOIN public.participants p ON p.id=a.participant_id
JOIN public.measure_definitions m ON m.id=a.measure_id;

CREATE VIEW analytics.participant_attention WITH (security_barrier=TRUE) AS
SELECT p.study_id,p.site_id,p.id AS participant_id,p.participant_code,p.status,
  public.has_current_consent(p.study_id,p.id) AS has_current_consent,
  (SELECT count(*) FROM public.scheduled_assessments a
    WHERE a.participant_id=p.id AND a.status='pending' AND a.window_closes_at < now()) AS overdue_assessments,
  (SELECT count(*) FROM public.alerts a WHERE a.participant_id=p.id AND a.status <> 'resolved') AS open_alerts,
  CASE WHEN p.status IN ('completed','withdrawn','screen_failed') THEN 'no_action'
    WHEN NOT public.has_current_consent(p.study_id,p.id) THEN 'obtain_consent'
    WHEN p.status IN ('consent_pending','consented') THEN 'confirm_enrollment'
    WHEN p.status='enrolled' THEN 'activate_participant'
    ELSE 'monitor_assessments' END AS next_action
FROM public.participants p;

CREATE VIEW analytics.site_metrics WITH (security_barrier=TRUE) AS
WITH participant_counts AS (
  SELECT study_id,site_id,count(*) AS participants,
    count(*) FILTER (WHERE public.has_current_consent(study_id,id)) AS currently_consented,
    count(*) FILTER (WHERE status='consent_pending') AS consent_pending,
    count(*) FILTER (WHERE status='active') AS active_participants
  FROM public.participants GROUP BY study_id,site_id
), assessment_counts AS (
  SELECT a.study_id,p.site_id,
    count(*) FILTER (WHERE a.due_at <= now() AND a.status IN ('pending','completed')) AS assessments_due,
    count(*) FILTER (WHERE a.due_at <= now() AND a.status='completed') AS assessments_completed,
    count(*) FILTER (WHERE a.window_closes_at < now() AND a.status='pending') AS assessments_overdue
  FROM public.scheduled_assessments a JOIN public.participants p ON p.id=a.participant_id GROUP BY a.study_id,p.site_id
), alert_counts AS (
  SELECT study_id,assigned_site_id,count(*) FILTER (WHERE status <> 'resolved') AS open_alerts
  FROM public.alerts GROUP BY study_id,assigned_site_id
)
SELECT s.study_id,s.id AS site_id,s.site_code,
  coalesce(p.participants,0) AS participants,coalesce(p.currently_consented,0) AS currently_consented,
  coalesce(p.consent_pending,0) AS consent_pending,coalesce(p.active_participants,0) AS active_participants,
  coalesce(a.assessments_due,0) AS assessments_due,coalesce(a.assessments_completed,0) AS assessments_completed,
  coalesce(a.assessments_overdue,0) AS assessments_overdue,
  round(a.assessments_completed::numeric/nullif(a.assessments_due,0),4) AS completion_rate,
  coalesce(l.open_alerts,0) AS open_alerts
FROM public.sites s LEFT JOIN participant_counts p ON p.study_id=s.study_id AND p.site_id=s.id
LEFT JOIN assessment_counts a ON a.study_id=s.study_id AND a.site_id=s.id
LEFT JOIN alert_counts l ON l.study_id=s.study_id AND l.assigned_site_id=s.id;

CREATE VIEW analytics.study_dashboard WITH (security_barrier=TRUE) AS
SELECT s.id AS study_id,s.study_code,s.title,s.status,s.target_enrollment,
  count(m.site_id) AS sites,coalesce(sum(m.participants),0) AS participants,
  coalesce(sum(m.currently_consented),0) AS currently_consented,
  coalesce(sum(m.consent_pending),0) AS consent_pending,
  coalesce(sum(m.active_participants),0) AS active_participants,
  coalesce(sum(m.assessments_due),0) AS assessments_due,
  coalesce(sum(m.assessments_completed),0) AS assessments_completed,
  coalesce(sum(m.assessments_overdue),0) AS assessments_overdue,
  round(sum(m.assessments_completed)::numeric/nullif(sum(m.assessments_due),0),4) AS completion_rate,
  coalesce(sum(m.open_alerts),0) AS open_alerts
FROM public.studies s LEFT JOIN analytics.site_metrics m ON m.study_id=s.id GROUP BY s.id;

CREATE VIEW analytics.alert_queue WITH (security_barrier=TRUE) AS
SELECT a.id AS alert_id,a.study_id,a.assigned_site_id AS site_id,a.participant_id,p.participant_code,
  a.alert_type,a.severity,a.status,a.assigned_staff_id,a.created_at,a.acknowledged_at,a.resolved_at,
  extract(epoch FROM (a.acknowledged_at-a.created_at)) AS seconds_to_acknowledgement
FROM public.alerts a JOIN public.participants p ON p.id=a.participant_id;

CREATE VIEW analytics.message_metrics WITH (security_barrier=TRUE) AS
SELECT m.study_id,p.site_id,m.channel,m.message_type,m.direction,m.status,
  count(*) AS message_count,
  avg(extract(epoch FROM (m.delivered_at-m.sent_at))) AS mean_delivery_seconds
FROM public.messages m JOIN public.participants p ON p.id=m.participant_id
GROUP BY m.study_id,p.site_id,m.channel,m.message_type,m.direction,m.status;

REVOKE ALL ON SCHEMA private, audit, analytics FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics TO analyst, manager_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO analyst, manager_agent;
GRANT EXECUTE ON FUNCTION public.has_current_consent(UUID,UUID) TO analyst, manager_agent;
-- No direct grants to patient_agent: patient authentication must be integrated
-- by the trusted backend before exposing participant-specific APIs.
INSERT INTO public.schema_migrations(version) VALUES ('001_consent_first_platform');
COMMIT;
