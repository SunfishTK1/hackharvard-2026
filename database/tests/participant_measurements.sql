-- Checks for analytics.participant_measurements. Read-only; works on any data.
-- Run as postgres with psql -X -v ON_ERROR_STOP=1 after 003.
\set QUIET on
BEGIN READ ONLY;
DO $$
DECLARE v_expected BIGINT; v_actual BIGINT;
BEGIN
  SELECT (SELECT count(*) FROM public.scheduled_assessments)
       + (SELECT count(*) FROM public.observations o
          WHERE o.scheduled_assessment_id IS NULL AND o.review_status <> 'rejected'
            AND NOT EXISTS (SELECT 1 FROM public.observations n
              WHERE n.supersedes_observation_id=o.id AND n.review_status <> 'rejected'))
    INTO v_expected;
  SELECT count(*) INTO v_actual FROM analytics.participant_measurements;
  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'Expected % rows (one per expected answer plus unscheduled responses), got %', v_expected, v_actual;
  END IF;
  IF (SELECT count(*) FROM analytics.participant_measurements GROUP BY assessment_id
      HAVING assessment_id IS NOT NULL AND count(*) > 1 LIMIT 1) IS NOT NULL THEN
    RAISE EXCEPTION 'An expected answer appears more than once';
  END IF;
  IF EXISTS (SELECT 1 FROM analytics.participant_measurements
             WHERE status NOT IN ('completed','missed','open','upcoming','skipped','cancelled','unscheduled')) THEN
    RAISE EXCEPTION 'Unexpected status value';
  END IF;
  IF EXISTS (SELECT 1 FROM analytics.participant_measurements
             WHERE status='completed' AND (observation_id IS NULL OR value IS NULL)) THEN
    RAISE EXCEPTION 'A completed answer has no current value';
  END IF;
  IF EXISTS (SELECT 1 FROM analytics.participant_measurements v JOIN public.observations o ON o.id=v.observation_id
             WHERE o.review_status='rejected'
                OR EXISTS (SELECT 1 FROM public.observations n
                  WHERE n.supersedes_observation_id=o.id AND n.review_status <> 'rejected')) THEN
    RAISE EXCEPTION 'A rejected or superseded value is shown as current';
  END IF;
  IF EXISTS (SELECT 1 FROM analytics.participant_measurements v JOIN public.scheduled_assessments a ON a.id=v.assessment_id
             WHERE (v.status='missed') <> (a.status='pending' AND a.window_closes_at < now())) THEN
    RAISE EXCEPTION 'Missed status disagrees with the assessment window';
  END IF;
  IF NOT has_table_privilege('analyst','analytics.participant_measurements','SELECT')
     OR NOT has_table_privilege('manager_agent','analytics.participant_measurements','SELECT')
     OR has_table_privilege('patient_agent','analytics.participant_measurements','SELECT') THEN
    RAISE EXCEPTION 'Unexpected privileges on participant_measurements';
  END IF;
END $$;
SET LOCAL ROLE analyst;
SELECT count(*) AS analyst_rows FROM analytics.participant_measurements;
SET LOCAL ROLE manager_agent;
SELECT count(*) AS manager_agent_rows FROM analytics.participant_measurements;
RESET ROLE;
\set QUIET off
SELECT 'participant_measurements checks passed' AS result;
COMMIT;
