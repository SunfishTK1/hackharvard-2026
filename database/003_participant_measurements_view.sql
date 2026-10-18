-- 003: analytics.participant_measurements, one row per expected answer per participant.
--
-- Long format: study, site, participant, measure, study day, due time, status
-- (completed/missed/open/upcoming/skipped/cancelled), and the current value.
-- Responses recorded without a schedule appear with status 'unscheduled'.
--
-- Unlike the six views in 001, this view exposes observation values to analyst
-- and manager_agent. It still excludes contacts, raw message text, and the raw
-- reply (observations.raw_value); the parsed value is shown instead.
--
-- Run as postgres: psql -X -v ON_ERROR_STOP=1 -d clinical_trials -f database/003_participant_measurements_view.sql
-- Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='001_consent_first_platform') THEN
    RAISE EXCEPTION 'Apply 001_replace_clinical_trials.sql first';
  END IF;
END $$;

SET LOCAL ROLE app_owner;

-- Current value = latest response that is neither rejected nor superseded by a
-- non-rejected correction, matching how assessment completion is computed.
CREATE OR REPLACE VIEW analytics.participant_measurements WITH (security_barrier=TRUE) AS
SELECT st.id AS study_id, st.study_code, si.id AS site_id, si.site_code,
  p.id AS participant_id, p.participant_code, p.status AS participant_status,
  m.id AS measure_id, m.measure_code, m.label AS measure_label, m.data_type, m.unit,
  a.id AS assessment_id,
  ((a.due_at AT TIME ZONE p.time_zone)::date
    - (CASE sc.anchor_event WHEN 'enrollment' THEN p.enrolled_at ELSE p.activated_at END AT TIME ZONE p.time_zone)::date)
    AS study_day,
  (a.due_at AT TIME ZONE p.time_zone)::date AS local_date,
  a.due_at, a.window_closes_at,
  CASE
    WHEN a.status <> 'pending' THEN a.status
    WHEN a.window_closes_at < now() THEN 'missed'
    WHEN a.window_opens_at <= now() THEN 'open'
    ELSE 'upcoming' END AS status,
  a.status_reason,
  CASE WHEN o.id IS NOT NULL THEN coalesce(trim_scale(o.numeric_value)::text,
    CASE o.boolean_value WHEN TRUE THEN 'Yes' WHEN FALSE THEN 'No' END, o.text_value, o.json_value::text) END AS value,
  o.numeric_value, o.boolean_value, o.text_value, o.json_value,
  coalesce(o.source_type, m.source_type) AS source_type,
  o.captured_at,
  round((extract(epoch FROM (o.captured_at - a.due_at)) / 60)::numeric, 1) AS minutes_from_due,
  o.id AS observation_id,
  (o.supersedes_observation_id IS NOT NULL) AS is_correction,
  o.review_status, o.requires_review
FROM public.scheduled_assessments a
JOIN public.participants p ON p.id = a.participant_id
JOIN public.studies st ON st.id = a.study_id
JOIN public.sites si ON si.id = p.site_id
JOIN public.measure_definitions m ON m.id = a.measure_id
LEFT JOIN public.assessment_schedules sc ON sc.id = a.schedule_id
LEFT JOIN LATERAL (
  SELECT o.* FROM public.observations o
  WHERE o.scheduled_assessment_id = a.id AND o.review_status <> 'rejected'
    AND NOT EXISTS (SELECT 1 FROM public.observations n
      WHERE n.supersedes_observation_id = o.id AND n.review_status <> 'rejected')
  ORDER BY o.captured_at DESC, o.created_at DESC
  LIMIT 1
) o ON TRUE
UNION ALL
SELECT st.id, st.study_code, si.id, si.site_code,
  p.id, p.participant_code, p.status,
  m.id, m.measure_code, m.label, m.data_type, m.unit,
  NULL::uuid,
  ((o.captured_at AT TIME ZONE p.time_zone)::date - (p.activated_at AT TIME ZONE p.time_zone)::date),
  (o.captured_at AT TIME ZONE p.time_zone)::date,
  NULL::timestamptz, NULL::timestamptz,
  'unscheduled', NULL::text,
  coalesce(trim_scale(o.numeric_value)::text,
    CASE o.boolean_value WHEN TRUE THEN 'Yes' WHEN FALSE THEN 'No' END, o.text_value, o.json_value::text),
  o.numeric_value, o.boolean_value, o.text_value, o.json_value,
  o.source_type, o.captured_at, NULL::numeric, o.id,
  (o.supersedes_observation_id IS NOT NULL), o.review_status, o.requires_review
FROM public.observations o
JOIN public.participants p ON p.id = o.participant_id
JOIN public.studies st ON st.id = o.study_id
JOIN public.sites si ON si.id = p.site_id
JOIN public.measure_definitions m ON m.id = o.measure_id
WHERE o.scheduled_assessment_id IS NULL AND o.review_status <> 'rejected'
  AND NOT EXISTS (SELECT 1 FROM public.observations n
    WHERE n.supersedes_observation_id = o.id AND n.review_status <> 'rejected');

GRANT SELECT ON analytics.participant_measurements TO analyst, manager_agent;

RESET ROLE;
INSERT INTO public.schema_migrations(version) VALUES ('003_participant_measurements_view')
ON CONFLICT (version) DO NOTHING;
COMMIT;
