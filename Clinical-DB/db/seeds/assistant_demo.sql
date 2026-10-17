-- Demo content for the patient assistant: prescreen questions, a consent form and site hours for
-- the two fictional trials in demo.sql. Run after demo.sql (which recreates those trials). Safe to
-- re-run; it replaces this content but keeps people's engagements and signatures.
--   docker compose exec -T postgres psql -U postgres -d clinical_trials -f /db/seeds/assistant_demo.sql
\set ON_ERROR_STOP on
begin;
set local role app_owner;

select id as ns from trial.trials where code = 'NORTHSTAR-2' \gset
select id as br from trial.trials where code = 'BREATHE-1' \gset

-- Prescreen questions -------------------------------------------------------------
delete from assistant.prescreen_questions where trial_id in (:'ns'::uuid, :'br'::uuid);

insert into assistant.prescreen_questions (trial_id, key, position, prompt, help, type, options, unit, min_value, max_value, required, show_if, criterion, eligibility_criterion_id)
select t.id, q.key, q.position, q.prompt, q.help, q.type, q.options::jsonb, q.unit, q.min_value, q.max_value, q.required,
       q.show_if::jsonb, q.criterion::jsonb,
       (select id from trial.eligibility_criteria ec where ec.trial_id = t.id and ec.kind = q.ec_kind and ec.position = q.ec_position)
from (values
  ('NORTHSTAR-2', 'first_name', 1, 'First, what should we call you?', null, 'text', null, null, null, null, true, null, null, null, null),
  ('NORTHSTAR-2', 'age', 2, 'How old are you?', null, 'number', null, 'years', 0, 120, true, null,
   '{"kind": "inclusion", "min": 18, "max": 65, "label": "Aged 18 to 65"}', 'inclusion', 1),
  ('NORTHSTAR-2', 'migraine_diagnosis', 3, 'Has a doctor diagnosed you with migraine?', null, 'yes_no', null, null, null, null, true, null,
   '{"kind": "inclusion", "equals": true, "label": "Diagnosed with migraine"}', null, null),
  ('NORTHSTAR-2', 'migraine_days', 4, 'Over the last 3 months, about how many days a month did you have a migraine?',
   'Your best guess is fine.', 'number', null, 'days a month', 0, 31, true, null,
   '{"kind": "inclusion", "min": 4, "max": 14, "label": "4 to 14 migraine days a month"}', 'inclusion', 2),
  ('NORTHSTAR-2', 'headache_days', 5, 'Counting every kind of headache, how many days a month do you have one?',
   null, 'number', null, 'days a month', 0, 31, true, null,
   '{"kind": "exclusion", "min": 15, "label": "Headache on 15 or more days a month (chronic migraine)"}', 'exclusion', 1),
  ('NORTHSTAR-2', 'sex', 6, 'What sex were you assigned at birth?', 'Some study medicines need extra care during pregnancy.', 'choice',
   '[{"value": "female", "label": "Female"}, {"value": "male", "label": "Male"}, {"value": "intersex", "label": "Intersex"}, {"value": "prefer_not", "label": "Prefer not to say"}]',
   null, null, null, true, null, null, null, null),
  ('NORTHSTAR-2', 'pregnancy', 7, 'Are you pregnant, breastfeeding, or planning a pregnancy in the next 6 months?', null, 'yes_no', null, null, null, null, true,
   '{"key": "sex", "in": ["female", "intersex", "prefer_not"]}',
   '{"kind": "exclusion", "equals": true, "label": "Pregnant, breastfeeding or planning pregnancy"}', 'exclusion', 2),
  ('NORTHSTAR-2', 'preventive_medication', 8, 'Do you take a daily medicine to prevent migraines?',
   'For example topiramate, propranolol or a monthly injection.', 'yes_no', null, null, null, null, true, null,
   '{"kind": "review", "equals": true, "label": "Takes a preventive medicine (the study doctor checks whether a break is needed)"}', null, null),
  ('NORTHSTAR-2', 'preferred_site', 9, 'Which clinic is easier for you to get to?', null, 'choice',
   '[{"value": "BOS", "label": "Boston (Longwood)"}, {"value": "CAM", "label": "Cambridge (Kendall Square)"}, {"value": "either", "label": "Either works"}]',
   null, null, null, false, null, null, null, null),
  ('NORTHSTAR-2', 'best_times', 10, 'When are you usually free for a visit?', 'Pick all that apply.', 'multi_choice',
   '[{"value": "morning", "label": "Mornings"}, {"value": "midday", "label": "Midday"}, {"value": "afternoon", "label": "Afternoons"}]',
   null, null, null, false, null, null, null, null),
  ('BREATHE-1', 'first_name', 1, 'First, what should we call you?', null, 'text', null, null, null, null, true, null, null, null, null),
  ('BREATHE-1', 'age', 2, 'How old are you?', null, 'number', null, 'years', 0, 120, true, null,
   '{"kind": "inclusion", "min": 18, "label": "18 or older"}', 'inclusion', 1),
  ('BREATHE-1', 'asthma_diagnosis', 3, 'Has a doctor diagnosed you with asthma that needs a daily inhaler?', null, 'yes_no', null, null, null, null, true, null,
   '{"kind": "inclusion", "equals": true, "label": "Moderate persistent asthma"}', 'inclusion', 1),
  ('BREATHE-1', 'smoker', 4, 'Do you currently smoke?', null, 'yes_no', null, null, null, null, true, null,
   '{"kind": "exclusion", "equals": true, "label": "Current smoker"}', 'exclusion', 1),
  ('BREATHE-1', 'copd', 5, 'Have you ever been told you have COPD or emphysema?', null, 'yes_no', null, null, null, null, true, null,
   '{"kind": "exclusion", "equals": true, "label": "COPD"}', 'exclusion', 2)
) as q (trial_code, key, position, prompt, help, type, options, unit, min_value, max_value, required, show_if, criterion, ec_kind, ec_position)
join trial.trials t on t.code = q.trial_code;

-- Consent form ----------------------------------------------------------------------
delete from assistant.consent_documents d
where d.trial_id = :'ns'::uuid and not exists (select 1 from assistant.signatures s where s.document_id = d.id);

insert into assistant.consent_documents (trial_id, version, title, summary, sections, comprehension)
select :'ns'::uuid, '1.0', 'NORTHSTAR-2 informed consent (demo)',
  'A study of whether a fictional medicine, HV-101, prevents migraines. You would take a pill once a day for 4 weeks, answer a short daily check-in by text, and visit the clinic 4 times. Taking part is your choice, and you can stop at any time.',
  $json$[
    {"id": "about", "heading": "Why is this study being done?", "key_point": true,
     "body": "Researchers want to learn whether HV-101, an investigational medicine, lowers the number of migraine days. \"Investigational\" means it is not approved by the FDA. This is a demo document for a fictional study; no real medicine or study is involved."},
    {"id": "what_happens", "heading": "What will happen if I join?", "key_point": true,
     "body": "You will be randomly assigned, like flipping a coin, to one of three groups: HV-101 50 mg, HV-101 100 mg, or a placebo (a pill with no medicine). Neither you nor the study team will know which group you are in. You will take one pill every morning for 4 weeks and answer a 1-minute check-in by text each evening about your headaches, sleep and how you feel."},
    {"id": "visits", "heading": "How long will I be in the study?", "key_point": false,
     "body": "About 6 weeks: a screening visit, a baseline visit, visits at week 2 and week 4, and a safety follow-up two weeks later. Each visit takes about an hour. Most check-ins happen by text."},
    {"id": "risks", "heading": "What are the risks?", "key_point": true,
     "body": "The most common side effects seen so far were nausea, tiredness and dizziness, usually mild. There may be risks we don't know about yet. Tell the study team about anything that bothers you; you can text the assistant any time and it will pass it on. In an emergency, call 911."},
    {"id": "benefits", "heading": "Will I benefit?", "key_point": false,
     "body": "You may or may not have fewer migraines. What we learn may help other people with migraine in the future."},
    {"id": "alternatives", "heading": "What are my other options?", "key_point": false,
     "body": "You don't have to join to get care for migraines. Approved preventive medicines and other treatments are available; your own doctor can talk with you about them."},
    {"id": "privacy", "heading": "How is my information protected?", "key_point": true,
     "body": "Your study records use a code instead of your name. Your text messages with the assistant are stored securely and seen only by the study team. Results published from the study will never identify you."},
    {"id": "costs", "heading": "Will it cost anything? Will I be paid?", "key_point": false,
     "body": "Study visits and the study medicine are free. You will receive $75 for each completed visit to cover your time and travel."},
    {"id": "voluntary", "heading": "Taking part is your choice", "key_point": true,
     "body": "You can say no, or stop at any time, without losing any care you would otherwise get. To stop, just text the assistant or call the study team."},
    {"id": "contacts", "heading": "Who can I talk to?", "key_point": false,
     "body": "Study doctor: Dr. Avery Chen, Charles River Clinical Research Center (fictional). Questions about your rights as a research participant: the (fictional) Charles River Institutional Review Board."}
  ]$json$::jsonb,
  $json$[
    {"id": "voluntary", "question": "Can you stop being in the study whenever you want?", "options": ["Yes, at any time", "Only after the first month", "No"], "answer": 0},
    {"id": "placebo", "question": "Will everyone in the study get HV-101?", "options": ["Yes", "No, some people get a placebo"], "answer": 1},
    {"id": "emergency", "question": "What should you do in a medical emergency?", "options": ["Text the assistant and wait", "Call 911"], "answer": 1}
  ]$json$::jsonb
where not exists (select 1 from assistant.consent_documents where trial_id = :'ns'::uuid and version = '1.0');

-- Site hours for screening visits ----------------------------------------------------
delete from assistant.site_hours where site_id in (select id from trial.sites where trial_id in (:'ns'::uuid, :'br'::uuid));
insert into assistant.site_hours (site_id, weekday, opens, closes, slot_minutes)
select s.id, h.weekday, h.opens::time, h.closes::time, h.slot
from trial.sites s
join (values
  ('NORTHSTAR-2', 'BOS', 1, '09:00', '16:00', 60), ('NORTHSTAR-2', 'BOS', 2, '09:00', '16:00', 60),
  ('NORTHSTAR-2', 'BOS', 3, '09:00', '16:00', 60), ('NORTHSTAR-2', 'BOS', 4, '09:00', '16:00', 60),
  ('NORTHSTAR-2', 'BOS', 5, '09:00', '13:00', 60),
  ('NORTHSTAR-2', 'CAM', 2, '10:00', '15:00', 45), ('NORTHSTAR-2', 'CAM', 4, '10:00', '15:00', 45),
  ('BREATHE-1', 'BOS', 1, '08:00', '12:00', 60), ('BREATHE-1', 'BOS', 3, '08:00', '12:00', 60),
  ('BREATHE-1', 'CHI', 2, '09:00', '15:00', 60), ('BREATHE-1', 'CHI', 4, '09:00', '15:00', 60)
) as h (trial_code, site_code, weekday, opens, closes, slot)
  on s.code = h.site_code
join trial.trials t on t.id = s.trial_id and t.code = h.trial_code;

commit;

select 'prescreen questions' as item, count(*) from assistant.prescreen_questions
union all select 'consent documents', count(*) from assistant.consent_documents
union all select 'site hours', count(*) from assistant.site_hours;
