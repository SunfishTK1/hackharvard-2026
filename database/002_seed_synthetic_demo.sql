-- 002: synthetic demo data for the consent-first clinical trials schema.
--
-- Source of truth: clinical_trial_synthetic_package.zip from the project handoff
-- (study_config.json, the 20 study PDFs, all_sites.csv, all_participants_initial.csv).
-- Every person, phone number, document, and value here is synthetic.
--
-- Run after 001_replace_clinical_trials.sql, as postgres:
--   psql -X -v ON_ERROR_STOP=1 -d clinical_trials -f database/002_seed_synthetic_demo.sql
--
-- Idempotent: the seed records 002_synthetic_demo_seed in public.schema_migrations
-- and does nothing when that row exists. Evidence tables are append-only, so the
-- seed cannot reset itself; it refuses to load into tables that already have rows.
--
-- Timeline: timestamps are relative to the day the seed runs (America/New_York),
-- so overdue consents, missed responses, and open alerts are true at load time.
-- Nothing refreshes them afterwards. Re-seed a fresh database for a new demo day.
--
-- Lifecycle changes go through the schema's validation triggers. The one adjustment
-- is a transaction-local default on participant_events.occurred_at, so that the
-- trigger-written lifecycle events carry the historical time of each transition.
-- The original default (now()) is restored before commit.
--
-- Alert thresholds are demo assumptions. The protocols describe "predefined safety
-- and completeness signals" without values; each rule's condition says so.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET LOCAL ROLE app_owner;

CREATE OR REPLACE FUNCTION pg_temp.ct_id(seed_key TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('clinical-trials-demo/'||seed_key)::uuid $$;

CREATE OR REPLACE FUNCTION pg_temp.ct_u(seed_key TEXT) RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
  SELECT (('x'||lpad(substr(md5('clinical-trials-demo-u/'||seed_key),1,8),16,'0'))::bit(64)::bigint)::double precision
    / 4294967296::double precision
$$;

-- Site-local wall-clock time, day_offset days from the load day.
CREATE OR REPLACE FUNCTION pg_temp.ct_at(day_offset INTEGER, local_time TIME) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT ((((now() AT TIME ZONE 'America/New_York')::date + day_offset) + local_time) AT TIME ZONE 'America/New_York')
$$;

DO $seed$
DECLARE
  r RECORD;
  v_found BOOLEAN;
  v_count INTEGER;
  v_dist TEXT;
  v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='001_consent_first_platform') THEN
    RAISE EXCEPTION 'Apply 001_replace_clinical_trials.sql before this seed';
  END IF;
  LOCK TABLE public.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='002_synthetic_demo_seed') THEN
    RAISE NOTICE 'Synthetic demo seed already applied; no changes made';
    RETURN;
  END IF;
  FOR r IN SELECT schemaname, tablename FROM pg_catalog.pg_tables
    WHERE schemaname IN ('public','private') AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', r.schemaname, r.tablename) INTO v_found;
    IF v_found THEN
      RAISE EXCEPTION 'Refusing to seed: %.% already has rows. Load the demo into an empty migrated database.',
        r.schemaname, r.tablename;
    END IF;
  END LOOP;

  ALTER TABLE public.participant_events ALTER COLUMN occurred_at
    SET DEFAULT coalesce(nullif(current_setting('ct_seed.occurred_at', TRUE), '')::timestamptz, now());

  ---------------------------------------------------------------------------
  -- Source package: study_config.json (verbatim) plus SoA visit columns.
  ---------------------------------------------------------------------------
  CREATE TEMP TABLE ct_study ON COMMIT DROP AS
  SELECT c.cfg->>'study_id' AS study_code, c.cfg, x.k, x.roster_d, x.short_name, x.soa_visits,
    x.manager_name, x.manager_slug,
    pg_temp.ct_id('study/'||(c.cfg->>'study_id')) AS study_id,
    pg_temp.ct_id('staff/'||x.manager_slug) AS manager_user,
    pg_temp.ct_id('assignment/'||(c.cfg->>'study_id')||'/trial_manager') AS manager_assign
  FROM jsonb_array_elements($cfg$[
{"study_id":"STUDY-001","protocol_id":"MX101-2026-02","title":"A Phase II Study of MX-101 for Migraine Prevention","condition":"Migraine","phase":"Phase 2","design":"Randomized, double-blind, placebo-controlled","target_enrollment":180,"duration_weeks":12,"arms":["MX-101 50 mg once daily","Placebo once daily"],"intervention":"MX-101","protocol_version":"4.0","icf_version":"2.1","soa_version":"2.0","epro_version":"1.3","inclusion":["Age 18-65 years","Clinical diagnosis of migraine","At least 4 migraine days/month during screening","Able to use secure messaging"],"exclusion":["Pregnancy","Known allergy to the study drug class","Use of prohibited preventive migraine medication"],"primary":"Change from baseline in monthly migraine days at Week 12","measures":[["Headache severity","0-10","Daily","Patient message"],["Study medication taken","Yes/No","Daily","Patient message"],["Nausea severity","0-10","Daily","Patient message"],["Migraine days","Count","Weekly","Patient questionnaire"],["Vital signs","BP/HR","Weeks 0,4,8,12","Site visit"]],"risks":["headache","nausea","fatigue","unknown risks typical of an investigational product"]},
{"study_id":"STUDY-002","protocol_id":"GLY210-301","title":"A Phase III Study of GLY-210 in Adults With Type 2 Diabetes","condition":"Type 2 Diabetes","phase":"Phase 3","design":"Randomized, double-blind, active-controlled","target_enrollment":240,"duration_weeks":24,"arms":["GLY-210 10 mg once daily","Active comparator once daily"],"intervention":"GLY-210","protocol_version":"3.2","icf_version":"2.0","soa_version":"1.4","epro_version":"1.1","inclusion":["Age 18-75 years","Type 2 diabetes diagnosis","HbA1c 7.5%-10.5% at screening","Stable background therapy"],"exclusion":["Type 1 diabetes","Recent severe hypoglycemia","Pregnancy"],"primary":"Change in HbA1c from baseline to Week 24","measures":[["Fasting glucose","mg/dL","Daily","Patient/device entry"],["Study medication taken","Yes/No","Daily","Patient message"],["Hypoglycemia symptoms","Yes/No","Daily","Patient message"],["Weight","kg","Weekly","Patient entry"],["HbA1c","%","Weeks 0,12,24","Site laboratory"]],"risks":["low blood sugar","gastrointestinal symptoms","dizziness","unknown risks typical of an investigational product"]},
{"study_id":"STUDY-003","protocol_id":"MINDPATH-01","title":"A Randomized Study of a Digital CBT Program for Depression","condition":"Major Depressive Disorder","phase":"Not Applicable","design":"Randomized, assessor-blinded, digital behavioral intervention","target_enrollment":120,"duration_weeks":8,"arms":["MindPath-CBT","Digital education control"],"intervention":"MindPath-CBT","protocol_version":"2.0","icf_version":"1.1","soa_version":"1.2","epro_version":"2.0","inclusion":["Age 18-70 years","Current depressive symptoms within study range","Smartphone access","English proficiency for study materials"],"exclusion":["Immediate crisis requiring emergency evaluation","Concurrent conflicting interventional study"],"primary":"Change in validated depression symptom score at Week 8","measures":[["Daily mood score","0-10","Daily","Patient message"],["Sleep duration","Hours","Daily","Patient message"],["CBT module completion","Yes/No","3 times/week","App event"],["Safety screening question","Yes/No","Weekly","Patient questionnaire"],["Depression symptom scale","Score","Weeks 0,4,8","Patient questionnaire"]],"risks":["temporary emotional discomfort when answering questions","privacy risks related to digital data","unknown risks associated with the digital intervention"]},
{"study_id":"STUDY-004","protocol_id":"ONC440-202","title":"A Phase II Study of ONC-440 in Mutation-Positive Solid Tumors","condition":"Advanced Solid Tumor","phase":"Phase 2","design":"Open-label, multicenter, single-arm","target_enrollment":90,"duration_weeks":16,"arms":["ONC-440 twice daily"],"intervention":"ONC-440","protocol_version":"5.1","icf_version":"3.2","soa_version":"3.0","epro_version":"1.5","inclusion":["Age 18 years or older","Confirmed advanced solid tumor","Required tumor mutation","Adequate organ function"],"exclusion":["Uncontrolled serious infection","Recent prohibited anticancer therapy","Pregnancy"],"primary":"Objective response rate at Week 16","measures":[["Fatigue severity","0-10","Daily","Patient message"],["Study medication taken","Yes/No","Daily","Patient message"],["Temperature","F","Daily","Patient entry"],["New symptoms","Free text","Daily","Patient message"],["Tumor imaging","RECIST assessment","Weeks 0,8,16","Site imaging"]],"risks":["fatigue","fever","gastrointestinal symptoms","laboratory abnormalities","unknown risks typical of an investigational anticancer product"]},
{"study_id":"STUDY-005","protocol_id":"BPLINK-HTN-01","title":"Remote Blood Pressure Monitoring Study in Adults With Hypertension","condition":"Hypertension","phase":"Not Applicable","design":"Randomized, remote device-enabled study","target_enrollment":150,"duration_weeks":12,"arms":["BP-Link remote monitoring","Usual-care monitoring"],"intervention":"BP-Link","protocol_version":"1.5","icf_version":"1.0","soa_version":"1.0","epro_version":"1.0","inclusion":["Age 30-80 years","Diagnosed hypertension","Home internet or cellular access","Able to use the study blood-pressure cuff"],"exclusion":["Pregnancy","Unstable cardiovascular condition requiring immediate management"],"primary":"Change in mean home systolic blood pressure at Week 12","measures":[["Systolic blood pressure","mmHg","Twice daily","Connected device"],["Diastolic blood pressure","mmHg","Twice daily","Connected device"],["Pulse","bpm","Twice daily","Connected device"],["BP medication taken","Yes/No","Daily","Patient message"],["Symptoms","Free text","Daily","Patient message"]],"risks":["minor discomfort from cuff inflation","privacy risks related to remote monitoring","possible anxiety from repeated measurements"]}
]$cfg$::jsonb) AS c(cfg)
  JOIN (VALUES
    -- k staggers each study's setup by a day; roster_d is the roster upload day.
    -- Trial managers are not named in the package and are invented.
    ('STUDY-001',0,-45,'MX-101 study',ARRAY['Screening','Baseline','Week 2','Week 4','Week 8','Week 12'],'Riley Adams','riley.adams'),
    ('STUDY-002',1,-50,'GLY-210 study',ARRAY['Screening','Baseline','Week 4','Week 8','Week 12','Week 18','Week 24'],'Casey Nguyen','casey.nguyen'),
    ('STUDY-003',2,-42,'MindPath study',ARRAY['Screening','Baseline','Week 2','Week 4','Week 6','Week 8'],'Morgan Hayes','morgan.hayes'),
    ('STUDY-004',3,-44,'ONC-440 study',ARRAY['Screening','Baseline','Week 2','Week 4','Week 8','Week 12','Week 16'],'Taylor Quinn','taylor.quinn'),
    ('STUDY-005',4,-43,'BP-Link study',ARRAY['Screening','Baseline','Week 2','Week 4','Week 8','Week 12'],'Drew Foster','drew.foster')
  ) AS x(study_code,k,roster_d,short_name,soa_visits,manager_name,manager_slug)
    ON x.study_code = c.cfg->>'study_id';

  -- all_sites.csv, verbatim.
  CREATE TEMP TABLE ct_site ON COMMIT DROP AS
  SELECT v.*, s.k, s.study_id, s.manager_user,
    pg_temp.ct_id('site/'||v.site_code) AS site_id,
    lower(regexp_replace(regexp_replace(v.pi,'^Dr\. ',''),'[^A-Za-z]+','.','g')) AS pi_slug,
    lower(regexp_replace(v.coordinator,'[^A-Za-z]+','.','g')) AS coord_slug,
    pg_temp.ct_id('assignment/'||v.site_code||'/principal_investigator') AS pi_assign,
    pg_temp.ct_id('assignment/'||v.site_code||'/coordinator') AS coord_assign
  FROM (VALUES
    ('SITE-001-A','STUDY-001','Harbor Academic Medical Center','Boston','MA','Dr. Maya Chen','Lena Ortiz','Active','2.1-BOS'),
    ('SITE-001-B','STUDY-001','North Shore Research Center','Salem','MA','Dr. Aaron Lee','Chris Young','Active','2.1-SAL'),
    ('SITE-002-A','STUDY-002','Metro Endocrine Institute','Boston','MA','Dr. Priya Shah','Evan Brooks','Active','2.0-BOS'),
    ('SITE-002-B','STUDY-002','Cambridge Clinical Center','Cambridge','MA','Dr. Noah Kim','Mia Patel','Active','2.0-CAM'),
    ('SITE-003-A','STUDY-003','Behavioral Health Research Lab','Boston','MA','Dr. Elena Ruiz','Sam Carter','Active','1.1-BOS'),
    ('SITE-003-B','STUDY-003','Digital Mental Health Center','Providence','RI','Dr. Theo Martin','Nina James','Active','1.1-PRO'),
    ('SITE-004-A','STUDY-004','Regional Cancer Institute','Boston','MA','Dr. Amara Singh','Zoe Miller','Active','3.2-BOS'),
    ('SITE-004-B','STUDY-004','New England Oncology Center','Worcester','MA','Dr. Lucas Grant','Owen Reed','Active','3.2-WOR'),
    ('SITE-005-A','STUDY-005','Heart & Vascular Research Center','Boston','MA','Dr. Leah Park','Avery Ross','Active','1.0-BOS'),
    ('SITE-005-B','STUDY-005','Community Cardiology Research','Quincy','MA','Dr. Daniel Wu','Jordan Cole','Active','1.0-QUI')
  ) AS v(site_code,study_code,institution,city,state,pi,coordinator,site_status,local_icf)
  JOIN ct_study s USING (study_code);
  ALTER TABLE ct_site ADD COLUMN pi_user UUID, ADD COLUMN coord_user UUID;
  UPDATE ct_site SET pi_user=pg_temp.ct_id('staff/'||pi_slug), coord_user=pg_temp.ct_id('staff/'||coord_slug);

  IF (SELECT count(*) FROM ct_study) <> 5 OR (SELECT count(*) FROM ct_site) <> 10 THEN
    RAISE EXCEPTION 'Expected 5 studies and 10 sites from the source package';
  END IF;
  IF EXISTS (SELECT 1 FROM ct_site t JOIN ct_study s USING (study_code)
             WHERE t.local_icf NOT LIKE (s.cfg->>'icf_version')||'-%') THEN
    RAISE EXCEPTION 'A site ICF version does not derive from its study ICF version';
  END IF;

  -- Patient_Questionnaire_ePRO.pdf items. Labels, response types, frequencies and
  -- sources are checked against study_config.json below. Data types, units,
  -- plausible ranges, and delivery times are configuration choices.
  CREATE TEMP TABLE ct_measure ON COMMIT DROP AS
  SELECT v.study_code, v.measure_code, v.field_id, v.label, v.prompt, v.response_type, v.frequency_text, v.source_text,
    v.data_type, v.unit, v.min_value::numeric AS min_value, v.max_value::numeric AS max_value, v.choices::jsonb AS choices,
    v.source_type, v.sched_frequency, v.times::time[] AS times, v.weekdays::smallint[] AS weekdays,
    v.study_days::integer[] AS study_days, v.grace, s.k, s.study_id, s.short_name,
    (s.cfg->>'duration_weeks')::integer * 7 AS end_day, s.cfg->>'epro_version' AS epro_version,
    pg_temp.ct_id('measure/'||v.study_code||'/'||v.measure_code) AS measure_id,
    pg_temp.ct_id('schedule/'||v.study_code||'/'||v.measure_code) AS schedule_id
  FROM (VALUES
    ('STUDY-001','q01_headache_severity','Q01','Headache severity','On a scale from 0 to 10, what was your headache severity today?','0-10','Daily','Patient message','integer',NULL,0,10,NULL,'patient_message','daily','{20:00}',NULL,NULL,240),
    ('STUDY-001','q02_study_medication_taken','Q02','Study medication taken','Study medication taken?','Yes/No','Daily','Patient message','boolean',NULL,NULL,NULL,NULL,'patient_message','daily','{09:00}',NULL,NULL,720),
    ('STUDY-001','q03_nausea_severity','Q03','Nausea severity','On a scale from 0 to 10, what was your nausea severity today?','0-10','Daily','Patient message','integer',NULL,0,10,NULL,'patient_message','daily','{20:00}',NULL,NULL,240),
    ('STUDY-001','q04_migraine_days','Q04','Migraine days','Please enter your migraine days (Count).','Count','Weekly','Patient questionnaire','integer','days',0,7,NULL,'questionnaire','weekly','{18:00}','{7}',NULL,2880),
    ('STUDY-001','q05_vital_signs','Q05','Vital signs','Please report your vital signs.','BP/HR','Weeks 0,4,8,12','Site visit','json',NULL,NULL,NULL,NULL,'site_visit','custom_days','{10:00}',NULL,'{0,28,56,84}',4320),
    ('STUDY-002','q01_fasting_glucose','Q01','Fasting glucose','Please enter your fasting glucose (mg/dL).','mg/dL','Daily','Patient/device entry','numeric','mg/dL',20,600,NULL,'device','daily','{07:30}',NULL,NULL,240),
    ('STUDY-002','q02_study_medication_taken','Q02','Study medication taken','Study medication taken?','Yes/No','Daily','Patient message','boolean',NULL,NULL,NULL,NULL,'patient_message','daily','{09:00}',NULL,NULL,720),
    ('STUDY-002','q03_hypoglycemia_symptoms','Q03','Hypoglycemia symptoms','Hypoglycemia symptoms?','Yes/No','Daily','Patient message','boolean',NULL,NULL,NULL,NULL,'patient_message','daily','{20:00}',NULL,NULL,240),
    ('STUDY-002','q04_weight','Q04','Weight','Please enter your weight (kg).','kg','Weekly','Patient entry','numeric','kg',30,250,NULL,'patient_message','weekly','{08:00}','{7}',NULL,2880),
    ('STUDY-002','q05_hba1c','Q05','HbA1c','Please report your hba1c.','%','Weeks 0,12,24','Site laboratory','numeric','%',3,20,NULL,'laboratory','custom_days','{10:00}',NULL,'{0,84,168}',10080),
    ('STUDY-003','q01_daily_mood_score','Q01','Daily mood score','On a scale from 0 to 10, what was your daily mood score today?','0-10','Daily','Patient message','integer',NULL,0,10,NULL,'patient_message','daily','{20:00}',NULL,NULL,240),
    ('STUDY-003','q02_sleep_duration','Q02','Sleep duration','Please enter your sleep duration (Hours).','Hours','Daily','Patient message','numeric','hours',0,24,NULL,'patient_message','daily','{09:00}',NULL,NULL,240),
    ('STUDY-003','q03_cbt_module_completion','Q03','CBT module completion','CBT module completion?','Yes/No','3 times/week','App event','boolean',NULL,NULL,NULL,NULL,'app_event','weekly','{21:00}','{1,3,5}',NULL,180),
    ('STUDY-003','q04_safety_screening','Q04','Safety screening question','Safety screening question?','Yes/No','Weekly','Patient questionnaire','boolean',NULL,NULL,NULL,NULL,'questionnaire','weekly','{18:00}','{7}',NULL,2880),
    ('STUDY-003','q05_depression_symptom_scale','Q05','Depression symptom scale','Please enter your depression symptom scale (Score).','Score','Weeks 0,4,8','Patient questionnaire','integer',NULL,0,NULL,NULL,'questionnaire','custom_days','{10:00}',NULL,'{0,28,56}',4320),
    ('STUDY-004','q01_fatigue_severity','Q01','Fatigue severity','On a scale from 0 to 10, what was your fatigue severity today?','0-10','Daily','Patient message','integer',NULL,0,10,NULL,'patient_message','daily','{20:00}',NULL,NULL,240),
    ('STUDY-004','q02_study_medication_taken','Q02','Study medication taken','Study medication taken?','Yes/No','Daily','Patient message','boolean',NULL,NULL,NULL,NULL,'patient_message','daily','{09:00}',NULL,NULL,720),
    ('STUDY-004','q03_temperature','Q03','Temperature','Please enter your temperature (F).','F','Daily','Patient entry','numeric','F',90,110,NULL,'patient_message','daily','{18:00}',NULL,NULL,240),
    ('STUDY-004','q04_new_symptoms','Q04','New symptoms','Please report your new symptoms.','Free text','Daily','Patient message','text',NULL,NULL,NULL,NULL,'patient_message','daily','{20:00}',NULL,NULL,240),
    ('STUDY-004','q05_tumor_imaging','Q05','Tumor imaging','Please report your tumor imaging.','RECIST assessment','Weeks 0,8,16','Site imaging','choice',NULL,NULL,NULL,'["baseline_documented","CR","PR","SD","PD","NE"]','site_visit','custom_days','{10:00}',NULL,'{0,56,112}',10080),
    ('STUDY-005','q01_systolic_bp','Q01','Systolic blood pressure','Please enter your systolic blood pressure (mmHg).','mmHg','Twice daily','Connected device','numeric','mmHg',50,300,NULL,'device','daily','{07:00,19:00}',NULL,NULL,180),
    ('STUDY-005','q02_diastolic_bp','Q02','Diastolic blood pressure','Please enter your diastolic blood pressure (mmHg).','mmHg','Twice daily','Connected device','numeric','mmHg',30,200,NULL,'device','daily','{07:00,19:00}',NULL,NULL,180),
    ('STUDY-005','q03_pulse','Q03','Pulse','Please enter your pulse (bpm).','bpm','Twice daily','Connected device','numeric','bpm',25,250,NULL,'device','daily','{07:00,19:00}',NULL,NULL,180),
    ('STUDY-005','q04_bp_medication_taken','Q04','BP medication taken','BP medication taken?','Yes/No','Daily','Patient message','boolean',NULL,NULL,NULL,NULL,'patient_message','daily','{09:00}',NULL,NULL,720),
    ('STUDY-005','q05_symptoms','Q05','Symptoms','Please report your symptoms.','Free text','Daily','Patient message','text',NULL,NULL,NULL,NULL,'patient_message','daily','{20:00}',NULL,NULL,240)
  ) AS v(study_code,measure_code,field_id,label,prompt,response_type,frequency_text,source_text,data_type,unit,
         min_value,max_value,choices,source_type,sched_frequency,times,weekdays,study_days,grace)
  JOIN ct_study s USING (study_code);

  IF EXISTS (
    (SELECT study_code, label, response_type, frequency_text, source_text FROM ct_measure
     EXCEPT SELECT s.study_code, m->>0, m->>1, m->>2, m->>3 FROM ct_study s, jsonb_array_elements(s.cfg->'measures') m)
    UNION ALL
    (SELECT s.study_code, m->>0, m->>1, m->>2, m->>3 FROM ct_study s, jsonb_array_elements(s.cfg->'measures') m
     EXCEPT SELECT study_code, label, response_type, frequency_text, source_text FROM ct_measure)
  ) THEN
    RAISE EXCEPTION 'Measure definitions do not match study_config.json';
  END IF;

  -- Protocol section 3 arms; names are checked against study_config.json.
  CREATE TEMP TABLE ct_arm ON COMMIT DROP AS
  SELECT v.*, pg_temp.ct_id('arm/'||v.study_code||'/'||v.arm_code) AS arm_id
  FROM (VALUES
    ('STUDY-001','MX101_50MG','MX-101 50 mg once daily','MX-101','50 mg','once daily',FALSE),
    ('STUDY-001','PLACEBO','Placebo once daily','Placebo',NULL,'once daily',TRUE),
    ('STUDY-002','GLY210_10MG','GLY-210 10 mg once daily','GLY-210','10 mg','once daily',FALSE),
    ('STUDY-002','ACTIVE_COMPARATOR','Active comparator once daily','Active comparator',NULL,'once daily',TRUE),
    ('STUDY-003','MINDPATH_CBT','MindPath-CBT','MindPath-CBT',NULL,NULL,FALSE),
    ('STUDY-003','EDUCATION_CONTROL','Digital education control','Digital education control',NULL,NULL,TRUE),
    ('STUDY-004','ONC440','ONC-440 twice daily','ONC-440',NULL,'twice daily',FALSE),
    ('STUDY-005','BPLINK_REMOTE','BP-Link remote monitoring','BP-Link',NULL,NULL,FALSE),
    ('STUDY-005','USUAL_CARE','Usual-care monitoring','Usual care',NULL,NULL,TRUE)
  ) AS v(study_code,arm_code,name,intervention_name,dose,frequency,is_control);
  IF EXISTS (
    (SELECT study_code, name FROM ct_arm
     EXCEPT SELECT study_code, jsonb_array_elements_text(cfg->'arms') FROM ct_study)
    UNION ALL
    (SELECT study_code, jsonb_array_elements_text(cfg->'arms') FROM ct_study
     EXCEPT SELECT study_code, name FROM ct_arm)
  ) THEN
    RAISE EXCEPTION 'Study arms do not match study_config.json';
  END IF;

  ---------------------------------------------------------------------------
  -- Staff, studies, sites, and assignments.
  ---------------------------------------------------------------------------
  INSERT INTO private.staff_users(id, auth_subject, display_name, email, created_at, updated_at)
  SELECT pg_temp.ct_id('staff/'||u.slug), 'synthetic|'||u.slug, u.display_name, u.slug||'@example.org',
    pg_temp.ct_at(-90,'09:00'), pg_temp.ct_at(-90,'09:00')
  FROM (
    SELECT manager_slug AS slug, manager_name AS display_name FROM ct_study
    UNION ALL SELECT pi_slug, pi FROM ct_site
    UNION ALL SELECT coord_slug, coordinator FROM ct_site
    UNION ALL SELECT 'pat.kowalski', 'Pat Kowalski'
  ) u;

  INSERT INTO public.studies(id, study_code, title, condition, phase, study_type, design, intervention,
    protocol_id, protocol_version, target_enrollment, duration_weeks, primary_outcome, status, is_synthetic,
    created_at, updated_at)
  SELECT study_id, study_code, cfg->>'title', cfg->>'condition', cfg->>'phase', 'interventional', cfg->>'design',
    cfg->>'intervention', cfg->>'protocol_id', cfg->>'protocol_version', (cfg->>'target_enrollment')::integer,
    (cfg->>'duration_weeks')::integer, cfg->>'primary', 'draft', TRUE,
    pg_temp.ct_at(-80+k,'08:30'), pg_temp.ct_at(-80+k,'08:30')
  FROM ct_study;

  INSERT INTO public.sites(id, study_id, site_code, institution_name, city, state, country, time_zone, status,
    principal_investigator, created_at, updated_at)
  SELECT site_id, study_id, site_code, institution, city, state, 'US', 'America/New_York', lower(site_status), pi,
    pg_temp.ct_at(-78+k,'10:00'), pg_temp.ct_at(-78+k,'10:00')
  FROM ct_site;

  INSERT INTO public.study_staff(id, study_id, site_id, staff_user_id, role, receives_alerts, created_at)
  SELECT manager_assign, study_id, NULL::uuid, manager_user, 'trial_manager', TRUE, pg_temp.ct_at(-78+k,'11:00') FROM ct_study
  UNION ALL
  SELECT pg_temp.ct_id('assignment/'||study_code||'/analyst'), study_id, NULL, pg_temp.ct_id('staff/pat.kowalski'),
    'analyst', FALSE, pg_temp.ct_at(-78+k,'11:00') FROM ct_study
  UNION ALL
  SELECT pi_assign, study_id, site_id, pi_user, 'principal_investigator', TRUE, pg_temp.ct_at(-78+k,'11:00') FROM ct_site
  UNION ALL
  SELECT coord_assign, study_id, site_id, coord_user, 'coordinator', TRUE, pg_temp.ct_at(-78+k,'11:00') FROM ct_site;

  ---------------------------------------------------------------------------
  -- Source documents (SHA-256 of the package files) and reviewed extractions.
  ---------------------------------------------------------------------------
  CREATE TEMP TABLE ct_doc ON COMMIT DROP AS
  SELECT pg_temp.ct_id('document/'||f.study_code||'/study/'||f.document_type) AS doc_id,
    f.study_code, s.study_id, NULL::uuid AS site_id, f.document_type,
    CASE f.document_type
      WHEN 'protocol' THEN s.cfg->>'protocol_version'
      WHEN 'icf' THEN s.cfg->>'icf_version'
      WHEN 'schedule_of_activities' THEN s.cfg->>'soa_version'
      WHEN 'epro' THEN s.cfg->>'epro_version'
      ELSE '1.0' END AS version,
    f.file_name, 'package://clinical_trial_synthetic_package/'||f.study_code||'/'||f.file_name AS storage_uri,
    f.sha256, s.manager_user AS uploaded_by, s.manager_user AS reviewed_by,
    CASE f.document_type
      WHEN 'site_roster' THEN pg_temp.ct_at(-74+s.k,'09:00')
      WHEN 'participant_roster' THEN pg_temp.ct_at(s.roster_d,'09:15')
      ELSE pg_temp.ct_at(-75+s.k,'10:00') END AS uploaded_at,
    CASE f.document_type
      WHEN 'site_roster' THEN pg_temp.ct_at(-74+s.k,'16:00')
      WHEN 'participant_roster' THEN pg_temp.ct_at(s.roster_d,'09:25')
      ELSE pg_temp.ct_at(-73+s.k,'15:00') END AS reviewed_at
  FROM (VALUES
    ('STUDY-001','Protocol.pdf','protocol','c00369f365720707c4fe91bda80e3aad990c5473b8983020073c171efd62d368'),
    ('STUDY-001','ICF.pdf','icf','17b6979d1049708f31af8bfe482d390e1dd136afc6e1c37c96180d848ea6aed4'),
    ('STUDY-001','Schedule_of_Activities.pdf','schedule_of_activities','7a94ce542e7ec46f780c5cdd86eafdb44f0012832878e5147c80e297f668e707'),
    ('STUDY-001','Patient_Questionnaire_ePRO.pdf','epro','d1fb36a4cc88fc73c800390b96ff1b0ff8fcdb172333333a65481bb9e93933dd'),
    ('STUDY-001','Site_Roster.csv','site_roster','85ba1842a5c020e52ea6ce0d7e6995c221da3437bf4b8745263a7cb35833ad06'),
    ('STUDY-001','Participant_Initialization.csv','participant_roster','654d3ee5e4b1fd9cfbe3d1631065029f852153a8a71cbeb9990f80a6a9c35fe0'),
    ('STUDY-002','Protocol.pdf','protocol','de0ec35b31402b5690760a59b6226105009830f6bb59682d56e75bfa2dd3ae13'),
    ('STUDY-002','ICF.pdf','icf','0ed50eed03ad0ad022b19fed05202d0c774cda353c3f56d2a0f709a544c6a049'),
    ('STUDY-002','Schedule_of_Activities.pdf','schedule_of_activities','b430da1d1772901308af79f7da72000fb314722493cf7f923d5f5d4b1b545b75'),
    ('STUDY-002','Patient_Questionnaire_ePRO.pdf','epro','82b4c9b9108243fd640731c5261791456831994b0b83447b04058491feac1193'),
    ('STUDY-002','Site_Roster.csv','site_roster','2f4705209dc0cff53a230329bbb4356b6f34d73cb62ea4498588189909522031'),
    ('STUDY-002','Participant_Initialization.csv','participant_roster','116d78af1b989f65340c1c9488a32a36987d234348c5243da43f70880eab59bf'),
    ('STUDY-003','Protocol.pdf','protocol','cd351207fa74b4a104e40a42a759ca65cb4d56835d4bafdd7ba7d3a4fb837e2c'),
    ('STUDY-003','ICF.pdf','icf','533e171c341945b65eb43cc7b055f407c216c78eaa6868aa3afb668eabb0dd73'),
    ('STUDY-003','Schedule_of_Activities.pdf','schedule_of_activities','89912ca06ab74d71014dde9d051bf4dbcf0604cd1743d9f989ff3bf6034c535f'),
    ('STUDY-003','Patient_Questionnaire_ePRO.pdf','epro','5d7aef7fc571c4ddb0d2b7908113c054c4bc4d8e0916c09665f4b1b2fedb46f1'),
    ('STUDY-003','Site_Roster.csv','site_roster','962c8fe092e56cba2703e881afbfcc204a5bb90ac1a58953c9557a031dab7f11'),
    ('STUDY-003','Participant_Initialization.csv','participant_roster','8dd3adc58d32da272abe2184e8bba60af00998a80ba2ea41cb4f199c94cccb90'),
    ('STUDY-004','Protocol.pdf','protocol','a6cfc6497e8004c3b03deddd007b3769343a2795f55990be44391281a2546ea5'),
    ('STUDY-004','ICF.pdf','icf','946814e8c34e81c79d6e83dc40d75ffe0fad166713c99dd8521fe60f55f27e68'),
    ('STUDY-004','Schedule_of_Activities.pdf','schedule_of_activities','a63c31ac9101203f89c1d77e6d3ef385f3637cb15b8f86798dc019fe5ff6cf1c'),
    ('STUDY-004','Patient_Questionnaire_ePRO.pdf','epro','4dce97d17124c07c6733a9a6556ca4a9b15960916146ffdbffb1ca6fa8ff5de0'),
    ('STUDY-004','Site_Roster.csv','site_roster','e84224a82f9a50b6d885ff101b1c9080641eaca87dccfa56846b2a73aec97bee'),
    ('STUDY-004','Participant_Initialization.csv','participant_roster','811376fcbebcfd5501d40f9aedd8f2af88c5464e4ff078fe53785318330fb452'),
    ('STUDY-005','Protocol.pdf','protocol','12a9e85e6c2fb537dfa9ada497ed55cbe9da6d1c220f24ef7e33ac45f6a0b115'),
    ('STUDY-005','ICF.pdf','icf','5e87f0f9468bcb6f11acc9db88edc2bf81bee9690388ba4bf109fc35f78849d8'),
    ('STUDY-005','Schedule_of_Activities.pdf','schedule_of_activities','84fe3bfe43fc38c8fe3f2644190ec5624a3f063add552ae464adff8386a477de'),
    ('STUDY-005','Patient_Questionnaire_ePRO.pdf','epro','987d237dadf249baf032fdf798b63186a469af1710659ce3ab043ac8d997f387'),
    ('STUDY-005','Site_Roster.csv','site_roster','9069c310a08cd69f873f1b6a7bec4f5ac4379610725c6c01839f86a8e62c5b10'),
    ('STUDY-005','Participant_Initialization.csv','participant_roster','cf2aebbdb38d463cbbe25029099360a5a81f67bcea4180b0c7da8f2c513ef7f5')
  ) AS f(study_code,file_name,document_type,sha256)
  JOIN ct_study s USING (study_code);

  -- The master ICF says each site's form adds local contacts. Those site versions
  -- (all_sites.csv local_icf_version) are not in the package, so they have no hash.
  INSERT INTO ct_doc
  SELECT pg_temp.ct_id('document/'||t.study_code||'/'||t.site_code||'/icf'), t.study_code, t.study_id, t.site_id,
    'icf', t.local_icf, 'ICF_'||t.local_icf||'.pdf',
    'generated://site-icf/'||t.study_code||'/'||t.site_code||'/ICF_'||t.local_icf||'.pdf', NULL,
    t.manager_user, t.pi_user, pg_temp.ct_at(-70+t.k,'10:00'), pg_temp.ct_at(-69+t.k,'14:00')
  FROM ct_site t;

  INSERT INTO public.study_documents(id, study_id, site_id, document_type, version, file_name, storage_uri, sha256,
    is_current, review_status, uploaded_by, reviewed_by, reviewed_at, uploaded_at)
  SELECT doc_id, study_id, site_id, document_type, version, file_name, storage_uri, sha256,
    TRUE, 'approved', uploaded_by, reviewed_by, reviewed_at, uploaded_at
  FROM ct_doc;

  -- First-pass parser output for three protocols cut the title at the PDF line wrap.
  INSERT INTO public.document_extractions(id, study_id, source_document_id, extractor, proposed_data, status,
    reviewed_by, reviewed_at, review_notes, created_at)
  SELECT pg_temp.ct_id('extraction/'||s.study_code||'/protocol/first-pass'), s.study_id, d.doc_id,
    'demo-document-parser/0.3',
    jsonb_set(s.cfg - 'icf_version' - 'soa_version' - 'epro_version' - 'risks', '{title}', to_jsonb(t.title)),
    'rejected', s.manager_user, pg_temp.ct_at(-74+s.k,'11:00'),
    'Title truncated at a PDF line break. Re-run with parser 0.4.', d.uploaded_at + interval '10 minutes'
  FROM ct_study s
  JOIN ct_doc d ON d.study_code=s.study_code AND d.site_id IS NULL AND d.document_type='protocol'
  JOIN (VALUES
    ('STUDY-003','A Randomized Study of a Digital CBT Program for'),
    ('STUDY-004','A Phase II Study of ONC-440 in Mutation-Positive Solid'),
    ('STUDY-005','Remote Blood Pressure Monitoring Study in Adults With')
  ) AS t(study_code,title) ON t.study_code=s.study_code;

  INSERT INTO public.document_extractions(id, study_id, source_document_id, extractor, proposed_data, status,
    reviewed_by, reviewed_at, review_notes, created_at)
  SELECT pg_temp.ct_id('extraction/'||s.study_code||'/'||d.document_type), s.study_id, d.doc_id,
    'demo-document-parser/0.4',
    CASE d.document_type
      WHEN 'protocol' THEN s.cfg - 'icf_version' - 'soa_version' - 'epro_version' - 'risks'
      WHEN 'icf' THEN jsonb_build_object(
        'study_id', s.cfg->'study_id', 'protocol_id', s.cfg->'protocol_id', 'title', s.cfg->'title',
        'icf_version', s.cfg->'icf_version', 'intervention', s.cfg->'intervention',
        'duration_weeks', s.cfg->'duration_weeks',
        'collected_measures', (SELECT jsonb_agg(e.item->0 ORDER BY e.ord)
                               FROM jsonb_array_elements(s.cfg->'measures') WITH ORDINALITY e(item,ord)),
        'risks', s.cfg->'risks', 'participation_voluntary', TRUE, 'electronic_communication', TRUE,
        'site_versions', (SELECT jsonb_agg(t.local_icf ORDER BY t.site_code) FROM ct_site t WHERE t.study_code=s.study_code))
      WHEN 'schedule_of_activities' THEN jsonb_build_object(
        'study_id', s.cfg->'study_id', 'soa_version', s.cfg->'soa_version', 'visits', to_jsonb(s.soa_visits),
        'study_activities', '["Eligibility review","Informed consent","Medical history","Randomization / arm assignment","Adverse event review","Concomitant medication review"]'::jsonb,
        'measures', (SELECT jsonb_agg(jsonb_build_object('name', m.label, 'frequency', m.frequency_text,
                       'source', m.source_text) ORDER BY m.field_id) FROM ct_measure m WHERE m.study_code=s.study_code))
      ELSE jsonb_build_object(
        'study_id', s.cfg->'study_id', 'epro_version', s.cfg->'epro_version',
        'items', (SELECT jsonb_agg(jsonb_build_object('field_id', m.field_id, 'prompt', m.prompt,
                    'response_type', m.response_type, 'frequency', m.frequency_text, 'source', m.source_text)
                    ORDER BY m.field_id) FROM ct_measure m WHERE m.study_code=s.study_code))
    END,
    'approved', s.manager_user, pg_temp.ct_at(-72+s.k,'16:00'),
    'Checked against the source PDF and approved for study configuration.',
    CASE WHEN d.document_type='protocol' AND s.study_code IN ('STUDY-003','STUDY-004','STUDY-005')
      THEN pg_temp.ct_at(-74+s.k,'13:00') ELSE d.uploaded_at + interval '10 minutes' END
  FROM ct_study s
  JOIN ct_doc d ON d.study_code=s.study_code AND d.site_id IS NULL
    AND d.document_type IN ('protocol','icf','schedule_of_activities','epro');

  UPDATE public.studies st SET status='active', approved_by=s.manager_user, approved_at=pg_temp.ct_at(-66+s.k,'15:00')
  FROM ct_study s WHERE st.id=s.study_id;

  ---------------------------------------------------------------------------
  -- Approved configuration: arms, eligibility, consent forms, measures, schedules, rules.
  ---------------------------------------------------------------------------
  INSERT INTO public.study_arms(id, study_id, arm_code, name, description, intervention_name, dose, frequency,
    is_control, created_at)
  SELECT a.arm_id, s.study_id, a.arm_code, a.name, 'Protocol section 3 (Study Arms).', a.intervention_name, a.dose,
    a.frequency, a.is_control, pg_temp.ct_at(-72+s.k,'17:00')
  FROM ct_arm a JOIN ct_study s USING (study_code);

  INSERT INTO public.eligibility_rules(id, study_id, source_document_id, rule_type, description, field_name,
    operator, rule_value, sort_order)
  SELECT pg_temp.ct_id('eligibility/'||s.study_code||'/'||e.rule_type||'/'||e.ord), s.study_id, d.doc_id,
    e.rule_type, e.description, m.field_name, m.operator, m.rule_value::jsonb, e.sort_order
  FROM ct_study s
  CROSS JOIN LATERAL (
    SELECT 'inclusion' AS rule_type, i.description, i.ord, i.ord::integer AS sort_order
      FROM jsonb_array_elements_text(s.cfg->'inclusion') WITH ORDINALITY i(description,ord)
    UNION ALL
    SELECT 'exclusion', x.description, x.ord, 100 + x.ord::integer
      FROM jsonb_array_elements_text(s.cfg->'exclusion') WITH ORDINALITY x(description,ord)
  ) e
  JOIN ct_doc d ON d.study_code=s.study_code AND d.site_id IS NULL AND d.document_type='protocol'
  -- Only criteria with an explicit number are machine-checkable; the rest stay manual.
  LEFT JOIN (VALUES
    ('Age 18-65 years','age_years','between','[18,65]'),
    ('At least 4 migraine days/month during screening','screening_migraine_days_per_month','>=','4'),
    ('Age 18-75 years','age_years','between','[18,75]'),
    ('HbA1c 7.5%-10.5% at screening','screening_hba1c_percent','between','[7.5,10.5]'),
    ('Age 18-70 years','age_years','between','[18,70]'),
    ('Age 18 years or older','age_years','>=','18'),
    ('Age 30-80 years','age_years','between','[30,80]')
  ) AS m(description,field_name,operator,rule_value) ON m.description=e.description;

  INSERT INTO public.consent_documents(id, study_id, site_id, source_document_id, document_name, version,
    effective_date, requires_reconsent, is_active, created_at)
  SELECT pg_temp.ct_id('consent/'||t.site_code), t.study_id, t.site_id, d.doc_id,
    'Informed Consent Form - '||t.institution, t.local_icf, v_today - 66 + t.k, FALSE, TRUE,
    pg_temp.ct_at(-68+t.k,'10:00')
  FROM ct_site t JOIN ct_doc d ON d.site_id=t.site_id AND d.document_type='icf';

  INSERT INTO public.measure_definitions(id, study_id, source_document_id, measure_code, label, prompt, data_type,
    unit, min_value, max_value, choices, source_type, required, is_active, created_at)
  SELECT m.measure_id, m.study_id, d.doc_id, m.measure_code, m.label, m.prompt, m.data_type, m.unit,
    m.min_value, m.max_value, m.choices, m.source_type, TRUE, TRUE, pg_temp.ct_at(-72+m.k,'17:00')
  FROM ct_measure m JOIN ct_doc d ON d.study_code=m.study_code AND d.site_id IS NULL AND d.document_type='epro';

  INSERT INTO public.assessment_schedules(id, study_id, measure_id, schedule_code, frequency, anchor_event,
    start_day, end_day, times_of_day, weekdays, study_days, grace_period_minutes, is_active, created_at)
  SELECT schedule_id, study_id, measure_id, measure_code, sched_frequency, 'activation', 0, end_day, times,
    weekdays, study_days, grace, TRUE, pg_temp.ct_at(-72+k,'17:00')
  FROM ct_measure;

  CREATE TEMP TABLE ct_rule ON COMMIT DROP AS
  SELECT s.study_code, s.study_id, s.k, s.manager_user, v.rule_code, v.name, v.rule_type, v.measure_code,
    v.condition::jsonb || jsonb_build_object('basis',
      'Demo threshold. Protocol section 8 calls for predefined safety and completeness signals but gives no values.') AS condition,
    v.severity, v.action_type, pg_temp.ct_id('rule/'||s.study_code||'/'||v.rule_code) AS rule_id
  FROM (VALUES
    ('*','CONSENT_OVERDUE_7D','Consent invitation unsigned after 7 days','consent_overdue',NULL,'{"days_since_invitation":7}','low','remind'),
    ('*','MISSED_DAILY_3D','No daily responses for 3 consecutive days','missing_assessments',NULL,'{"consecutive_days":3,"frequency":"daily","source_type":"patient_message"}','medium','notify_staff'),
    ('STUDY-001','HEADACHE_SEVERE','Severe headache reported','value_threshold','q01_headache_severity','{"op":">=","value":8}','medium','notify_staff'),
    ('STUDY-001','NAUSEA_SEVERE','Severe nausea reported','value_threshold','q03_nausea_severity','{"op":">=","value":8}','medium','notify_staff'),
    ('STUDY-002','GLUCOSE_LOW','Low fasting glucose','value_threshold','q01_fasting_glucose','{"op":"<","value":70}','high','notify_staff'),
    ('STUDY-002','HYPOGLYCEMIA_SYMPTOMS','Hypoglycemia symptoms reported','safety_review','q03_hypoglycemia_symptoms','{"op":"is_true"}','high','require_review'),
    ('STUDY-003','SAFETY_SCREEN_POSITIVE','Positive weekly safety screen','safety_review','q04_safety_screening','{"op":"is_true"}','critical','require_review'),
    ('STUDY-003','MOOD_LOW','Very low daily mood score','value_threshold','q01_daily_mood_score','{"op":"<=","value":2}','medium','notify_staff'),
    ('STUDY-004','FEVER','Temperature at or above 100.4 F','value_threshold','q03_temperature','{"op":">=","value":100.4}','high','notify_staff'),
    ('STUDY-004','FATIGUE_SEVERE','Severe fatigue reported','value_threshold','q01_fatigue_severity','{"op":">=","value":8}','medium','notify_staff'),
    ('STUDY-004','NEW_SYMPTOM_REPORTED','New symptom reported','safety_review','q04_new_symptoms','{"op":"text_not_in","values":["none","no","no new symptoms","nothing new"]}','medium','require_review'),
    ('STUDY-005','SYSTOLIC_HIGH','Home systolic BP at or above 180 mmHg','value_threshold','q01_systolic_bp','{"op":">=","value":180}','high','notify_staff'),
    ('STUDY-005','DIASTOLIC_HIGH','Home diastolic BP at or above 120 mmHg','value_threshold','q02_diastolic_bp','{"op":">=","value":120}','high','notify_staff'),
    ('STUDY-005','SYMPTOM_REPORTED','Symptom reported','safety_review','q05_symptoms','{"op":"text_not_in","values":["none","no","no new symptoms","nothing new"]}','medium','require_review')
  ) AS v(scope,rule_code,name,rule_type,measure_code,condition,severity,action_type)
  JOIN ct_study s ON v.scope IN ('*', s.study_code);

  INSERT INTO public.alert_rules(id, study_id, measure_id, source_document_id, rule_code, name, rule_type,
    condition, severity, action_type, enabled, approved_by, approved_at, created_at)
  SELECT cr.rule_id, cr.study_id, m.measure_id, d.doc_id, cr.rule_code, cr.name, cr.rule_type, cr.condition, cr.severity,
    cr.action_type, TRUE, cr.manager_user, pg_temp.ct_at(-67+cr.k,'11:00'), pg_temp.ct_at(-72+cr.k,'17:30')
  FROM ct_rule cr
  JOIN ct_doc d ON d.study_code=cr.study_code AND d.site_id IS NULL AND d.document_type='protocol'
  LEFT JOIN ct_measure m ON m.study_code=cr.study_code AND m.measure_code=cr.measure_code;

  ---------------------------------------------------------------------------
  -- Participants: all_participants_initial.csv plus each person's demo storyline.
  -- Every roster row is Eligible, consent_pending, opted in. Day columns are
  -- offsets from the load day; NULL means the step has not happened.
  ---------------------------------------------------------------------------
  CREATE TEMP TABLE ct_participant ON COMMIT DROP AS
  SELECT v.code, v.study_code, v.site_code, v.preferred_name, v.phone, v.final_status, v.revoke_consent,
    v.adherence::numeric AS adherence, v.silent_from, v.withdrawal_reason,
    pg_temp.ct_id('participant/'||v.code) AS participant_id, s.study_id, t.site_id, t.institution, t.coordinator,
    t.local_icf, t.pi_user, t.coord_user, t.pi_assign, t.coord_assign, s.manager_user, s.short_name,
    s.cfg->>'title' AS title, s.cfg->>'design' AS design,
    pg_temp.ct_id('consent/'||v.site_code) AS consent_document_id,
    pg_temp.ct_id('thread/'||v.code) AS thread_id,
    pg_temp.ct_at(s.roster_d,'09:30') AS created_at,
    pg_temp.ct_at(v.invite_d,'09:00') + floor(pg_temp.ct_u(v.code||'/invite')*50) * interval '1 minute' AS invite_at,
    pg_temp.ct_at(v.opened_d,'11:30') + floor(pg_temp.ct_u(v.code||'/open')*30) * interval '1 minute' AS opened_at,
    pg_temp.ct_at(v.signed_d,'14:00') + floor(pg_temp.ct_u(v.code||'/sign')*45) * interval '1 minute' AS signed_at,
    pg_temp.ct_at(v.declined_d,'16:00') AS declined_at,
    pg_temp.ct_at(v.enrolled_d,'11:00') + floor(pg_temp.ct_u(v.code||'/enroll')*30) * interval '1 minute' AS enrolled_at,
    pg_temp.ct_at(v.activated_d,'10:00') + floor(pg_temp.ct_u(v.code||'/activate')*20) * interval '1 minute' AS activated_at,
    pg_temp.ct_at(v.withdrawn_d,'16:30') AS withdrawn_at,
    NULL::uuid AS arm_id, NULL::text AS arm_code
  FROM (VALUES
    ('STUDY-001-P001','STUDY-001','SITE-001-A','Candidate 01','+1-617-555-1100','active',-42,-42,-41,NULL,-39,-37,NULL,FALSE,0.96,NULL,NULL),
    ('STUDY-001-P002','STUDY-001','SITE-001-B','Candidate 02','+1-617-555-1101','active',-40,-39,-38,NULL,-36,-34,NULL,FALSE,0.88,NULL,NULL),
    ('STUDY-001-P003','STUDY-001','SITE-001-A','Candidate 03','+1-617-555-1102','active',-35,-34,-33,NULL,-30,-28,NULL,FALSE,0.86,-4,NULL),
    ('STUDY-001-P004','STUDY-001','SITE-001-B','Candidate 04','+1-617-555-1103','active',-28,-28,-27,NULL,-24,-21,NULL,FALSE,0.93,NULL,NULL),
    ('STUDY-001-P005','STUDY-001','SITE-001-A','Candidate 05','+1-617-555-1104','enrolled',-10,-10,-8,NULL,-2,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-001-P006','STUDY-001','SITE-001-B','Candidate 06','+1-617-555-1105','consented',-6,-5,-4,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-001-P007','STUDY-001','SITE-001-A','Candidate 07','+1-617-555-1106','consent_pending',-12,-11,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-001-P008','STUDY-001','SITE-001-B','Candidate 08','+1-617-555-1107','withdrawn',-38,-38,-37,NULL,-35,-33,-19,TRUE,0.80,NULL,'participant_withdrew_consent'),
    ('STUDY-002-P001','STUDY-002','SITE-002-A','Candidate 01','+1-617-555-1200','active',-46,-46,-45,NULL,-43,-40,NULL,FALSE,0.95,NULL,NULL),
    ('STUDY-002-P002','STUDY-002','SITE-002-B','Candidate 02','+1-617-555-1201','active',-38,-37,-36,NULL,-35,-33,NULL,FALSE,0.82,NULL,NULL),
    ('STUDY-002-P003','STUDY-002','SITE-002-A','Candidate 03','+1-617-555-1202','active',-31,-30,-29,NULL,-28,-26,NULL,FALSE,0.90,NULL,NULL),
    ('STUDY-002-P004','STUDY-002','SITE-002-B','Candidate 04','+1-617-555-1203','consent_pending',-3,-3,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-002-P005','STUDY-002','SITE-002-A','Candidate 05','+1-617-555-1204','enrolled',-9,-8,-6,NULL,-1,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-002-P006','STUDY-002','SITE-002-B','Candidate 06','+1-617-555-1205','consented',-5,-4,-2,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-002-P007','STUDY-002','SITE-002-A','Candidate 07','+1-617-555-1206','consent_pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-002-P008','STUDY-002','SITE-002-B','Candidate 08','+1-617-555-1207','withdrawn',-36,-35,-34,NULL,-32,-30,-12,FALSE,0.85,NULL,'relocating_outside_study_area'),
    ('STUDY-003-P001','STUDY-003','SITE-003-A','Candidate 01','+1-617-555-1300','active',-40,-40,-39,NULL,-37,-35,NULL,FALSE,0.94,NULL,NULL),
    ('STUDY-003-P002','STUDY-003','SITE-003-B','Candidate 02','+1-617-555-1301','active',-36,-35,-34,NULL,-32,-30,NULL,FALSE,0.90,NULL,NULL),
    ('STUDY-003-P003','STUDY-003','SITE-003-A','Candidate 03','+1-617-555-1302','active',-29,-29,-28,NULL,-26,-24,NULL,FALSE,0.84,NULL,NULL),
    ('STUDY-003-P004','STUDY-003','SITE-003-B','Candidate 04','+1-617-555-1303','active',-21,-20,-20,NULL,-18,-16,NULL,FALSE,0.90,NULL,NULL),
    ('STUDY-003-P005','STUDY-003','SITE-003-A','Candidate 05','+1-617-555-1304','active',-14,-14,-13,NULL,-11,-9,NULL,FALSE,0.97,NULL,NULL),
    ('STUDY-003-P006','STUDY-003','SITE-003-B','Candidate 06','+1-617-555-1305','consented',-3,-2,-1,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-003-P007','STUDY-003','SITE-003-A','Candidate 07','+1-617-555-1306','consent_pending',-9,NULL,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-003-P008','STUDY-003','SITE-003-B','Candidate 08','+1-617-555-1307','withdrawn',-20,-19,NULL,-18,NULL,NULL,-18,FALSE,NULL,NULL,'declined_consent'),
    ('STUDY-004-P001','STUDY-004','SITE-004-A','Candidate 01','+1-617-555-1400','active',-43,-42,-42,NULL,-40,-38,NULL,FALSE,0.95,NULL,NULL),
    ('STUDY-004-P002','STUDY-004','SITE-004-B','Candidate 02','+1-617-555-1401','active',-36,-36,-35,NULL,-33,-31,NULL,FALSE,0.92,NULL,NULL),
    ('STUDY-004-P003','STUDY-004','SITE-004-A','Candidate 03','+1-617-555-1402','active',-22,-21,-20,NULL,-19,-17,NULL,FALSE,0.88,-3,NULL),
    ('STUDY-004-P004','STUDY-004','SITE-004-B','Candidate 04','+1-617-555-1403','enrolled',-8,-8,-7,NULL,-3,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-004-P005','STUDY-004','SITE-004-A','Candidate 05','+1-617-555-1404','enrolled',-6,-5,-4,NULL,-1,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-004-P006','STUDY-004','SITE-004-B','Candidate 06','+1-617-555-1405','consented',-5,-5,-3,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-004-P007','STUDY-004','SITE-004-A','Candidate 07','+1-617-555-1406','consent_pending',-4,-4,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-004-P008','STUDY-004','SITE-004-B','Candidate 08','+1-617-555-1407','consent_pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-005-P001','STUDY-005','SITE-005-A','Candidate 01','+1-617-555-1500','active',-41,-41,-40,NULL,-38,-36,NULL,FALSE,0.95,NULL,NULL),
    ('STUDY-005-P002','STUDY-005','SITE-005-B','Candidate 02','+1-617-555-1501','active',-34,-33,-32,NULL,-31,-29,NULL,FALSE,0.90,NULL,NULL),
    ('STUDY-005-P003','STUDY-005','SITE-005-A','Candidate 03','+1-617-555-1502','active',-27,-27,-26,NULL,-24,-22,NULL,FALSE,0.80,NULL,NULL),
    ('STUDY-005-P004','STUDY-005','SITE-005-B','Candidate 04','+1-617-555-1503','active',-17,-16,-15,NULL,-14,-12,NULL,FALSE,0.96,NULL,NULL),
    ('STUDY-005-P005','STUDY-005','SITE-005-A','Candidate 05','+1-617-555-1504','enrolled',-7,-6,-5,NULL,-2,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-005-P006','STUDY-005','SITE-005-B','Candidate 06','+1-617-555-1505','consent_pending',-15,-14,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-005-P007','STUDY-005','SITE-005-A','Candidate 07','+1-617-555-1506','consent_pending',-1,NULL,NULL,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL),
    ('STUDY-005-P008','STUDY-005','SITE-005-B','Candidate 08','+1-617-555-1507','withdrawn',-23,-22,-20,NULL,-18,NULL,-14,FALSE,NULL,NULL,'unable_to_use_home_bp_cuff')
  ) AS v(code,study_code,site_code,preferred_name,phone,final_status,invite_d,opened_d,signed_d,declined_d,
         enrolled_d,activated_d,withdrawn_d,revoke_consent,adherence,silent_from,withdrawal_reason)
  JOIN ct_study s USING (study_code)
  JOIN ct_site t ON t.site_code=v.site_code AND t.study_code=v.study_code;

  IF (SELECT count(*) FROM ct_participant) <> 40 THEN
    RAISE EXCEPTION 'Expected 40 roster participants';
  END IF;

  -- Randomized at the baseline visit, alternating arms in activation order.
  UPDATE ct_participant p SET arm_id=x.arm_id, arm_code=x.arm_code
  FROM (
    SELECT q.code, a.arm_id, a.arm_code
    FROM (SELECT code, study_code, row_number() OVER (PARTITION BY study_code ORDER BY activated_at, code) AS rn
          FROM ct_participant WHERE activated_at IS NOT NULL) q
    JOIN LATERAL (
      SELECT z.arm_id, z.arm_code FROM (
        SELECT arm_id, arm_code, row_number() OVER (ORDER BY is_control, arm_code) - 1 AS idx, count(*) OVER () AS n
        FROM ct_arm WHERE study_code=q.study_code) z
      WHERE z.idx = (q.rn - 1) % z.n) a ON TRUE
  ) x WHERE x.code=p.code;

  FOR r IN SELECT * FROM ct_participant ORDER BY created_at, code LOOP
    PERFORM set_config('ct_seed.occurred_at', r.created_at::text, TRUE);
    INSERT INTO public.participants(id, study_id, site_id, participant_code, status, eligibility_status, time_zone,
      status_changed_by, is_synthetic, created_at, updated_at)
    VALUES (r.participant_id, r.study_id, r.site_id, r.code, 'consent_pending', 'eligible', 'America/New_York',
      r.manager_user, TRUE, r.created_at, r.created_at);
  END LOOP;

  INSERT INTO private.participant_contacts(id, study_id, participant_id, preferred_name, phone_number,
    preferred_channel, messaging_opt_in, opted_in_at, created_at, updated_at)
  SELECT pg_temp.ct_id('contact/'||code), study_id, participant_id, preferred_name,
    regexp_replace(phone, '[^0-9+]', '', 'g'), 'sms', TRUE, created_at, created_at, created_at
  FROM ct_participant;

  INSERT INTO public.message_threads(id, study_id, participant_id, provider, channel, external_thread_id, status, created_at)
  SELECT thread_id, study_id, participant_id, 'synthetic-sms', 'sms', 'SYN-THREAD-'||code, 'open',
    invite_at - interval '1 minute'
  FROM ct_participant WHERE invite_at IS NOT NULL;

  ---------------------------------------------------------------------------
  -- eConsent: send tasks, invitations, reminders, and consent records.
  ---------------------------------------------------------------------------
  INSERT INTO public.workflow_tasks(id, study_id, participant_id, assigned_staff_id, action_type, payload,
    deduplication_key, status, run_after, attempts, completed_at, created_at, updated_at)
  SELECT pg_temp.ct_id('task/send_consent/'||code), study_id, participant_id, coord_assign, 'send_consent',
    jsonb_build_object('consent_document_id', consent_document_id, 'consent_version', local_icf),
    'send_consent:'||code,
    CASE WHEN invite_at IS NULL THEN 'pending' ELSE 'completed' END,
    coalesce(invite_at - interval '1 minute', pg_temp.ct_at(1,'09:00')),
    CASE WHEN invite_at IS NULL THEN 0 ELSE 1 END,
    invite_at,
    coalesce(invite_at - interval '5 minutes', pg_temp.ct_at(-1,'16:00')),
    coalesce(invite_at, pg_temp.ct_at(-1,'16:00'))
  FROM ct_participant WHERE final_status <> 'withdrawn' OR invite_at IS NOT NULL;

  CREATE TEMP TABLE ct_consent_reminder ON COMMIT DROP AS
  SELECT p.*, v.d AS reminder_d, pg_temp.ct_at(v.d,'10:30') AS reminder_at
  FROM (VALUES ('STUDY-001-P007',-5),('STUDY-005-P006',-8),('STUDY-005-P006',-3)) AS v(code,d)
  JOIN ct_participant p USING (code);

  INSERT INTO public.workflow_tasks(id, study_id, participant_id, rule_id, assigned_staff_id, action_type, payload,
    deduplication_key, status, run_after, attempts, completed_at, created_at, updated_at)
  SELECT pg_temp.ct_id('task/consent_reminder/'||c.code||'/'||c.reminder_d), c.study_id, c.participant_id,
    pg_temp.ct_id('rule/'||c.study_code||'/CONSENT_OVERDUE_7D'), c.coord_assign, 'send_reminder',
    jsonb_build_object('consent_document_id', c.consent_document_id), 'consent_reminder:'||c.code||':'||c.reminder_d,
    'completed', c.reminder_at - interval '1 minute', 1, c.reminder_at, c.reminder_at - interval '5 minutes', c.reminder_at
  FROM ct_consent_reminder c;

  -- Overdue and unopened; the coordinator scheduled outreach for tomorrow morning.
  INSERT INTO public.workflow_tasks(id, study_id, participant_id, rule_id, assigned_staff_id, action_type, payload,
    deduplication_key, status, run_after, created_at, updated_at)
  SELECT pg_temp.ct_id('task/consent_reminder/'||code||'/next'), study_id, participant_id,
    pg_temp.ct_id('rule/'||study_code||'/CONSENT_OVERDUE_7D'), coord_assign, 'send_reminder',
    jsonb_build_object('consent_document_id', consent_document_id), 'consent_reminder:'||code||':next',
    'pending', pg_temp.ct_at(1,'10:00'), pg_temp.ct_at(-2,'10:05'), pg_temp.ct_at(-2,'10:05')
  FROM ct_participant WHERE code='STUDY-003-P007';

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, consent_document_id, workflow_task_id,
    direction, channel, provider, message_type, body, external_message_id, idempotency_key, status, sent_at,
    delivered_at, created_at)
  SELECT pg_temp.ct_id('message/consent_invitation/'||code), study_id, participant_id, thread_id,
    consent_document_id, pg_temp.ct_id('task/send_consent/'||code), 'outbound', 'sms', 'synthetic-sms',
    'consent_invitation',
    format('Hi %s, this is the study team at %s. You are invited to review the consent form (version %s) for "%s". Review and sign securely: https://consent.example.org/s/%s. Reply STOP to opt out.',
      preferred_name, institution, local_icf, title, substr(md5('consent-link/'||code),1,12)),
    'SYN-'||upper(substr(md5('consent_invitation/'||code),1,20)), 'consent_invitation:'||code, 'delivered',
    invite_at, invite_at + interval '6 seconds', invite_at - interval '1 second'
  FROM ct_participant WHERE invite_at IS NOT NULL;

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, consent_document_id, workflow_task_id,
    direction, channel, provider, message_type, body, external_message_id, idempotency_key, status, sent_at,
    delivered_at, created_at)
  SELECT pg_temp.ct_id('message/consent_reminder/'||code||'/'||reminder_d), study_id, participant_id, thread_id,
    consent_document_id, pg_temp.ct_id('task/consent_reminder/'||code||'/'||reminder_d), 'outbound', 'sms',
    'synthetic-sms', 'consent_reminder',
    format('Hi %s, a reminder from %s: your consent form for the %s is ready when you are: https://consent.example.org/s/%s. Reply here with any questions.',
      preferred_name, institution, short_name, substr(md5('consent-link/'||code),1,12)),
    'SYN-'||upper(substr(md5('consent_reminder/'||code||'/'||reminder_d),1,20)),
    'consent_reminder:'||code||':'||reminder_d, 'delivered', reminder_at, reminder_at + interval '5 seconds',
    reminder_at - interval '1 second'
  FROM ct_consent_reminder;

  INSERT INTO public.participant_consents(id, study_id, participant_id, consent_document_id, status, presented_at,
    opened_at, signed_at, declined_at, signed_by, person_obtaining_consent_id, copy_provided_at, audit_metadata, created_at)
  SELECT pg_temp.ct_id('participant_consent/'||code), study_id, participant_id, consent_document_id,
    CASE WHEN signed_at IS NOT NULL THEN 'signed' WHEN declined_at IS NOT NULL THEN 'declined'
         WHEN opened_at IS NOT NULL THEN 'opened' ELSE 'sent' END,
    invite_at, opened_at, signed_at, declined_at,
    CASE WHEN signed_at IS NOT NULL THEN preferred_name END,
    CASE WHEN signed_at IS NOT NULL THEN coord_user END,
    signed_at + interval '3 minutes',
    jsonb_build_object('method','remote_econsent','channel','sms_link','identity_check','synthetic_one_time_code',
      'consent_version', local_icf),
    invite_at
  FROM ct_participant WHERE invite_at IS NOT NULL;

  ---------------------------------------------------------------------------
  -- Lifecycle transitions, validated by the participant triggers.
  ---------------------------------------------------------------------------
  FOR r IN SELECT * FROM ct_participant WHERE signed_at IS NOT NULL ORDER BY signed_at LOOP
    PERFORM set_config('ct_seed.occurred_at', r.signed_at::text, TRUE);
    UPDATE public.participants SET status='consented', status_changed_by=r.coord_user WHERE id=r.participant_id;
    IF r.enrolled_at IS NOT NULL THEN
      PERFORM set_config('ct_seed.occurred_at', r.enrolled_at::text, TRUE);
      UPDATE public.participants SET status='enrolled', enrolled_at=r.enrolled_at,
        enrollment_confirmed_by=r.pi_user, status_changed_by=r.pi_user WHERE id=r.participant_id;
    END IF;
    IF r.activated_at IS NOT NULL THEN
      PERFORM set_config('ct_seed.occurred_at', r.activated_at::text, TRUE);
      UPDATE public.participants SET status='active', activated_at=r.activated_at, assigned_arm_id=r.arm_id,
        status_changed_by=r.coord_user WHERE id=r.participant_id;
    END IF;
  END LOOP;

  INSERT INTO public.workflow_tasks(id, study_id, participant_id, assigned_staff_id, action_type, payload,
    deduplication_key, status, requires_approval, approved_by, approved_at, run_after, attempts, completed_at,
    created_at, updated_at)
  SELECT pg_temp.ct_id('task/confirm_enrollment/'||code), study_id, participant_id, pi_assign, 'confirm_enrollment',
    jsonb_build_object('eligibility_status','eligible','consent_version', local_icf),
    'confirm_enrollment:'||code,
    CASE WHEN enrolled_at IS NULL THEN 'waiting_review' ELSE 'completed' END, TRUE,
    CASE WHEN enrolled_at IS NOT NULL THEN pi_user END, enrolled_at,
    signed_at + interval '5 minutes', CASE WHEN enrolled_at IS NULL THEN 0 ELSE 1 END, enrolled_at,
    signed_at + interval '5 minutes', coalesce(enrolled_at, signed_at + interval '5 minutes')
  FROM ct_participant WHERE signed_at IS NOT NULL;

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, direction, channel, provider, message_type,
    body, external_message_id, idempotency_key, status, sent_at, delivered_at, created_at)
  SELECT pg_temp.ct_id('message/welcome/'||code), study_id, participant_id, thread_id, 'outbound', 'sms',
    'synthetic-sms', 'welcome',
    format('[%s] Welcome, %s. You are enrolled at %s. %s will contact you to schedule your baseline visit. Reply STOP to opt out of study messages.',
      short_name, preferred_name, institution, coordinator),
    'SYN-'||upper(substr(md5('welcome/'||code),1,20)), 'welcome:'||code, 'delivered',
    enrolled_at + interval '30 minutes', enrolled_at + interval '30 minutes 4 seconds',
    enrolled_at + interval '30 minutes' - interval '1 second'
  FROM ct_participant WHERE enrolled_at IS NOT NULL;

  ---------------------------------------------------------------------------
  -- Expected assessments from the approved schedules, through today.
  ---------------------------------------------------------------------------
  -- Specific events layered on top of the generated baseline data.
  CREATE TEMP TABLE ct_story ON COMMIT DROP AS
  SELECT * FROM (VALUES
    ('STUDY-001-P002','q01_headache_severity',12,NULL,NULL,'8','value','resolved'),
    ('STUDY-001-P002','q01_headache_severity',32,NULL,NULL,'8','value','acknowledged'),
    ('STUDY-001-P004','q01_headache_severity',9,NULL,NULL,'60','misparsed',NULL),
    ('STUDY-002-P002','q02_study_medication_taken',14,NULL,NULL,NULL,'failed_delivery',NULL),
    ('STUDY-002-P002','q04_weight',NULL,3,NULL,NULL,'skipped',NULL),
    ('STUDY-002-P003','q01_fasting_glucose',9,NULL,NULL,'62','value','resolved'),
    ('STUDY-002-P003','q03_hypoglycemia_symptoms',9,NULL,NULL,'true','value','resolved'),
    ('STUDY-002-P003','q01_fasting_glucose',25,NULL,NULL,'66','value','open'),
    ('STUDY-003-P002','q04_safety_screening',NULL,2,NULL,'true','value','resolved'),
    ('STUDY-003-P004','q01_daily_mood_score',14,NULL,NULL,'2','value','acknowledged'),
    ('STUDY-004-P001','q03_temperature',18,NULL,NULL,'101.2','value','resolved'),
    ('STUDY-004-P002','q04_new_symptoms',29,NULL,NULL,'Itchy rash on both forearms since yesterday','value','acknowledged'),
    ('STUDY-005-P002','q01_systolic_bp',28,NULL,1,'186','value','open'),
    ('STUDY-005-P002','q02_diastolic_bp',28,NULL,1,'104','value',NULL),
    ('STUDY-005-P003','q05_symptoms',16,NULL,NULL,'Felt dizzy when standing up this morning','value','resolved'),
    ('STUDY-005-P003',NULL,10,NULL,NULL,NULL,'device_gap',NULL),
    ('STUDY-005-P003',NULL,11,NULL,NULL,NULL,'device_gap',NULL),
    ('STUDY-005-P003',NULL,12,NULL,NULL,NULL,'device_gap',NULL)
  ) AS v(code,measure_code,d,occurrence,slot_no,value_text,kind,alert_status);

  CREATE TEMP TABLE ct_plan ON COMMIT DROP AS
  SELECT pg_temp.ct_id('assessment/'||p.code||'/'||m.measure_code||'/'||g.d||'/'||t.slot_no) AS id,
    p.code, p.study_code, p.study_id, p.participant_id, p.site_id, p.thread_id, p.institution, p.short_name,
    p.adherence, p.silent_from, p.activated_at, p.withdrawn_at, p.coord_user,
    m.measure_id, m.schedule_id, m.measure_code, m.field_id, m.label, m.prompt, m.data_type, m.unit, m.max_value,
    m.source_type, m.sched_frequency, m.grace, m.epro_version,
    g.d, t.slot_no::integer AS slot_no,
    (p.activated_at AT TIME ZONE 'America/New_York')::date + g.d AS local_day,
    CASE WHEN m.sched_frequency='custom_days' AND g.d=0 THEN p.activated_at
      ELSE ((((p.activated_at AT TIME ZONE 'America/New_York')::date + g.d) + t.slot) AT TIME ZONE 'America/New_York')
    END AS due_at
  FROM ct_participant p
  JOIN ct_measure m ON m.study_code=p.study_code
  CROSS JOIN LATERAL generate_series(0, least(m.end_day, v_today - (p.activated_at AT TIME ZONE 'America/New_York')::date)) AS g(d)
  CROSS JOIN LATERAL unnest(m.times) WITH ORDINALITY AS t(slot, slot_no)
  WHERE p.activated_at IS NOT NULL
    AND (m.sched_frequency='daily'
      OR (m.sched_frequency='weekly'
          AND extract(isodow FROM (p.activated_at AT TIME ZONE 'America/New_York')::date + g.d)::smallint = ANY(m.weekdays))
      OR (m.sched_frequency='custom_days' AND g.d = ANY(m.study_days)));

  DELETE FROM ct_plan WHERE due_at < activated_at OR due_at >= coalesce(withdrawn_at, 'infinity')
    OR due_at >= ((v_today + 1)::timestamp AT TIME ZONE 'America/New_York');

  ALTER TABLE ct_plan
    ADD COLUMN ord INTEGER, ADD COLUMN reading_key TEXT, ADD COLUMN opens_at TIMESTAMPTZ, ADD COLUMN closes_at TIMESTAMPTZ,
    ADD COLUMN silent BOOLEAN, ADD COLUMN day_off BOOLEAN, ADD COLUMN story_kind TEXT, ADD COLUMN story_value TEXT,
    ADD COLUMN alert_status TEXT, ADD COLUMN will_respond BOOLEAN, ADD COLUMN failed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN skipped BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN delay_min NUMERIC, ADD COLUMN response_at TIMESTAMPTZ,
    ADD COLUMN responded BOOLEAN, ADD COLUMN reminder_at TIMESTAMPTZ, ADD COLUMN v_num NUMERIC,
    ADD COLUMN v_bool BOOLEAN, ADD COLUMN v_text TEXT, ADD COLUMN v_json JSONB, ADD COLUMN raw TEXT;

  UPDATE ct_plan c SET ord=x.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY participant_id, measure_id ORDER BY due_at) AS rn FROM ct_plan) x
  WHERE x.id=c.id;

  UPDATE ct_plan SET
    opens_at = CASE WHEN sched_frequency='custom_days' AND d > 0 THEN due_at - interval '3 days' ELSE due_at END,
    closes_at = due_at + grace * interval '1 minute',
    -- One cuff reading produces the systolic, diastolic, and pulse values together.
    reading_key = CASE WHEN measure_code IN ('q01_systolic_bp','q02_diastolic_bp','q03_pulse')
      THEN code||'/bp/'||d||'/'||slot_no ELSE code||'/'||measure_code||'/'||d||'/'||slot_no END,
    silent = silent_from IS NOT NULL AND local_day >= v_today + silent_from,
    day_off = pg_temp.ct_u(code||'/day-off/'||d) < (1 - adherence) / 2;

  UPDATE ct_plan SET will_respond = CASE
    WHEN source_type='app_event' THEN TRUE
    WHEN silent THEN FALSE
    WHEN source_type IN ('site_visit','laboratory') THEN TRUE
    WHEN day_off THEN FALSE
    ELSE pg_temp.ct_u(reading_key||'/respond') < adherence / (1 - (1 - adherence) / 2) END;

  UPDATE ct_plan c SET story_kind=s.kind, story_value=s.value_text, alert_status=s.alert_status
  FROM ct_story s
  WHERE s.code=c.code AND (s.measure_code=c.measure_code OR (s.measure_code IS NULL AND c.source_type='device'))
    AND (s.d IS NULL OR s.d=c.d) AND (s.occurrence IS NULL OR s.occurrence=c.ord)
    AND (s.slot_no IS NULL OR s.slot_no=c.slot_no);
  SELECT count(*) INTO v_count FROM ct_story s WHERE NOT EXISTS (
    SELECT 1 FROM ct_plan c WHERE c.story_kind=s.kind AND c.code=s.code
      AND (s.measure_code=c.measure_code OR s.measure_code IS NULL) AND (s.d IS NULL OR s.d=c.d)
      AND (s.occurrence IS NULL OR s.occurrence=c.ord));
  IF v_count > 0 THEN
    RAISE EXCEPTION '% scripted demo events did not match a scheduled assessment', v_count;
  END IF;

  UPDATE ct_plan SET will_respond = story_kind IN ('value','misparsed'),
    failed = story_kind='failed_delivery', skipped = story_kind='skipped'
  WHERE story_kind IS NOT NULL;

  UPDATE ct_plan SET delay_min = CASE
    WHEN story_kind IN ('value','misparsed') THEN 8
    WHEN source_type='site_visit' THEN CASE WHEN d=0 THEN 20 ELSE 45 END
    WHEN source_type='laboratory' THEN 1560
    WHEN source_type='app_event' THEN 0
    WHEN source_type='device' THEN 1 + floor(pg_temp.ct_u(reading_key||'/delay')*20)
    WHEN pg_temp.ct_u(reading_key||'/late') < 0.8 THEN 1 + floor(pg_temp.ct_u(reading_key||'/delay')*35)
    ELSE floor(grace/2.0) + 5 + floor(pg_temp.ct_u(reading_key||'/delay')*(grace/2.0 - 15)) END;
  UPDATE ct_plan SET response_at = due_at + delay_min * interval '1 minute';
  UPDATE ct_plan SET responded = will_respond AND NOT failed AND NOT skipped AND response_at <= now()
    AND response_at < coalesce(withdrawn_at, 'infinity') AND response_at <= closes_at;
  UPDATE ct_plan SET reminder_at = due_at + (grace/2) * interval '1 minute'
  WHERE source_type IN ('patient_message','questionnaire') AND NOT failed AND NOT skipped
    AND (NOT responded OR response_at > due_at + (grace/2) * interval '1 minute')
    AND due_at + (grace/2) * interval '1 minute' <= now()
    AND due_at + (grace/2) * interval '1 minute' < coalesce(withdrawn_at, 'infinity');

  -- Baseline values sit below every alert threshold; only scripted events cross one.
  UPDATE ct_plan c SET
    v_num = CASE c.measure_code
      WHEN 'q01_headache_severity' THEN round(greatest(0, least(7, 2 + 3*h.pu + (h.nu-0.5)*4 - 0.03*c.d))::numeric)
      WHEN 'q03_nausea_severity' THEN round(greatest(0, least(5, 0.5 + 2*h.pu + (h.nu-0.5)*3))::numeric)
      WHEN 'q04_migraine_days' THEN round(greatest(0, least(4, 1 + 2*h.pu + (h.nu-0.5)*2 - 0.02*c.d))::numeric)
      WHEN 'q01_fasting_glucose' THEN round(greatest(100, least(230, 140 + 60*h.pu + (h.nu-0.5)*40 - 0.4*c.d))::numeric)
      WHEN 'q04_weight' THEN round((70 + 40*h.pu + (h.nu-0.5)*1.2 - 0.03*c.d)::numeric, 1)
      WHEN 'q05_hba1c' THEN round((7.6 + 2.6*h.pu)::numeric, 1)
      WHEN 'q01_daily_mood_score' THEN round(greatest(3, least(9, 4 + 3*h.pu + (h.nu-0.5)*3 + 0.03*c.d))::numeric)
      WHEN 'q02_sleep_duration' THEN round(greatest(4, least(9.5, 5.5 + 2*h.pu + (h.nu-0.5)*2))::numeric, 1)
      WHEN 'q05_depression_symptom_scale' THEN round(greatest(4, 14 + 6*h.pu - c.d/28.0*2.5 + (h.nu-0.5)*2)::numeric)
      WHEN 'q01_fatigue_severity' THEN round(greatest(0, least(7, 2.5 + 2.5*h.pu + (h.nu-0.5)*3))::numeric)
      WHEN 'q03_temperature' THEN round(greatest(97.0, least(99.6, 97.8 + 0.8*h.pu + (h.nu-0.5)*1.0))::numeric, 1)
      WHEN 'q01_systolic_bp' THEN round(greatest(110, least(172, 132 + 16*h.pu + (h.nu-0.5)*14 - 0.15*c.d))::numeric)
      WHEN 'q02_diastolic_bp' THEN round(greatest(65, least(104, 80 + 10*h.pu + (h.nu2-0.5)*10))::numeric)
      WHEN 'q03_pulse' THEN round(greatest(52, least(96, 64 + 16*h.pu + (h.nu3-0.5)*12))::numeric)
    END,
    v_bool = CASE c.measure_code
      WHEN 'q02_study_medication_taken' THEN h.nu < 0.95
      WHEN 'q04_bp_medication_taken' THEN h.nu < 0.95
      WHEN 'q03_hypoglycemia_symptoms' THEN FALSE
      WHEN 'q04_safety_screening' THEN FALSE
      WHEN 'q03_cbt_module_completion' THEN NOT c.silent AND NOT c.day_off
        AND pg_temp.ct_u(c.reading_key||'/respond') < c.adherence
    END,
    v_text = CASE c.measure_code
      WHEN 'q04_new_symptoms' THEN (ARRAY['None','None','No new symptoms','none','Nothing new'])[1 + floor(h.nu*5)::integer]
      WHEN 'q05_symptoms' THEN (ARRAY['None','None','No new symptoms','none','Nothing new'])[1 + floor(h.nu*5)::integer]
      WHEN 'q05_tumor_imaging' THEN CASE WHEN c.d=0 THEN 'baseline_documented' ELSE 'SD' END
    END,
    v_json = CASE c.measure_code
      WHEN 'q05_vital_signs' THEN jsonb_build_object(
        'systolic', round(112 + 20*h.pu + (h.nu-0.5)*10)::integer,
        'diastolic', round(70 + 12*h.pu + (h.nu2-0.5)*8)::integer,
        'heart_rate', round(62 + 18*h.pu + (h.nu3-0.5)*10)::integer)
    END
  FROM (SELECT id, pg_temp.ct_u(code||'/baseline/'||measure_code) AS pu, pg_temp.ct_u(reading_key||'/v1') AS nu,
          pg_temp.ct_u(reading_key||'/v2') AS nu2, pg_temp.ct_u(reading_key||'/v3') AS nu3 FROM ct_plan) h
  WHERE h.id=c.id;

  UPDATE ct_plan SET
    v_num = CASE WHEN data_type IN ('numeric','integer') THEN story_value::numeric ELSE v_num END,
    v_bool = CASE WHEN data_type='boolean' THEN story_value::boolean ELSE v_bool END,
    v_text = CASE WHEN data_type IN ('text','choice') THEN story_value ELSE v_text END
  WHERE story_value IS NOT NULL;

  UPDATE ct_plan SET raw = CASE
    WHEN source_type='app_event' THEN NULL
    WHEN data_type='boolean' THEN CASE WHEN v_bool
      THEN (ARRAY['Yes','yes','Y','YES'])[1 + floor(pg_temp.ct_u(reading_key||'/raw')*4)::integer]
      ELSE (ARRAY['No','no','N','NO'])[1 + floor(pg_temp.ct_u(reading_key||'/raw')*4)::integer] END
    WHEN data_type='json' THEN format('BP %s/%s mmHg, HR %s bpm', v_json->>'systolic', v_json->>'diastolic', v_json->>'heart_rate')
    WHEN data_type IN ('text','choice') THEN v_text
    ELSE trim_scale(v_num)::text END;

  INSERT INTO public.scheduled_assessments(id, study_id, participant_id, measure_id, schedule_id, window_opens_at,
    due_at, window_closes_at, status, status_reason, created_at)
  SELECT id, study_id, participant_id, measure_id, schedule_id, opens_at, due_at, closes_at,
    CASE WHEN skipped THEN 'skipped' ELSE 'pending' END,
    CASE WHEN skipped THEN 'participant_reported_travel' END,
    greatest(activated_at, opens_at - interval '1 day')
  FROM ct_plan;

  -- Outbound prompts for message and questionnaire items, as each came due.
  INSERT INTO public.messages(id, study_id, participant_id, thread_id, scheduled_assessment_id, direction, channel,
    provider, message_type, body, external_message_id, idempotency_key, status, sent_at, delivered_at, error_code, created_at)
  SELECT pg_temp.ct_id('message/assessment/'||id), study_id, participant_id, thread_id, id, 'outbound', 'sms',
    'synthetic-sms', 'assessment',
    CASE WHEN source_type='questionnaire'
      THEN format('[%s] Your questionnaire is ready: %s Open your secure form: https://forms.example.org/f/%s',
        short_name, prompt, substr(md5('form/'||id),1,12))
      ELSE format('[%s] %s %s', short_name, prompt, CASE
        WHEN data_type='boolean' THEN 'Reply YES or NO.'
        WHEN data_type='integer' AND max_value=10 THEN 'Reply with a number from 0 to 10.'
        WHEN data_type IN ('integer','numeric') THEN 'Reply with a number.'
        ELSE 'Reply in a few words, or NONE.' END) END,
    'SYN-'||upper(substr(md5('assessment/'||id),1,20)), 'assessment:'||id,
    CASE WHEN failed THEN 'failed' ELSE 'delivered' END, due_at,
    CASE WHEN NOT failed THEN due_at + (2 + floor(pg_temp.ct_u(reading_key||'/delivery')*12)) * interval '1 second' END,
    CASE WHEN failed THEN 'carrier_unreachable' END, due_at - interval '1 second'
  FROM ct_plan
  WHERE source_type IN ('patient_message','questionnaire') AND due_at <= now() AND NOT skipped;

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, scheduled_assessment_id, direction, channel,
    provider, message_type, body, external_message_id, idempotency_key, status, sent_at, delivered_at, created_at)
  SELECT pg_temp.ct_id('message/assessment_reminder/'||id), study_id, participant_id, thread_id, id, 'outbound',
    'sms', 'synthetic-sms', 'assessment_reminder', format('[%s] Reminder: %s', short_name, prompt),
    'SYN-'||upper(substr(md5('assessment_reminder/'||id),1,20)), 'assessment_reminder:'||id, 'delivered',
    reminder_at, reminder_at + interval '5 seconds', reminder_at - interval '1 second'
  FROM ct_plan WHERE reminder_at IS NOT NULL;

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, scheduled_assessment_id, direction, channel,
    provider, message_type, body, external_message_id, status, received_at, created_at)
  SELECT pg_temp.ct_id('message/reply/'||id), study_id, participant_id, thread_id, id, 'inbound', 'sms',
    'synthetic-sms', 'assessment', raw, 'SYN-'||upper(substr(md5('reply/'||id),1,20)), 'received',
    response_at, response_at
  FROM ct_plan WHERE responded AND source_type='patient_message';

  INSERT INTO public.observations(id, study_id, participant_id, measure_id, scheduled_assessment_id, source_type,
    raw_value, source_payload, numeric_value, boolean_value, text_value, json_value, unit, raw_message_id,
    parser_confidence, metadata, captured_at, created_at)
  SELECT pg_temp.ct_id('observation/'||id), study_id, participant_id, measure_id, id, source_type, raw,
    CASE source_type
      WHEN 'questionnaire' THEN jsonb_build_object('form','ePRO v'||epro_version,'field_id',field_id,'submitted_via','secure_link')
      WHEN 'device' THEN jsonb_build_object(
        'device', CASE WHEN study_code='STUDY-005' THEN 'BP-Link cuff (synthetic)' ELSE 'Glucometer (synthetic)' END,
        'device_id', 'SYN-DEV-'||upper(substr(md5('device/'||code),1,6)),
        'reading_id', 'SYN-RD-'||upper(substr(md5(reading_key),1,10)))
      WHEN 'app_event' THEN jsonb_build_object('event','cbt_module_status','module_completed',v_bool,'app','MindPath (synthetic)')
      WHEN 'site_visit' THEN jsonb_build_object('visit', CASE WHEN d=0 THEN 'Baseline' ELSE 'Week '||(d/7) END,
        'entered_by_role','coordinator')
      WHEN 'laboratory' THEN jsonb_build_object('lab','site laboratory','accession','SYN-LAB-'||upper(substr(md5('lab/'||id),1,8)))
    END,
    v_num, v_bool, v_text, v_json, unit,
    CASE WHEN source_type='patient_message' THEN pg_temp.ct_id('message/reply/'||id) END,
    CASE WHEN source_type='patient_message' THEN CASE WHEN raw IN ('Y','N') THEN 0.93
      WHEN data_type='text' THEN 0.90 ELSE 0.99 END END,
    CASE WHEN source_type='patient_message' THEN '{"parser":"demo-sms-parser/1.0"}'::jsonb ELSE '{}'::jsonb END,
    response_at, response_at + interval '2 seconds'
  FROM ct_plan WHERE responded;

  -- A reply of "60" on a 0-10 scale: flagged out of range, rejected, clarified, corrected.
  FOR r IN SELECT * FROM ct_plan WHERE story_kind='misparsed' LOOP
    UPDATE public.observations SET review_status='rejected', reviewed_by=r.coord_user,
      reviewed_at=r.response_at + interval '2 hours'
    WHERE id=pg_temp.ct_id('observation/'||r.id);
    INSERT INTO public.messages(id, study_id, participant_id, thread_id, scheduled_assessment_id, direction, channel,
      provider, message_type, body, external_message_id, idempotency_key, status, sent_at, delivered_at, created_at)
    VALUES (pg_temp.ct_id('message/clarify/'||r.id), r.study_id, r.participant_id, r.thread_id, r.id, 'outbound', 'sms',
      'synthetic-sms', 'support',
      format('[%s] We received "%s" for %s, which uses a 0 to 10 scale. Could you reply with the number you meant?',
        r.short_name, r.raw, lower(r.label)),
      'SYN-'||upper(substr(md5('clarify/'||r.id),1,20)), 'clarify:'||r.id, 'delivered',
      r.response_at + interval '2 hours 1 minute', r.response_at + interval '2 hours 1 minute 4 seconds',
      r.response_at + interval '2 hours 1 minute' - interval '1 second');
    INSERT INTO public.messages(id, study_id, participant_id, thread_id, scheduled_assessment_id, direction, channel,
      provider, message_type, body, external_message_id, status, received_at, created_at)
    VALUES (pg_temp.ct_id('message/clarify-reply/'||r.id), r.study_id, r.participant_id, r.thread_id, r.id, 'inbound',
      'sms', 'synthetic-sms', 'assessment', 'Sorry, I meant 6', 'SYN-'||upper(substr(md5('clarify-reply/'||r.id),1,20)),
      'received', r.response_at + interval '2 hours 15 minutes', r.response_at + interval '2 hours 15 minutes');
    INSERT INTO public.observations(id, study_id, participant_id, measure_id, scheduled_assessment_id, source_type,
      raw_value, numeric_value, unit, raw_message_id, supersedes_observation_id, parser_confidence, metadata,
      captured_at, created_at)
    VALUES (pg_temp.ct_id('observation/correction/'||r.id), r.study_id, r.participant_id, r.measure_id, r.id,
      'patient_message', 'Sorry, I meant 6', 6, r.unit, pg_temp.ct_id('message/clarify-reply/'||r.id),
      pg_temp.ct_id('observation/'||r.id), 0.88, '{"parser":"demo-sms-parser/1.0"}'::jsonb,
      r.response_at + interval '2 hours 15 minutes', r.response_at + interval '2 hours 15 minutes 2 seconds');
  END LOOP;

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, scheduled_assessment_id, direction, channel,
    provider, message_type, body, external_message_id, idempotency_key, status, sent_at, delivered_at, created_at)
  SELECT pg_temp.ct_id('message/visit_reminder/'||id), study_id, participant_id, thread_id, id, 'outbound', 'sms',
    'synthetic-sms', 'visit_reminder',
    format('[%s] Reminder: your Week %s study visit at %s is tomorrow. Reply here if you need to reschedule.',
      short_name, d/7, institution),
    'SYN-'||upper(substr(md5('visit_reminder/'||id),1,20)), 'visit_reminder:'||id, 'delivered',
    ((local_day - 1) + time '16:00') AT TIME ZONE 'America/New_York',
    ((local_day - 1) + time '16:00') AT TIME ZONE 'America/New_York' + interval '4 seconds',
    ((local_day - 1) + time '16:00') AT TIME ZONE 'America/New_York' - interval '1 second'
  FROM ct_plan
  WHERE source_type IN ('site_visit','laboratory') AND d > 0
    AND ((local_day - 1) + time '16:00') AT TIME ZONE 'America/New_York' <= now();

  -- Conversations around the scripted events (inbound is recorded as received).
  CREATE TEMP TABLE ct_support ON COMMIT DROP AS
  SELECT p.code, p.study_id, p.participant_id, p.thread_id, v.direction, v.body,
    pg_temp.ct_at(v.d, v.t::time) AS at_time, v.seq
  FROM (VALUES
    ('STUDY-001-P007',1,-10,'18:20','inbound','Can I sign the consent form on my phone? I also have a question about how many site visits there are.'),
    ('STUDY-001-P003',1,-1,'11:00','outbound','[MX-101 study] Hi Candidate 03, we have not received your daily answers for a few days. Is everything OK? Reply here or call the study team at Harbor Academic Medical Center.'),
    ('STUDY-001-P008',1,-19,'15:40','inbound','I have decided to stop participating in the study.'),
    ('STUDY-001-P008',2,-19,'16:45','inbound','STOP'),
    ('STUDY-002-P008',1,-13,'19:05','inbound','I am moving out of state next week and will not be able to come to the study visits.'),
    ('STUDY-002-P008',2,-13,'19:40','outbound','[GLY-210 study] Thank you for letting us know. Your coordinator, Mia Patel, will call you tomorrow to talk about next steps.'),
    ('STUDY-003-P008',1,-18,'15:50','inbound','No thank you, I do not want to join the study.'),
    ('STUDY-005-P008',1,-15,'20:10','inbound','The cuff does not fit my arm well and I do not think I can keep doing the readings at home.'),
    ('STUDY-005-P008',2,-15,'20:45','outbound','[BP-Link study] Thanks for telling us. Your coordinator, Jordan Cole, will call you tomorrow to talk about options.')
  ) AS v(code,seq,d,t,direction,body)
  JOIN ct_participant p USING (code);
  INSERT INTO ct_support
  SELECT code, study_id, participant_id, thread_id, 'inbound',
    'I am traveling this weekend and will not have my scale for the weekly weight.', due_at - interval '13 hours', 1
  FROM ct_plan WHERE story_kind='skipped'
  UNION ALL
  SELECT code, study_id, participant_id, thread_id, 'outbound',
    format('[%s] Thanks for letting us know. We will mark this week''s weight as skipped. Daily questions continue as usual.', short_name),
    due_at - interval '12 hours 25 minutes', 2
  FROM ct_plan WHERE story_kind='skipped';

  INSERT INTO public.messages(id, study_id, participant_id, thread_id, direction, channel, provider, message_type,
    body, external_message_id, idempotency_key, status, sent_at, delivered_at, received_at, created_at)
  SELECT pg_temp.ct_id('message/support/'||code||'/'||at_time::text), study_id, participant_id, thread_id, direction,
    'sms', 'synthetic-sms', 'support', body, 'SYN-'||upper(substr(md5('support/'||code||'/'||at_time::text),1,20)),
    CASE WHEN direction='outbound' THEN 'support:'||code||':'||seq||':'||extract(epoch FROM at_time)::bigint END,
    CASE WHEN direction='outbound' THEN 'delivered' ELSE 'received' END,
    CASE WHEN direction='outbound' THEN at_time END,
    CASE WHEN direction='outbound' THEN at_time + interval '4 seconds' END,
    CASE WHEN direction='inbound' THEN at_time END,
    at_time - CASE WHEN direction='outbound' THEN interval '1 second' ELSE interval '0' END
  FROM ct_support;

  ---------------------------------------------------------------------------
  -- Withdrawals. The lifecycle trigger cancels open assessments and tasks.
  ---------------------------------------------------------------------------
  FOR r IN SELECT * FROM ct_participant WHERE withdrawn_at IS NOT NULL ORDER BY withdrawn_at LOOP
    IF r.revoke_consent THEN
      UPDATE public.participant_consents SET status='revoked', revoked_at=r.withdrawn_at
      WHERE participant_id=r.participant_id AND status='signed';
    END IF;
    PERFORM set_config('ct_seed.occurred_at', r.withdrawn_at::text, TRUE);
    UPDATE public.participants SET status='withdrawn', withdrawn_at=r.withdrawn_at, status_changed_by=r.coord_user
    WHERE id=r.participant_id;
    UPDATE public.message_threads SET status='closed' WHERE participant_id=r.participant_id;
  END LOOP;

  UPDATE private.participant_contacts c SET messaging_opt_in=FALSE, opted_out_at=s.at_time
  FROM ct_support s WHERE s.participant_id=c.participant_id AND s.direction='inbound' AND s.body='STOP';

  ---------------------------------------------------------------------------
  -- Alerts, derived from the data with each enabled rule's condition.
  ---------------------------------------------------------------------------
  CREATE TEMP TABLE ct_alert (
    id UUID, study_id UUID, participant_id UUID, site_id UUID, code TEXT, rule_id UUID, rule_code TEXT,
    rule_type TEXT, action_type TEXT, severity TEXT, reason TEXT, recommended_action TEXT, dedup TEXT,
    created_at TIMESTAMPTZ, status TEXT, observation_id UUID, ack_hint TIMESTAMPTZ, ack_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ, notes TEXT, withdrawn_at TIMESTAMPTZ, coord_user UUID, pi_user UUID,
    coord_assign UUID, pi_assign UUID
  ) ON COMMIT DROP;

  INSERT INTO ct_alert(id, study_id, participant_id, site_id, code, rule_id, rule_code, rule_type, action_type,
    severity, reason, recommended_action, dedup, created_at, status, observation_id, withdrawn_at, coord_user,
    pi_user, coord_assign, pi_assign)
  SELECT pg_temp.ct_id('alert/'||ar.rule_code||'/'||o.id), o.study_id, o.participant_id, p.site_id, p.code, ar.id,
    ar.rule_code, ar.rule_type, ar.action_type, ar.severity,
    format('%s reported for %s: %s%s.', m.label, p.code,
      coalesce(trim_scale(o.numeric_value)::text, o.text_value, CASE WHEN o.boolean_value THEN 'Yes' ELSE 'No' END),
      coalesce(' '||m.unit, '')),
    CASE ar.rule_type WHEN 'safety_review'
      THEN 'Investigator review of the participant report, following the site safety plan.'
      ELSE 'Coordinator follow-up with the participant; escalate to the investigator if confirmed.' END,
    ar.rule_code||':'||o.id, least(o.captured_at + interval '2 minutes', now()),
    coalesce(c.alert_status, CASE WHEN now() - o.captured_at > interval '72 hours' THEN 'resolved'
      WHEN now() - o.captured_at > interval '12 hours' THEN 'acknowledged' ELSE 'open' END),
    o.id, p.withdrawn_at, p.coord_user, p.pi_user, p.coord_assign, p.pi_assign
  FROM public.observations o
  JOIN public.alert_rules ar ON ar.study_id=o.study_id AND ar.measure_id=o.measure_id AND ar.enabled
    AND ar.rule_type IN ('value_threshold','safety_review')
  JOIN public.measure_definitions m ON m.id=o.measure_id
  JOIN ct_participant p ON p.participant_id=o.participant_id
  LEFT JOIN ct_plan c ON c.id=o.scheduled_assessment_id
  WHERE o.review_status <> 'rejected'
    AND NOT EXISTS (SELECT 1 FROM public.observations newer WHERE newer.supersedes_observation_id=o.id)
    AND CASE ar.condition->>'op'
      WHEN '>=' THEN o.numeric_value >= (ar.condition->>'value')::numeric
      WHEN '<=' THEN o.numeric_value <= (ar.condition->>'value')::numeric
      WHEN '<' THEN o.numeric_value < (ar.condition->>'value')::numeric
      WHEN 'is_true' THEN o.boolean_value
      WHEN 'text_not_in' THEN lower(btrim(o.text_value)) NOT IN
        (SELECT jsonb_array_elements_text(ar.condition->'values'))
    END;

  -- Missing data: N consecutive closed days with every daily message item unanswered.
  INSERT INTO ct_alert(id, study_id, participant_id, site_id, code, rule_id, rule_code, rule_type, action_type,
    severity, reason, recommended_action, dedup, created_at, status, ack_hint, resolved_at, notes, withdrawn_at,
    coord_user, pi_user, coord_assign, pi_assign)
  WITH daily AS (
    SELECT a.participant_id, (a.due_at AT TIME ZONE 'America/New_York')::date AS day,
      bool_and(a.status='pending') AS all_missed, max(a.window_closes_at) AS closed_at
    FROM public.scheduled_assessments a
    JOIN public.assessment_schedules s ON s.id=a.schedule_id
    JOIN public.measure_definitions m ON m.id=a.measure_id
    WHERE s.frequency='daily' AND m.source_type='patient_message'
    GROUP BY a.participant_id, (a.due_at AT TIME ZONE 'America/New_York')::date
    HAVING max(a.window_closes_at) <= now()
  ), islands AS (
    SELECT *, day - (row_number() OVER (PARTITION BY participant_id ORDER BY day))::integer AS grp
    FROM daily WHERE all_missed
  ), runs AS (
    SELECT participant_id, min(day) AS first_day, max(day) AS last_day, count(*) AS n_days,
      array_agg(closed_at ORDER BY day) AS closes
    FROM islands GROUP BY participant_id, grp
  )
  SELECT pg_temp.ct_id('alert/'||ar.rule_code||'/'||p.code||'/'||ru.first_day), p.study_id, p.participant_id, p.site_id,
    p.code, ar.id, ar.rule_code, ar.rule_type, ar.action_type, ar.severity,
    format('No responses to daily study questions on %s consecutive days (%s to %s).',
      ar.condition->>'consecutive_days', ru.first_day, ru.first_day + (ar.condition->>'consecutive_days')::integer - 1),
    'Coordinator outreach to check on the participant and their device or phone.',
    ar.rule_code||':'||p.code||':'||ru.first_day,
    ru.closes[(ar.condition->>'consecutive_days')::integer],
    CASE WHEN resumed.at IS NOT NULL THEN 'resolved'
      ELSE coalesce(pa.status, CASE WHEN now() - ru.closes[(ar.condition->>'consecutive_days')::integer] > interval '12 hours'
        THEN 'acknowledged' ELSE 'open' END) END,
    ru.closes[(ar.condition->>'consecutive_days')::integer] + interval '9 hours',
    resumed.at + interval '1 hour', CASE WHEN resumed.at IS NOT NULL THEN 'Participant resumed daily responses.' END,
    p.withdrawn_at, p.coord_user, p.pi_user, p.coord_assign, p.pi_assign
  FROM runs ru
  JOIN ct_participant p ON p.participant_id=ru.participant_id
  JOIN public.alert_rules ar ON ar.study_id=p.study_id AND ar.rule_type='missing_assessments' AND ar.enabled
  LEFT JOIN (VALUES ('STUDY-001-P003','acknowledged'),('STUDY-004-P003','open')) AS pa(code,status) ON pa.code=p.code
  LEFT JOIN LATERAL (
    SELECT min(a.completed_at) AS at FROM public.scheduled_assessments a
    JOIN public.assessment_schedules s ON s.id=a.schedule_id
    JOIN public.measure_definitions m ON m.id=a.measure_id
    WHERE a.participant_id=ru.participant_id AND s.frequency='daily' AND m.source_type='patient_message'
      AND (a.due_at AT TIME ZONE 'America/New_York')::date > ru.last_day AND a.completed_at IS NOT NULL
  ) resumed ON TRUE
  WHERE ru.n_days >= (ar.condition->>'consecutive_days')::integer;

  INSERT INTO ct_alert(id, study_id, participant_id, site_id, code, rule_id, rule_code, rule_type, action_type,
    severity, reason, recommended_action, dedup, created_at, status, ack_hint, withdrawn_at, coord_user, pi_user,
    coord_assign, pi_assign)
  SELECT pg_temp.ct_id('alert/'||ar.rule_code||'/'||p.code), p.study_id, p.participant_id, p.site_id, p.code, ar.id,
    ar.rule_code, ar.rule_type, ar.action_type, ar.severity,
    format('Consent invitation sent %s has not been signed after %s days.',
      to_char(pc.presented_at AT TIME ZONE 'America/New_York','YYYY-MM-DD'), ar.condition->>'days_since_invitation'),
    'Send a consent reminder and offer a call with the study coordinator.',
    ar.rule_code||':'||p.code,
    pc.presented_at + (ar.condition->>'days_since_invitation')::integer * interval '1 day',
    CASE WHEN rem.at IS NOT NULL THEN 'acknowledged' ELSE 'open' END, rem.at,
    p.withdrawn_at, p.coord_user, p.pi_user, p.coord_assign, p.pi_assign
  FROM public.participant_consents pc
  JOIN public.participants pt ON pt.id=pc.participant_id AND pt.status='consent_pending'
  JOIN ct_participant p ON p.participant_id=pc.participant_id
  JOIN public.alert_rules ar ON ar.study_id=pc.study_id AND ar.rule_type='consent_overdue' AND ar.enabled
  LEFT JOIN LATERAL (
    SELECT min(m.sent_at) AS at FROM public.messages m
    WHERE m.participant_id=pc.participant_id AND m.message_type='consent_reminder'
      AND m.sent_at >= pc.presented_at + (ar.condition->>'days_since_invitation')::integer * interval '1 day'
  ) rem ON TRUE
  WHERE pc.status IN ('sent','opened')
    AND pc.presented_at + (ar.condition->>'days_since_invitation')::integer * interval '1 day' <= now();

  UPDATE ct_alert SET status='resolved', resolved_at=withdrawn_at,
    notes='Participant withdrew from the study; alert closed.'
  WHERE withdrawn_at IS NOT NULL AND status <> 'resolved' AND created_at <= withdrawn_at;

  UPDATE ct_alert SET
    ack_at = CASE WHEN status='open' THEN NULL ELSE least(coalesce(ack_hint, created_at + CASE severity
      WHEN 'critical' THEN interval '10 minutes' WHEN 'high' THEN interval '30 minutes'
      WHEN 'medium' THEN interval '2 hours' ELSE interval '1 hour' END), now()) END,
    resolved_at = CASE WHEN status='resolved' THEN least(coalesce(resolved_at, created_at + CASE severity
      WHEN 'critical' THEN interval '3 hours' WHEN 'high' THEN interval '20 hours' ELSE interval '26 hours' END), now()) END,
    notes = CASE WHEN status='resolved' THEN coalesce(notes, CASE rule_type
      WHEN 'safety_review' THEN 'Investigator reviewed the report per the site safety plan; assessment documented in source records.'
      ELSE 'Coordinator contacted the participant and documented follow-up in source records; investigator informed.' END) END;
  UPDATE ct_alert SET ack_at=least(ack_at, resolved_at) WHERE resolved_at IS NOT NULL;

  INSERT INTO public.alerts(id, study_id, participant_id, rule_id, assigned_site_id, assigned_staff_id, alert_type,
    severity, reason, recommended_action, deduplication_key, status, acknowledged_by, resolved_by, resolution_notes,
    created_at, acknowledged_at, resolved_at)
  SELECT id, study_id, participant_id, rule_id, site_id,
    CASE WHEN rule_type='safety_review' THEN pi_assign ELSE coord_assign END,
    rule_type, severity, reason, recommended_action, dedup, status,
    CASE WHEN ack_at IS NOT NULL THEN coord_user END,
    CASE WHEN status='resolved' THEN CASE WHEN rule_type='safety_review' THEN pi_user ELSE coord_user END END,
    notes, created_at, ack_at, resolved_at
  FROM ct_alert;

  UPDATE public.observations o SET requires_review=TRUE,
    review_status = CASE WHEN a.status='resolved' THEN 'accepted' ELSE o.review_status END,
    reviewed_by = CASE WHEN a.status='resolved' THEN CASE WHEN a.rule_type='safety_review' THEN a.pi_user ELSE a.coord_user END END,
    reviewed_at = CASE WHEN a.status='resolved' THEN a.resolved_at END
  FROM ct_alert a WHERE a.observation_id=o.id;

  INSERT INTO public.workflow_tasks(id, study_id, participant_id, rule_id, assigned_staff_id, action_type, payload,
    deduplication_key, status, requires_approval, approved_by, approved_at, run_after, attempts, completed_at,
    created_at, updated_at)
  SELECT pg_temp.ct_id('task/notify_staff/'||id), study_id, participant_id, rule_id, coord_assign, 'notify_staff',
    jsonb_build_object('alert_id', id, 'alert_type', rule_type), 'notify_staff:'||dedup, 'completed', FALSE, NULL, NULL,
    created_at, 1, least(created_at + interval '1 minute', now()), created_at, least(created_at + interval '1 minute', now())
  FROM ct_alert WHERE action_type='notify_staff'
  UNION ALL
  SELECT pg_temp.ct_id('task/review_safety/'||id), study_id, participant_id, rule_id, pi_assign, 'review_safety',
    jsonb_build_object('alert_id', id, 'observation_id', observation_id), 'review_safety:'||dedup,
    CASE WHEN status='resolved' THEN 'completed' ELSE 'waiting_review' END, TRUE,
    CASE WHEN status='resolved' THEN pi_user END, CASE WHEN status='resolved' THEN resolved_at END,
    created_at, CASE WHEN status='resolved' THEN 1 ELSE 0 END, CASE WHEN status='resolved' THEN resolved_at END,
    created_at, coalesce(resolved_at, created_at)
  FROM ct_alert WHERE rule_type='safety_review';

  ---------------------------------------------------------------------------
  -- Business events alongside the trigger-written status changes.
  ---------------------------------------------------------------------------
  INSERT INTO public.participant_events(study_id, participant_id, event_type, actor_staff_id, metadata, occurred_at)
  SELECT study_id, participant_id, 'consent_invitation_sent', NULL::uuid,
    jsonb_build_object('consent_version', local_icf, 'channel', 'sms'), invite_at
  FROM ct_participant WHERE invite_at IS NOT NULL
  UNION ALL
  SELECT study_id, participant_id, 'consent_opened', NULL, jsonb_build_object('consent_version', local_icf), opened_at
  FROM ct_participant WHERE opened_at IS NOT NULL
  UNION ALL
  SELECT study_id, participant_id, 'consent_signed', coord_user, jsonb_build_object('consent_version', local_icf), signed_at
  FROM ct_participant WHERE signed_at IS NOT NULL
  UNION ALL
  SELECT study_id, participant_id, 'consent_declined', NULL, jsonb_build_object('consent_version', local_icf), declined_at
  FROM ct_participant WHERE declined_at IS NOT NULL
  UNION ALL
  SELECT study_id, participant_id, 'randomized', coord_user,
    CASE WHEN design ILIKE '%blind%' THEN jsonb_build_object('blinded', TRUE)
      ELSE jsonb_build_object('blinded', FALSE, 'arm_code', arm_code) END,
    activated_at
  FROM ct_participant WHERE activated_at IS NOT NULL
  UNION ALL
  SELECT study_id, participant_id, 'consent_revoked', coord_user, jsonb_build_object('consent_version', local_icf), withdrawn_at
  FROM ct_participant WHERE revoke_consent
  UNION ALL
  SELECT study_id, participant_id, 'withdrawal_documented', coord_user,
    jsonb_build_object('reason', withdrawal_reason, 'data_before_withdrawal', 'retained'),
    withdrawn_at + interval '5 minutes'
  FROM ct_participant WHERE withdrawn_at IS NOT NULL
  UNION ALL
  SELECT s.study_id, s.participant_id, 'messaging_opted_out', NULL, jsonb_build_object('keyword', 'STOP'), s.at_time
  FROM ct_support s WHERE s.direction='inbound' AND s.body='STOP';

  ---------------------------------------------------------------------------
  -- Restore the schema default, then check the result before committing.
  ---------------------------------------------------------------------------
  PERFORM set_config('ct_seed.occurred_at', '', TRUE);
  ALTER TABLE public.participant_events ALTER COLUMN occurred_at SET DEFAULT now();

  SELECT string_agg(status||'='||n, ',' ORDER BY status COLLATE "C") INTO v_dist FROM
    (SELECT status, count(*) AS n FROM public.participants GROUP BY status) x;
  IF v_dist <> 'active=19,consent_pending=8,consented=4,enrolled=5,withdrawn=4' THEN
    RAISE EXCEPTION 'Unexpected participant status distribution: %; mismatched: %', v_dist,
      (SELECT string_agg(p.code||' '||coalesce(pt.status,'missing'), ', ') FROM ct_participant p
       LEFT JOIN public.participants pt ON pt.id=p.participant_id
       WHERE pt.status IS DISTINCT FROM p.final_status);
  END IF;
  SELECT string_agg(format('%s status=%s last_event=%s consent=%s', p.participant_code, p.status, x.last_status,
      public.has_current_consent(p.study_id, p.id)), '; ') INTO v_dist
  FROM public.participants p
  JOIN ct_participant c ON c.participant_id=p.id
  LEFT JOIN LATERAL (SELECT e.new_status AS last_status FROM public.participant_events e
    WHERE e.participant_id=p.id AND e.new_status IS NOT NULL ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) x ON TRUE
  -- Withdrawal without revocation keeps the signed consent (data collected before withdrawal is retained).
  WHERE p.status IS DISTINCT FROM x.last_status
     OR public.has_current_consent(p.study_id, p.id) <> (c.signed_at IS NOT NULL AND NOT c.revoke_consent);
  IF v_dist IS NOT NULL THEN
    RAISE EXCEPTION 'Participant status disagrees with its event history or consent: %', v_dist;
  END IF;
  IF EXISTS (SELECT 1 FROM ct_story s WHERE s.alert_status IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM ct_plan c JOIN ct_alert a ON a.observation_id=pg_temp.ct_id('observation/'||c.id)
       WHERE c.code=s.code AND c.story_kind=s.kind AND c.measure_code=s.measure_code
         AND (s.d IS NULL OR s.d=c.d) AND (s.occurrence IS NULL OR s.occurrence=c.ord) AND a.status=s.alert_status))
     OR (SELECT count(*) FROM ct_alert WHERE rule_type='missing_assessments' AND status <> 'resolved') <> 2
     OR (SELECT count(*) FROM ct_alert WHERE rule_type='consent_overdue') <> 3 THEN
    RAISE EXCEPTION 'Scripted alerts were not derived as expected';
  END IF;
  IF EXISTS (SELECT 1 FROM public.scheduled_assessments a JOIN public.participants p ON p.id=a.participant_id
             WHERE p.status='withdrawn' AND a.status='pending')
     OR EXISTS (SELECT 1 FROM public.messages WHERE greatest(sent_at, delivered_at, received_at, created_at) > now())
     OR EXISTS (SELECT 1 FROM public.observations WHERE captured_at > now())
     OR EXISTS (SELECT 1 FROM public.participant_events WHERE occurred_at > now())
     OR EXISTS (SELECT 1 FROM public.alerts WHERE greatest(created_at, acknowledged_at, resolved_at) > now()) THEN
    RAISE EXCEPTION 'Generated data is inconsistent with the load time or withdrawal rules';
  END IF;

  INSERT INTO public.schema_migrations(version) VALUES ('002_synthetic_demo_seed');

  RAISE NOTICE 'Seeded: % staff, % participants, % assessments (% completed), % observations, % messages, % alerts (% open, % acknowledged), % tasks',
    (SELECT count(*) FROM private.staff_users), (SELECT count(*) FROM public.participants),
    (SELECT count(*) FROM public.scheduled_assessments),
    (SELECT count(*) FROM public.scheduled_assessments WHERE status='completed'),
    (SELECT count(*) FROM public.observations), (SELECT count(*) FROM public.messages),
    (SELECT count(*) FROM public.alerts), (SELECT count(*) FROM public.alerts WHERE status='open'),
    (SELECT count(*) FROM public.alerts WHERE status='acknowledged'), (SELECT count(*) FROM public.workflow_tasks);
END
$seed$;

COMMIT;
