-- A synthetic migraine study, set up the way the consent-first platform requires (staff approval,
-- approved protocol extraction, approved ICF), plus the assistant's optional presentation rows.
-- For scratch and demo databases only: it refuses to run in clinical_trials, where real study
-- data comes from the platform team.
--   npm run seed -- db/seeds/demo_study.sql   (with DATABASE_NAME pointing at a scratch database)
do $$
begin
  if current_database() = 'clinical_trials' then
    raise exception 'demo_study.sql is for scratch databases; clinical_trials gets its studies from the platform';
  end if;
end $$;

set local role app_owner;

do $$
declare
  staff uuid;
  study uuid;
  bos uuid;
  cam uuid;
  protocol uuid;
  icf uuid;
  consent uuid;
  measure uuid;
begin
  if exists (select 1 from public.studies where study_code = 'NORTHSTAR-DEMO') then
    raise notice 'NORTHSTAR-DEMO already exists';
    return;
  end if;

  insert into private.staff_users (auth_subject, display_name, email)
  values ('demo-coordinator', 'Dana Whitfield (demo coordinator)', 'coordinator@example.org') returning id into staff;

  insert into public.studies (study_code, title, condition, phase, study_type, design, intervention, sponsor, protocol_id, protocol_version,
                              target_enrollment, duration_weeks, primary_outcome, is_synthetic)
  values ('NORTHSTAR-DEMO', 'A 12-week study of NS-210 to prevent migraine attacks in adults with episodic migraine', 'Episodic migraine',
          'Phase 2', 'interventional', 'Randomized, double-blind, placebo-controlled', 'NS-210, a once-daily tablet', 'Northstar Therapeutics (synthetic)',
          'NS210-201', '1.0', 120, 12, 'Change in monthly migraine days from baseline to weeks 9 to 12', true)
  returning id into study;

  insert into public.sites (study_id, site_code, institution_name, city, state, time_zone, status, principal_investigator)
  values (study, 'BOS', 'Back Bay Neurology Research', 'Boston', 'MA', 'America/New_York', 'active', 'Dr. Priya Raman') returning id into bos;
  insert into public.sites (study_id, site_code, institution_name, city, state, time_zone, status, principal_investigator)
  values (study, 'CAM', 'Kendall Square Clinical Research', 'Cambridge', 'MA', 'America/New_York', 'active', 'Dr. Marcus Feld') returning id into cam;

  insert into public.study_staff (study_id, staff_user_id, role) values (study, staff, 'coordinator');

  insert into public.study_documents (study_id, document_type, version, file_name, storage_uri, sha256, is_current, review_status, uploaded_by, reviewed_by, reviewed_at)
  values (study, 'protocol', '1.0', 'NS210-201-protocol-v1.0.pdf', 'demo://northstar/protocol-v1.0.pdf', encode(sha256('northstar protocol v1.0'), 'hex'),
          true, 'approved', staff, staff, now())
  returning id into protocol;
  insert into public.document_extractions (study_id, source_document_id, extractor, proposed_data, status, reviewed_by, reviewed_at)
  values (study, protocol, 'demo-seed', '{"note": "synthetic"}', 'approved', staff, now());
  update public.studies set status = 'active', approved_by = staff, approved_at = now() where id = study;

  insert into public.study_documents (study_id, document_type, version, file_name, storage_uri, sha256, is_current, review_status, uploaded_by, reviewed_by, reviewed_at)
  values (study, 'icf', '1.0', 'NS210-201-ICF-v1.0.pdf', 'demo://northstar/icf-v1.0.pdf', encode(sha256('northstar icf v1.0'), 'hex'),
          true, 'approved', staff, staff, now())
  returning id into icf;
  insert into public.consent_documents (study_id, source_document_id, document_name, version, effective_date, is_active)
  values (study, icf, 'Consent to take part in the NORTHSTAR study', '1.0', current_date - 1, true)
  returning id into consent;

  insert into public.study_arms (study_id, arm_code, name, description, intervention_name, dose, frequency, is_control, allocation_ratio) values
    (study, 'NS210', 'NS-210', 'One NS-210 tablet each morning for 12 weeks', 'NS-210', '50 mg', 'once daily', false, 1),
    (study, 'PBO', 'Placebo', 'One placebo tablet (looks the same, no medicine) each morning for 12 weeks', 'Placebo', null, 'once daily', true, 1);

  insert into public.eligibility_rules (study_id, rule_type, description, field_name, operator, rule_value, sort_order) values
    (study, 'inclusion', 'Aged 18 to 65', 'age', 'between', '[18, 65]', 10),
    (study, 'inclusion', 'Diagnosed with migraine at least a year ago', null, null, null, 20),
    (study, 'inclusion', '4 to 14 migraine days a month', 'migraine_days_per_month', 'between', '{"min": 4, "max": 14}', 30),
    (study, 'exclusion', '15 or more headache days a month', 'headache_days_per_month', '>=', '15', 40),
    (study, 'exclusion', 'Pregnant, breastfeeding, or planning a pregnancy during the study', 'pregnant', '=', 'true', 50),
    (study, 'exclusion', 'Already taking a daily medicine to prevent migraine', 'preventive_medication', 'is_true', null, 60);

  insert into public.measure_definitions (study_id, measure_code, label, prompt, data_type, unit, min_value, max_value, choices, source_type) values
    (study, 'migraine_today', 'Migraine today', 'Did you have a migraine today?', 'boolean', null, null, null, null, 'patient_message'),
    (study, 'pain_score', 'Worst pain today', 'How bad was your worst headache pain today? (0 = none, 10 = worst)', 'integer', null, 0, 10, null, 'patient_message'),
    (study, 'dose_taken', 'Took study tablet', 'Did you take your study tablet today?', 'boolean', null, null, null, null, 'patient_message'),
    (study, 'acute_medication', 'Rescue medicine', 'Which rescue medicine did you take today, if any?', 'choice', null, null, null,
       '["none", "triptan", "nsaid", "acetaminophen", "other"]', 'patient_message'),
    (study, 'sleep_hours', 'Sleep', 'How many hours did you sleep last night?', 'numeric', 'hours', 0, 16, null, 'patient_message');
  for measure in select id from public.measure_definitions where study_id = study loop
    insert into public.assessment_schedules (study_id, measure_id, schedule_code, frequency, anchor_event, times_of_day, is_active)
    select study, measure, 'daily_' || measure_code, 'daily', 'activation', array['19:00'::time], true from public.measure_definitions where id = measure;
  end loop;

  raise notice 'Created NORTHSTAR-DEMO % with consent document % (staff demo-coordinator)', study, consent;
end $$;

-- The assistant's optional presentation rows for the demo study (safe to re-run).
do $$
declare
  study uuid := (select id from public.studies where study_code = 'NORTHSTAR-DEMO');
  bos uuid := (select id from public.sites where study_id = study and site_code = 'BOS');
  cam uuid := (select id from public.sites where study_id = study and site_code = 'CAM');
begin
  insert into assistant.study_profiles (study_id, short_name, patient_summary, time_commitment, compensation, contact_phone, agent_instructions)
  values (study, 'NORTHSTAR', 'NORTHSTAR is testing whether a once-daily tablet, NS-210, can mean fewer migraine days for adults who get 4 to 14 a month.',
          'About 12 weeks: 4 clinic visits and a 1-minute daily check-in by text', 'Up to $600 for completed visits, plus parking or transit',
          '(617) 555-0142',
          'Participants keep a daily migraine diary through the check-in card. Ask about rescue medicines plainly; never suggest changing doses.')
  on conflict (study_id) do nothing;

  insert into assistant.prescreen_questions (study_id, key, position, prompt, help, type, unit, min_value, max_value) values
    (study, 'age', 10, 'How old are you?', null, 'number', 'years', 12, 110),
    (study, 'migraine_days_per_month', 30, 'In a typical month, how many days do you have a migraine?', 'Your best guess is fine.', 'number', 'days', 0, 31),
    (study, 'headache_days_per_month', 40, 'And how many days a month do you have any headache at all?', 'Include migraines and milder headaches.', 'number', 'days', 0, 31),
    (study, 'preventive_medication', 60, 'Do you take a medicine every day to prevent migraines?', 'For example topiramate, propranolol or a monthly injection. Not the medicine you take during an attack.', 'yes_no', null, null, null)
  on conflict (study_id, key) do nothing;
  insert into assistant.prescreen_questions (study_id, key, position, prompt, type, options, show_if) values
    (study, 'sex', 45, 'What was your sex at birth?', 'choice',
       '[{"value": "female", "label": "Female"}, {"value": "male", "label": "Male"}, {"value": "intersex", "label": "Intersex"}, {"value": "prefer_not", "label": "Prefer not to say"}]', null)
  on conflict (study_id, key) do nothing;
  insert into assistant.prescreen_questions (study_id, key, position, prompt, type, show_if) values
    (study, 'pregnant', 50, 'Are you pregnant, breastfeeding, or planning a pregnancy in the next 4 months?', 'yes_no',
       '{"key": "sex", "in": ["female", "intersex", "prefer_not"]}')
  on conflict (study_id, key) do nothing;

  insert into assistant.site_hours (site_id, weekday, opens, closes, slot_minutes)
  select bos, d, '08:30'::time, '16:30'::time, 60 from generate_series(1, 5) d
  union all select cam, d, '10:00'::time, '18:00'::time, 60 from unnest(array[2, 4]) d
  on conflict do nothing;

  raise notice 'NORTHSTAR-DEMO presentation rows are in place';
end $$;
