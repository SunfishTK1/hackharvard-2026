-- Run as postgres with psql -X -v ON_ERROR_STOP=1 against a migrated database.
-- All fixtures and test functions are rolled back, including on failure.
\set QUIET on
\o /dev/null
BEGIN;
SET LOCAL ROLE app_owner;
CREATE TEMP TABLE contract_checks (name TEXT NOT NULL);
CREATE FUNCTION pg_temp.id(n INTEGER) RETURNS UUID LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
CREATE FUNCTION pg_temp.check_true(ok BOOLEAN, label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %',label; END IF;
  INSERT INTO contract_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.expect_error(statement TEXT, expected_state TEXT, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actual_state TEXT;
BEGIN
  BEGIN
    EXECUTE statement;
    RAISE EXCEPTION 'Expected SQLSTATE %, but statement succeeded: %',expected_state,label;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE;
    IF actual_state <> expected_state THEN RAISE; END IF;
  END;
  INSERT INTO contract_checks VALUES(label);
END $$;

SELECT pg_temp.check_true((SELECT count(*)=24 FROM pg_catalog.pg_tables
  WHERE schemaname IN ('public','private','audit')), '24 tables including migration tracking');
SELECT pg_temp.check_true(to_regclass('trial.trials') IS NULL,'old demo tables removed');
SELECT pg_temp.check_true((SELECT extversion IS NOT NULL FROM pg_extension WHERE extname='vector'),'pgvector retained');

INSERT INTO private.staff_users(id,auth_subject,display_name) VALUES
  (pg_temp.id(1),'contract:manager','Contract manager'),
  (pg_temp.id(2),'contract:other-site','Contract coordinator'),
  (pg_temp.id(3),'contract:other-study','Contract other study staff');
INSERT INTO public.studies(id,study_code,title,is_synthetic) VALUES
  (pg_temp.id(10),'CONTRACT-A','Contract study A',TRUE),
  (pg_temp.id(20),'CONTRACT-B','Contract study B',TRUE);
INSERT INTO public.sites(id,study_id,site_code,institution_name,status,time_zone) VALUES
  (pg_temp.id(11),pg_temp.id(10),'A-1','Contract site 1','active','America/New_York'),
  (pg_temp.id(12),pg_temp.id(10),'A-2','Contract site 2','active','UTC'),
  (pg_temp.id(21),pg_temp.id(20),'B-1','Contract site 3','active','UTC');
INSERT INTO public.study_staff(id,study_id,site_id,staff_user_id,role) VALUES
  (pg_temp.id(31),pg_temp.id(10),NULL,pg_temp.id(1),'trial_manager'),
  (pg_temp.id(32),pg_temp.id(10),pg_temp.id(12),pg_temp.id(2),'coordinator'),
  (pg_temp.id(33),pg_temp.id(20),NULL,pg_temp.id(3),'trial_manager');
SELECT pg_temp.expect_error($q$
  UPDATE public.studies SET status='active',approved_by=pg_temp.id(1),approved_at=now() WHERE id=pg_temp.id(10)
$q$,'23514','activation blocked without reviewed protocol extraction');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.sites(study_id,site_code,institution_name,time_zone)
  VALUES(pg_temp.id(10),'BAD-TZ','Contract','Not/A_Zone')
$q$,'23514','invalid time zone rejected');

INSERT INTO public.study_documents(id,study_id,document_type,version,file_name,storage_uri) VALUES
  (pg_temp.id(1001),pg_temp.id(10),'protocol','1','contract-protocol.pdf','test://protocol'),
  (pg_temp.id(1002),pg_temp.id(10),'icf','1','contract-icf.pdf','test://icf');
SELECT pg_temp.expect_error($q$
  UPDATE public.study_documents SET review_status='approved',reviewed_by=pg_temp.id(3),reviewed_at=now()
  WHERE id=pg_temp.id(1001)
$q$,'23514','another study staff cannot approve a document');
UPDATE public.study_documents SET review_status='approved',reviewed_by=pg_temp.id(1),reviewed_at=now(),is_current=TRUE
  WHERE study_id=pg_temp.id(10);
INSERT INTO public.document_extractions(id,study_id,source_document_id,extractor,proposed_data,status,reviewed_by,reviewed_at)
  VALUES(pg_temp.id(1003),pg_temp.id(10),pg_temp.id(1001),'contract-test','{}','approved',pg_temp.id(1),now());
SELECT pg_temp.expect_error($q$
  UPDATE public.document_extractions SET proposed_data='{"changed":true}' WHERE id=pg_temp.id(1003)
$q$,'23514','approved extraction immutable');
SELECT pg_temp.expect_error($q$
  UPDATE public.study_documents SET storage_uri='test://changed' WHERE id=pg_temp.id(1001)
$q$,'23514','approved source document immutable');
UPDATE public.studies SET status='active',approved_by=pg_temp.id(1),approved_at=now() WHERE id=pg_temp.id(10);
SELECT pg_temp.check_true((SELECT status='active' FROM public.studies WHERE id=pg_temp.id(10)),'reviewed study can activate');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.consent_documents(study_id,source_document_id,document_name,version,is_active)
  VALUES(pg_temp.id(10),pg_temp.id(1001),'Wrong source','1',TRUE)
$q$,'23514','consent cannot reference a protocol');
INSERT INTO public.consent_documents(id,study_id,source_document_id,document_name,version,is_active)
  VALUES(pg_temp.id(1004),pg_temp.id(10),pg_temp.id(1002),'Contract ICF','1',TRUE);

INSERT INTO public.participants(id,study_id,site_id,participant_code,eligibility_status,is_synthetic) VALUES
  (pg_temp.id(111),pg_temp.id(10),pg_temp.id(11),'CONTRACT-P1','eligible',TRUE),
  (pg_temp.id(112),pg_temp.id(10),pg_temp.id(12),'CONTRACT-P2','eligible',TRUE),
  (pg_temp.id(211),pg_temp.id(20),pg_temp.id(21),'CONTRACT-P3','eligible',TRUE);
SELECT pg_temp.check_true((SELECT bool_and(status='consent_pending') FROM public.participants
  WHERE id IN (pg_temp.id(111),pg_temp.id(112),pg_temp.id(211))),
  'all newly created participants default consent_pending');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.participants(study_id,site_id,participant_code,status)
  VALUES(pg_temp.id(10),pg_temp.id(11),'INVALID','consented')
$q$,'23514','cannot import an already progressed participant');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.participants(study_id,site_id,participant_code)
  VALUES(pg_temp.id(10),pg_temp.id(21),'WRONG-STUDY')
$q$,'23503','participant site must belong to study');
SELECT pg_temp.expect_error($q$
  UPDATE public.participants SET status='consented' WHERE id=pg_temp.id(111)
$q$,'23514','cannot progress without signed consent');
SELECT pg_temp.expect_error($q$
  UPDATE public.participants SET status='active',enrolled_at=now(),activated_at=now(),enrollment_confirmed_by=pg_temp.id(1)
  WHERE id=pg_temp.id(111)
$q$,'23514','lifecycle stages cannot be skipped');

INSERT INTO private.participant_contacts(study_id,participant_id,secure_handle)
  VALUES(pg_temp.id(10),pg_temp.id(111),'contract-handle');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.messages(study_id,participant_id,direction,channel,message_type,consent_document_id,body,status)
  VALUES(pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','consent_invitation',pg_temp.id(1004),'Contract','queued')
$q$,'23514','messaging requires opt-in');
UPDATE private.participant_contacts SET messaging_opt_in=TRUE,opted_in_at=now() WHERE participant_id=pg_temp.id(111);
SELECT pg_temp.expect_error($q$
  INSERT INTO public.messages(study_id,participant_id,direction,channel,message_type,body,status)
  VALUES(pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','consent_invitation','Contract','queued')
$q$,'23514','consent message must identify the approved ICF');
INSERT INTO public.messages(id,study_id,participant_id,direction,channel,message_type,consent_document_id,body,status,idempotency_key)
  VALUES(pg_temp.id(400),pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','consent_invitation',
    pg_temp.id(1004),'Contract invitation','queued','contract-invitation');
SELECT pg_temp.check_true(EXISTS(SELECT 1 FROM public.messages WHERE id=pg_temp.id(400)),'approved consent invitation allowed');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.messages(study_id,participant_id,direction,channel,message_type,consent_document_id,body,status,idempotency_key)
  VALUES(pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','consent_invitation',pg_temp.id(1004),'Contract','queued','contract-invitation')
$q$,'23505','message retries are idempotent');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.messages(study_id,participant_id,direction,channel,message_type,body,status)
  VALUES(pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','assessment','Contract','queued')
$q$,'23514','assessment messages blocked before consent and enrollment');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.messages(study_id,participant_id,direction,channel,message_type,body,status,sent_at,delivered_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','assessment','Contract','delivered',now(),now())
$q$,'23514','direct delivered inserts cannot bypass the messaging gate');

INSERT INTO public.measure_definitions(id,study_id,measure_code,label,data_type,unit,min_value,max_value,choices) VALUES
  (pg_temp.id(100),pg_temp.id(10),'SCORE','Contract score','numeric','score',0,10,NULL),
  (pg_temp.id(101),pg_temp.id(10),'TAKEN','Contract boolean','boolean',NULL,NULL,NULL,NULL),
  (pg_temp.id(102),pg_temp.id(10),'VITALS','Contract compound measure','json',NULL,NULL,NULL,NULL),
  (pg_temp.id(103),pg_temp.id(10),'CHOICE','Contract choice','choice',NULL,NULL,NULL,'["yes","no"]'),
  (pg_temp.id(104),pg_temp.id(10),'COUNT','Contract count','integer',NULL,0,NULL,NULL),
  (pg_temp.id(200),pg_temp.id(20),'OTHER','Other study measure','numeric',NULL,NULL,NULL,NULL);
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,numeric_value,unit,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),'questionnaire','5',5,'score',now())
$q$,'23514','observations blocked before enrollment');
INSERT INTO public.participant_consents(study_id,participant_id,consent_document_id,status,signed_at,signed_by,copy_provided_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(1004),'signed',now(),'Contract signer',now());
SELECT pg_temp.check_true(public.has_current_consent(pg_temp.id(10),pg_temp.id(111)),'applicable signed consent recognized');
UPDATE public.participants SET status='consented' WHERE id=pg_temp.id(111);
SELECT pg_temp.expect_error($q$
  UPDATE public.participants SET status='enrolled',enrolled_at=now(),enrollment_confirmed_by=pg_temp.id(3)
  WHERE id=pg_temp.id(111)
$q$,'23514','enrollment requires authorized study/site staff');
UPDATE public.participants SET status='enrolled',enrolled_at=now(),enrollment_confirmed_by=pg_temp.id(1),status_changed_by=pg_temp.id(1)
  WHERE id=pg_temp.id(111);
UPDATE public.participants SET status='active',activated_at=now() WHERE id=pg_temp.id(111);
SELECT pg_temp.check_true((SELECT count(*)=4 FROM public.participant_events WHERE participant_id=pg_temp.id(111)),
  'lifecycle creation and transitions audited');
SELECT pg_temp.expect_error($q$
  UPDATE public.participants SET enrollment_confirmed_by=pg_temp.id(3) WHERE id=pg_temp.id(111)
$q$,'23514','enrollment evidence cannot be overwritten');

INSERT INTO public.message_threads(id,study_id,participant_id,provider,channel) VALUES
  (pg_temp.id(301),pg_temp.id(10),pg_temp.id(111),'contract','secure_message'),
  (pg_temp.id(302),pg_temp.id(10),pg_temp.id(112),'contract','secure_message');
INSERT INTO public.messages(id,study_id,participant_id,thread_id,direction,channel,provider,message_type,body,status,received_at,external_message_id) VALUES
  (pg_temp.id(401),pg_temp.id(10),pg_temp.id(111),pg_temp.id(301),'inbound','secure_message','contract','assessment','Contract raw response','received',now(),'contract-1'),
  (pg_temp.id(402),pg_temp.id(10),pg_temp.id(112),pg_temp.id(302),'inbound','secure_message','contract','support','Contract other response','received',now(),'contract-2');
SELECT pg_temp.expect_error($q$
  UPDATE public.messages SET body='changed' WHERE id=pg_temp.id(401)
$q$,'23514','source messages immutable');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.messages(study_id,participant_id,thread_id,direction,channel,message_type,body,status)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(302),'outbound','secure_message','assessment','Contract','queued')
$q$,'23503','cannot attach another participant conversation');
INSERT INTO public.messages(id,study_id,participant_id,direction,channel,message_type,body,status)
  VALUES(pg_temp.id(403),pg_temp.id(10),pg_temp.id(111),'outbound','secure_message','assessment','Contract assessment','queued');
UPDATE private.participant_contacts SET messaging_opt_in=FALSE,opted_out_at=now() WHERE participant_id=pg_temp.id(111);
SELECT pg_temp.expect_error($q$
  UPDATE public.messages SET status='sending' WHERE id=pg_temp.id(403)
$q$,'23514','opt-in checked again when queued message dispatches');
UPDATE private.participant_contacts SET messaging_opt_in=TRUE,opted_out_at=NULL,opted_in_at=now() WHERE participant_id=pg_temp.id(111);

INSERT INTO public.assessment_schedules(id,study_id,measure_id,schedule_code,frequency,times_of_day)
  VALUES(pg_temp.id(450),pg_temp.id(10),pg_temp.id(100),'TWICE-DAILY','daily',ARRAY['08:00'::time,'20:00'::time]);
SELECT pg_temp.expect_error($q$
  INSERT INTO public.assessment_schedules(study_id,measure_id,schedule_code,frequency,weekdays)
  VALUES(pg_temp.id(10),pg_temp.id(100),'BAD-WEEKDAY','weekly',ARRAY[8]::smallint[])
$q$,'23514','invalid schedule weekdays rejected');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.assessment_schedules(study_id,measure_id,schedule_code,frequency)
  VALUES(pg_temp.id(10),pg_temp.id(100),'BAD-CUSTOM','custom_days')
$q$,'23514','explicit study days required for visit/lab schedules');
INSERT INTO public.scheduled_assessments(id,study_id,participant_id,measure_id,schedule_id,window_opens_at,due_at,window_closes_at) VALUES
  (pg_temp.id(501),pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),pg_temp.id(450),now()-interval '2 days',now()-interval '1 day',now()-interval '1 hour'),
  (pg_temp.id(502),pg_temp.id(10),pg_temp.id(111),pg_temp.id(101),NULL,now()-interval '2 days',now()-interval '1 day',now()-interval '1 hour');
SELECT pg_temp.check_true((SELECT count(*)=2 FROM analytics.assessment_status WHERE participant_id=pg_temp.id(111) AND status='overdue'),
  'overdue status derived from assessment windows');
SELECT pg_temp.expect_error($q$
  UPDATE public.scheduled_assessments SET status='completed',completed_at=now() WHERE id=pg_temp.id(501)
$q$,'23514','cannot fabricate assessment completion without source response');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,boolean_value,unit,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),'questionnaire','yes',TRUE,'score',now())
$q$,'23514','typed values match measure definitions');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,numeric_value,unit,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),'questionnaire',5,'score',now())
$q$,'23514','source response required');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_message_id,numeric_value,unit,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),'patient_message',pg_temp.id(402),5,'score',now())
$q$,'23503','observation source message belongs to same participant');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,numeric_value,unit,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),'questionnaire','5',5,'wrong',now())
$q$,'23514','measure units enforced');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,numeric_value,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(200),'questionnaire','5',5,now())
$q$,'23503','cross-study observation measure rejected');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,numeric_value,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(104),'questionnaire','1.5',1.5,now())
$q$,'23514','integer measures reject fractional values');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,text_value,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(103),'questionnaire','invalid','invalid',now())
$q$,'23514','choice values validated');
INSERT INTO public.observations(id,study_id,participant_id,measure_id,scheduled_assessment_id,source_type,raw_message_id,numeric_value,unit,captured_at)
  VALUES(pg_temp.id(601),pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),pg_temp.id(501),'patient_message',pg_temp.id(401),100,'score',now());
SELECT pg_temp.check_true((SELECT requires_review FROM public.observations WHERE id=pg_temp.id(601)),
  'outliers preserved and flagged rather than discarded');
SELECT pg_temp.check_true((SELECT status='completed' FROM public.scheduled_assessments WHERE id=pg_temp.id(501)),
  'source response completes expected assessment');
SELECT pg_temp.check_true((SELECT completion_rate=0.5 AND assessments_due=2 AND participants=1 FROM analytics.site_metrics WHERE site_id=pg_temp.id(11)),
  'site metrics do not multiply participants or assessments');
SELECT pg_temp.expect_error($q$
  UPDATE public.observations SET numeric_value=5 WHERE id=pg_temp.id(601)
$q$,'23514','source observation cannot be rewritten');
SELECT pg_temp.expect_error('DELETE FROM public.observations','23514','source observations cannot be deleted');
SELECT pg_temp.expect_error('TRUNCATE public.messages CASCADE','23514','source messages cannot be truncated');
SELECT pg_temp.expect_error($q$
  UPDATE public.measure_definitions SET data_type='text' WHERE id=pg_temp.id(100)
$q$,'23514','in-use measure definitions cannot invalidate historical values');
INSERT INTO public.observations(id,study_id,participant_id,measure_id,scheduled_assessment_id,source_type,raw_value,numeric_value,unit,captured_at,supersedes_observation_id)
  VALUES(pg_temp.id(602),pg_temp.id(10),pg_temp.id(111),pg_temp.id(100),pg_temp.id(501),'questionnaire','corrected 5',5,'score',now(),pg_temp.id(601));
SELECT pg_temp.check_true((SELECT count(*)=2 FROM public.observations WHERE participant_id=pg_temp.id(111)),
  'corrections retain original observations');
UPDATE public.observations SET review_status='rejected',reviewed_by=pg_temp.id(1),reviewed_at=now() WHERE id=pg_temp.id(602);
SELECT pg_temp.check_true((SELECT status='pending' FROM public.scheduled_assessments WHERE id=pg_temp.id(501)),
  'rejecting a correction does not resurrect superseded data');
UPDATE public.observations SET review_status='accepted' WHERE id=pg_temp.id(602);
INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,boolean_value,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(101),'questionnaire','no',FALSE,now());
INSERT INTO public.observations(study_id,participant_id,measure_id,source_type,raw_value,json_value,captured_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(102),'device','compound', '{"systolic":120,"diastolic":80}',now());
SELECT pg_temp.check_true((SELECT count(*)=4 FROM public.observations WHERE participant_id=pg_temp.id(111)),
  'boolean false and compound device results supported');

SELECT pg_temp.expect_error($q$
  INSERT INTO public.alerts(study_id,participant_id,assigned_site_id,assigned_staff_id,alert_type,severity,reason,deduplication_key)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(11),pg_temp.id(32),'missing','medium','Contract','bad-route')
$q$,'23514','escalations cannot route to another site coordinator');
INSERT INTO public.alerts(id,study_id,participant_id,assigned_site_id,assigned_staff_id,alert_type,severity,reason,deduplication_key)
  VALUES(pg_temp.id(701),pg_temp.id(10),pg_temp.id(111),pg_temp.id(11),pg_temp.id(31),'missing','medium','Contract','contract-alert');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.alerts(study_id,participant_id,assigned_site_id,alert_type,severity,reason,deduplication_key)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(11),'missing','medium','Contract','contract-alert')
$q$,'23505','unresolved alerts deduplicated');
SELECT pg_temp.expect_error($q$
  UPDATE public.alerts SET status='resolved',resolved_by=pg_temp.id(3),resolved_at=now(),resolution_notes='Contract'
  WHERE id=pg_temp.id(701)
$q$,'23514','another study staff cannot resolve alert');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.workflow_tasks(study_id,participant_id,action_type,deduplication_key)
  VALUES(pg_temp.id(10),pg_temp.id(111),'review_safety','unsafe-task')
$q$,'23514','safety actions require human approval');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.workflow_tasks(study_id,participant_id,action_type,deduplication_key,requires_approval,status,locked_at,locked_by)
  VALUES(pg_temp.id(10),pg_temp.id(111),'review_safety','unsafe-task',TRUE,'running',now(),'contract-worker')
$q$,'23514','unapproved safety task cannot run');
INSERT INTO public.workflow_tasks(id,study_id,participant_id,action_type,deduplication_key)
  VALUES(pg_temp.id(801),pg_temp.id(10),pg_temp.id(111),'send_reminder','contract-reminder');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.workflow_tasks(study_id,participant_id,action_type,deduplication_key)
  VALUES(pg_temp.id(10),pg_temp.id(111),'send_reminder','contract-reminder')
$q$,'23505','workflow retries deduplicated');
SELECT pg_temp.check_true((SELECT count(*)>30 FROM audit.events),'mutations audited');
SELECT pg_temp.expect_error('UPDATE audit.events SET operation=''DELETE''','23514','audit records cannot be rewritten');
SELECT pg_temp.expect_error('TRUNCATE audit.events','23514','audit records cannot be truncated');
SELECT pg_temp.expect_error('DELETE FROM public.participant_events','23514','lifecycle history cannot be deleted');
SELECT pg_temp.expect_error($q$
  UPDATE public.participants SET id=pg_temp.id(999) WHERE id=pg_temp.id(111)
$q$,'23514','entity identity cannot be rewritten');

-- A site-specific ICF overrides the master ICF, even if it has expired.
INSERT INTO public.study_documents(id,study_id,site_id,document_type,version,file_name,storage_uri,review_status,reviewed_by,reviewed_at)
  VALUES(pg_temp.id(1005),pg_temp.id(10),pg_temp.id(11),'icf','local-1','local.pdf','test://local-icf','approved',pg_temp.id(1),now());
INSERT INTO public.consent_documents(id,study_id,site_id,source_document_id,document_name,version,effective_date,expires_on,is_active)
  VALUES(pg_temp.id(1006),pg_temp.id(10),pg_temp.id(11),pg_temp.id(1005),'Local ICF','local-1',CURRENT_DATE-10,CURRENT_DATE-1,TRUE);
SELECT pg_temp.check_true(NOT public.has_current_consent(pg_temp.id(10),pg_temp.id(111)),
  'expired local ICF cannot fall back to previously signed master');
SELECT pg_temp.expect_error($q$
  INSERT INTO public.participant_consents(study_id,participant_id,consent_document_id,status,signed_at,signed_by)
  VALUES(pg_temp.id(10),pg_temp.id(112),pg_temp.id(1006),'signed',now(),'Contract signer')
$q$,'23514','another site cannot use local ICF');
SELECT pg_temp.expect_error($q$
  UPDATE public.messages SET status='sending' WHERE id=pg_temp.id(403)
$q$,'23514','reconsent requirement blocks queued study messages');
UPDATE public.consent_documents SET expires_on=NULL WHERE id=pg_temp.id(1006);
INSERT INTO public.participant_consents(study_id,participant_id,consent_document_id,status,signed_at,signed_by)
  VALUES(pg_temp.id(10),pg_temp.id(111),pg_temp.id(1006),'signed',now(),'Contract signer');
SELECT pg_temp.check_true(public.has_current_consent(pg_temp.id(10),pg_temp.id(111)),'local reconsent restores permission');
UPDATE public.participant_consents SET status='revoked',revoked_at=now()
  WHERE participant_id=pg_temp.id(111) AND consent_document_id=pg_temp.id(1006);
SELECT pg_temp.check_true(NOT public.has_current_consent(pg_temp.id(10),pg_temp.id(111)),'revocation removes current consent');
SELECT pg_temp.expect_error($q$
  UPDATE public.participant_consents SET status='signed',revoked_at=NULL
  WHERE participant_id=pg_temp.id(111) AND consent_document_id=pg_temp.id(1006)
$q$,'23514','revoked signature cannot be restored by rewriting evidence');

UPDATE public.participants SET status='withdrawn',withdrawn_at=now() WHERE id=pg_temp.id(111);
SELECT pg_temp.check_true((SELECT status='cancelled' FROM public.scheduled_assessments WHERE id=pg_temp.id(502)),
  'withdrawal cancels pending assessments');
SELECT pg_temp.check_true((SELECT status='cancelled' FROM public.workflow_tasks WHERE id=pg_temp.id(801)),
  'withdrawal cancels pending workflow tasks');
SELECT pg_temp.check_true((SELECT status='cancelled' FROM public.messages WHERE id=pg_temp.id(403)),
  'withdrawal cancels queued messages');
INSERT INTO public.messages(study_id,participant_id,direction,channel,message_type,body,status,received_at)
  VALUES(pg_temp.id(10),pg_temp.id(111),'inbound','secure_message','support','Late inbound safety source','received',now());
SELECT pg_temp.check_true((SELECT next_action='no_action' FROM analytics.participant_attention WHERE participant_id=pg_temp.id(111)),
  'terminal lifecycle does not recommend new study actions');

-- Exercise views under actual restricted roles, not just the table owner.
SET LOCAL ROLE analyst;
SELECT sum(currently_consented) AS analyst_dashboard_consent FROM analytics.study_dashboard;
SELECT bool_and(has_current_consent IS NOT NULL) AS analyst_attention_consent FROM analytics.participant_attention;
SELECT count(*) AS analyst_assessment_rows FROM analytics.assessment_status;
SELECT count(*) AS analyst_alert_rows FROM analytics.alert_queue;
SELECT count(*) AS analyst_message_metric_rows FROM analytics.message_metrics;
SET LOCAL ROLE manager_agent;
SELECT sum(assessments_overdue) FROM analytics.study_dashboard;
SELECT bool_and(has_current_consent IS NOT NULL) FROM analytics.participant_attention;
RESET ROLE;
SET LOCAL ROLE app_owner;
SELECT pg_temp.expect_error('SET LOCAL ROLE analyst; SELECT * FROM private.participant_contacts','42501','actual analyst contact access denied');
SELECT pg_temp.expect_error('SET LOCAL ROLE patient_agent; SELECT * FROM public.participants','42501','actual unscoped patient access denied');
SELECT pg_temp.check_true(NOT has_schema_privilege('analyst','private','USAGE'),'analyst cannot access contact schema');
SELECT pg_temp.check_true(NOT has_table_privilege('analyst','private.participant_contacts','SELECT'),'analyst cannot read contacts');
SELECT pg_temp.check_true(NOT has_table_privilege('analyst','public.messages','SELECT'),'analyst cannot read raw messages');
SELECT pg_temp.check_true(NOT has_table_privilege('patient_agent','public.participants','SELECT'),'patient agent fails closed without scoped auth');
SELECT pg_temp.check_true(NOT has_table_privilege('manager_agent','private.staff_users','SELECT'),'manager analytics role cannot read staff identities');
\o
SELECT count(*) AS passed_contract_checks FROM contract_checks;
ROLLBACK;
