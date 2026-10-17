-- Synthetic demo data: two fictional trials with staff, participants, about a month of observations
-- from several sources, adverse events, visits, check-ins, and sample patient and manager agent
-- conversations. Everything is fake: is_synthetic = true, and phone numbers use the reserved
-- 555-01xx range. Safe to re-run; it replaces the previous demo data.
--   docker compose exec -T postgres psql -U postgres -d clinical_trials -f /db/seeds/demo.sql
\set ON_ERROR_STOP on
begin;
set local role app_owner;
select setseed(0.2026);

delete from trial.trials where code in ('NORTHSTAR-2', 'BREATHE-1');
delete from core.people where is_synthetic;

-- People ------------------------------------------------------------------------
insert into core.people (display_name, phone_e164, email, timezone, is_synthetic) values
  ('Dr. Avery Chen', '+16175550100', 'avery.chen@example.org', 'America/New_York', true),
  ('Jordan Okafor', '+16175550101', 'jordan.okafor@example.org', 'America/New_York', true),
  ('Dr. Sam Rivera', '+16175550102', 'sam.rivera@example.org', 'America/Chicago', true);

insert into core.people (display_name, phone_e164, timezone, is_synthetic)
select n.first || ' ' || n.last, '+1617555' || lpad((110 + g)::text, 4, '0'), 'America/New_York', true
from generate_series(1, 36) g
cross join lateral (
  select (array['Maya', 'Liam', 'Priya', 'Noah', 'Ava', 'Ethan', 'Sofia', 'Lucas', 'Zoe', 'Mateo', 'Chloe', 'Owen',
                'Isla', 'Arjun', 'Nora', 'Leo', 'Hana', 'Caleb'])[1 + (g - 1) % 18] as first,
         (array['Brooks', 'Nguyen', 'Shah', 'Kim', 'Lopez', 'Patel', 'Murphy', 'Cohen', 'Okoro', 'Silva', 'Tanaka', 'Walsh'])[1 + (g * 7) % 12] as last
) n;

-- Trials --------------------------------------------------------------------------
insert into trial.trials (code, title, short_title, phase, status, therapeutic_area, intervention, sponsor, description,
                          primary_endpoint, target_enrollment, start_date, timezone, is_synthetic, settings) values
  ('NORTHSTAR-2', 'NORTHSTAR-2: HV-101 for prevention of episodic migraine', 'NORTHSTAR-2', 'II', 'active', 'Neurology',
   'HV-101 (fictional), oral, once daily', 'Demo Sponsor (fictional)',
   'Randomized, double-blind, placebo-controlled study of two doses of a fictional compound. Patients report symptoms daily to the trial''s iMessage agent.',
   'Change from baseline in daily headache pain score (0-10) at week 4', 30, current_date - 35, 'America/New_York', true,
   '{"evening_check_in": "20:00"}'),
  ('BREATHE-1', 'BREATHE-1: Remote monitoring of moderate asthma with AZ-7', 'BREATHE-1', 'III', 'recruiting', 'Pulmonology',
   'AZ-7 (fictional) maintenance inhaler, twice daily', 'Demo Sponsor (fictional)',
   'Open-label study comparing a fictional maintenance inhaler with standard care, using home peak-flow meters and iMessage check-ins.',
   'Mean morning peak expiratory flow at week 3', 20, current_date - 25, 'America/New_York', true, '{}');

select id as ns from trial.trials where code = 'NORTHSTAR-2' \gset
select id as br from trial.trials where code = 'BREATHE-1' \gset

insert into trial.arms (trial_id, code, name, description, is_control, target_enrollment) values
  (:'ns'::uuid, 'placebo', 'Placebo', 'Matching placebo tablet', true, 10),
  (:'ns'::uuid, 'hv101_50', 'HV-101 50 mg', 'HV-101 50 mg once daily', false, 10),
  (:'ns'::uuid, 'hv101_100', 'HV-101 100 mg', 'HV-101 100 mg once daily', false, 10),
  (:'br'::uuid, 'az7', 'AZ-7', 'AZ-7 maintenance inhaler, two puffs twice daily', false, 10),
  (:'br'::uuid, 'standard_care', 'Standard care', 'Usual maintenance therapy', true, 10);

insert into trial.sites (trial_id, code, name, city, region, principal_investigator) values
  (:'ns'::uuid, 'BOS', 'Charles River Clinical Research Center (fictional)', 'Boston', 'MA', 'Dr. Avery Chen'),
  (:'ns'::uuid, 'CAM', 'Kendall Square Neurology Partners (fictional)', 'Cambridge', 'MA', 'Dr. Lena Ortiz'),
  (:'br'::uuid, 'CHI', 'Lakeshore Respiratory Institute (fictional)', 'Chicago', 'IL', 'Dr. Sam Rivera'),
  (:'br'::uuid, 'BOS', 'Back Bay Pulmonary (fictional)', 'Boston', 'MA', 'Dr. Grace Liu');

insert into trial.staff (trial_id, person_id, role)
select :'ns'::uuid, id, 'manager' from core.people where phone_e164 = '+16175550100'
union all select :'ns'::uuid, id, 'investigator' from core.people where phone_e164 = '+16175550100'
union all select :'ns'::uuid, id, 'coordinator' from core.people where phone_e164 = '+16175550101'
union all select :'br'::uuid, id, 'manager' from core.people where phone_e164 = '+16175550102';

insert into trial.eligibility_criteria (trial_id, kind, position, description, rule) values
  (:'ns'::uuid, 'inclusion', 1, 'Adults aged 18 to 65', '{"measure": "age", "min": 18, "max": 65}'),
  (:'ns'::uuid, 'inclusion', 2, '4 to 14 migraine days per month for the past 3 months', null),
  (:'ns'::uuid, 'exclusion', 1, 'Chronic migraine (15 or more headache days per month)', null),
  (:'ns'::uuid, 'exclusion', 2, 'Pregnant or breastfeeding', null),
  (:'br'::uuid, 'inclusion', 1, 'Adults 18 and older with moderate persistent asthma', '{"measure": "age", "min": 18}'),
  (:'br'::uuid, 'exclusion', 1, 'Current smoker or more than 10 pack-years', null),
  (:'br'::uuid, 'exclusion', 2, 'Diagnosis of COPD', null);

insert into trial.measures (trial_id, code, label, description, category, value_type, unit, min_value, max_value, is_primary_endpoint) values
  (:'ns'::uuid, 'pain_score', 'Headache pain', 'Worst headache pain today: 0 none, 10 worst imaginable', 'symptom', 'scale', null, 0, 10, true),
  (:'ns'::uuid, 'headache_today', 'Headache today', 'Had any headache today', 'symptom', 'boolean', null, null, null, false),
  (:'ns'::uuid, 'dose_taken', 'Dose taken', 'Took today''s study dose', 'adherence', 'boolean', null, null, null, false),
  (:'ns'::uuid, 'sleep_hours', 'Sleep', 'Hours slept last night', 'lifestyle', 'number', 'h', 0, 24, false),
  (:'ns'::uuid, 'nausea', 'Nausea', 'Any nausea today', 'symptom', 'boolean', null, null, null, false),
  (:'ns'::uuid, 'weight_kg', 'Weight', 'Body weight', 'vital', 'number', 'kg', 30, 250, false),
  (:'br'::uuid, 'peak_flow', 'Morning peak flow', 'Best of three morning peak expiratory flow readings', 'vital', 'number', 'L/min', 50, 800, true),
  (:'br'::uuid, 'rescue_puffs', 'Rescue inhaler puffs', 'Puffs of rescue inhaler in the last 24 hours', 'symptom', 'integer', 'puffs', 0, 40, false),
  (:'br'::uuid, 'night_symptoms', 'Night symptoms', 'Woke up at night because of asthma', 'symptom', 'boolean', null, null, null, false),
  (:'br'::uuid, 'dose_taken', 'Doses taken', 'Took both maintenance doses today', 'adherence', 'boolean', null, null, null, false);

insert into trial.schedule_events (trial_id, code, name, day_offset, window_before_days, window_after_days) values
  (:'ns'::uuid, 'screening', 'Screening', -14, 7, 0),
  (:'ns'::uuid, 'baseline', 'Baseline / randomization', 0, 0, 0),
  (:'ns'::uuid, 'week_2', 'Week 2 visit', 14, 2, 2),
  (:'ns'::uuid, 'week_4', 'Week 4 visit (primary endpoint)', 28, 3, 3),
  (:'ns'::uuid, 'follow_up', 'Safety follow-up', 42, 3, 7),
  (:'br'::uuid, 'baseline', 'Baseline', 0, 0, 0),
  (:'br'::uuid, 'week_3', 'Week 3 visit (primary endpoint)', 21, 3, 3);

insert into trial.collection_plans (trial_id, measure_id, frequency, local_time, days_of_week, prompt)
select m.trial_id, m.id, p.frequency, p.local_time::time, p.days::smallint[], p.prompt
from (values
  ('NORTHSTAR-2', 'pain_score', 'daily', '20:00', null, 'Hi {first_name}, evening check-in: on a scale of 0 to 10, how bad was your worst headache today?'),
  ('NORTHSTAR-2', 'headache_today', 'daily', '20:00', null, 'Did you have any headache today?'),
  ('NORTHSTAR-2', 'nausea', 'daily', '20:00', null, 'Any nausea today?'),
  ('NORTHSTAR-2', 'dose_taken', 'daily', '09:00', null, 'Good morning {first_name}! Did you take your study dose today?'),
  ('NORTHSTAR-2', 'sleep_hours', 'daily', '09:00', null, 'About how many hours did you sleep last night?'),
  ('NORTHSTAR-2', 'weight_kg', 'weekly', '09:00', '{1}', 'Monday weigh-in: what does the scale say this morning?'),
  ('BREATHE-1', 'peak_flow', 'daily', '08:00', null, 'Morning {first_name}! What was your best peak flow reading today?'),
  ('BREATHE-1', 'night_symptoms', 'daily', '08:00', null, 'Did asthma wake you up last night?'),
  ('BREATHE-1', 'rescue_puffs', 'daily', '20:00', null, 'How many puffs of your rescue inhaler did you use today?'),
  ('BREATHE-1', 'dose_taken', 'daily', '21:00', null, 'Did you take both maintenance doses today?')
) as p (trial_code, measure_code, frequency, local_time, days, prompt)
join trial.trials t on t.code = p.trial_code
join trial.measures m on m.trial_id = t.id and m.code = p.measure_code;

insert into trial.agent_profiles (trial_id, audience, name, system_prompt, settings) values
  (:'ns'::uuid, 'patient', 'NORTHSTAR-2 study companion',
   'You are the study companion for the NORTHSTAR-2 migraine trial, texting with one participant over iMessage. Be warm, brief and plain-spoken. Collect the daily check-in answers, record them precisely, and thank people for their time. Never give medical advice, change doses or interpret results. If someone describes a severe or worrying symptom, record it as an adverse event and tell them the study team will follow up; for emergencies tell them to call 911.',
   '{"quiet_hours": ["21:30", "08:00"], "escalate_ae_grade": 3}'),
  (:'ns'::uuid, 'manager', 'NORTHSTAR-2 trial analyst',
   'You help the NORTHSTAR-2 trial manager over iMessage. Answer with short, numbers-first summaries that fit on a phone screen. Use subject codes, never names. Say what you measured and over what period. Query only the analytics views.',
   '{"weekly_summary": "Mon 08:00"}'),
  (:'br'::uuid, 'patient', 'BREATHE-1 study companion',
   'You are the study companion for the BREATHE-1 asthma trial. Collect morning peak flow and daily symptom answers. Never give medical advice. If someone has trouble breathing that their rescue inhaler doesn''t fix, tell them to call 911 now.',
   '{"escalate_ae_grade": 3}'),
  (:'br'::uuid, 'manager', 'BREATHE-1 trial analyst',
   'You help the BREATHE-1 trial manager over iMessage with short, numbers-first answers. Use subject codes only. Query only the analytics views.', '{}');

-- Participants -----------------------------------------------------------------
insert into trial.participants (trial_id, person_id, arm_id, site_id, subject_code, status, consented_at, enrolled_at,
                                withdrawn_at, withdrawal_reason, sex, birth_year, is_synthetic)
select :'ns'::uuid, pe.id,
  (select id from trial.arms where trial_id = :'ns'::uuid and code = (array['placebo', 'hv101_50', 'hv101_100'])[1 + (pe.n - 1) % 3]),
  (select id from trial.sites where trial_id = :'ns'::uuid and code = (array['BOS', 'CAM'])[1 + (pe.n - 1) % 2]),
  'NS2-' || lpad(pe.n::text, 3, '0'),
  case when pe.n = 7 then 'withdrawn' when pe.n = 24 then 'screening' else 'active' end,
  now() - make_interval(days => 30 + pe.n % 5),
  case when pe.n <> 24 then now() - make_interval(days => 28 + pe.n % 5) end,
  case when pe.n = 7 then now() - interval '16 days' end,
  case when pe.n = 7 then 'Moved out of state' end,
  (array['female', 'male'])[1 + pe.n % 2], (1960 + (pe.n * 13) % 45)::smallint, true
from (select id, row_number() over (order by phone_e164)::int as n
      from core.people where is_synthetic and phone_e164 between '+16175550111' and '+16175550134') pe;

insert into trial.participants (trial_id, person_id, arm_id, site_id, subject_code, status, consented_at, enrolled_at,
                                sex, birth_year, is_synthetic)
select :'br'::uuid, pe.id,
  (select id from trial.arms where trial_id = :'br'::uuid and code = (array['az7', 'standard_care'])[1 + (pe.n - 1) % 2]),
  (select id from trial.sites where trial_id = :'br'::uuid and code = (array['CHI', 'BOS'])[1 + (pe.n - 1) % 2]),
  'BR1-' || lpad(pe.n::text, 3, '0'),
  case when pe.n = 12 then 'screening' else 'active' end,
  now() - make_interval(days => 23 + pe.n % 4),
  case when pe.n <> 12 then now() - make_interval(days => 21 + pe.n % 4) end,
  (array['female', 'male'])[1 + pe.n % 2], (1955 + (pe.n * 11) % 50)::smallint, true
from (select id, row_number() over (order by phone_e164)::int as n
      from core.people where is_synthetic and phone_e164 between '+16175550135' and '+16175550146') pe;

-- Visits: baseline done; later visits done if their day has passed, otherwise scheduled.
insert into clinical.visits (trial_id, participant_id, schedule_event_id, scheduled_on, completed_at, status)
select p.trial_id, p.id, se.id,
  (p.enrolled_at + make_interval(days => se.day_offset))::date,
  case when p.enrolled_at + make_interval(days => se.day_offset) < now() - interval '1 day'
            and (p.withdrawn_at is null or p.enrolled_at + make_interval(days => se.day_offset) < p.withdrawn_at)
       then p.enrolled_at + make_interval(days => se.day_offset, hours => 2) end,
  case when p.enrolled_at + make_interval(days => se.day_offset) < now() - interval '1 day'
            and (p.withdrawn_at is null or p.enrolled_at + make_interval(days => se.day_offset) < p.withdrawn_at) then 'completed'
       when p.withdrawn_at is not null then 'cancelled'
       else 'scheduled' end
from trial.participants p
join trial.schedule_events se on se.trial_id = p.trial_id and se.day_offset >= 0
where p.enrolled_at is not null;

-- Synthetic daily data ------------------------------------------------------------
-- One row per participant per study day up to yesterday, with the latent values that drive
-- each measure. About 8% of days are missing. The three participants with demo conversations
-- (NS2-001..003) get their last three days from the patient agent instead.
create temp table demo_days on commit drop as
select
  p.id as participant_id, p.trial_id, t.code as trial_code, a.code as arm_code, p.subject_code, d.day,
  (date_trunc('day', p.enrolled_at at time zone t.timezone) + make_interval(days => d.day)) at time zone t.timezone as day_start,
  random() as r1, random() as r2, random() as r3, random() as r4, random() as missing_roll,
  pr.base_level, pr.adherence
from trial.participants p
join trial.trials t on t.id = p.trial_id
join trial.arms a on a.id = p.arm_id
cross join lateral (select 4.5 + random() * 2 as base_level,
                           case when p.subject_code in ('NS2-006', 'NS2-012', 'BR1-005') then 0.7 else 0.93 + random() * 0.06 end as adherence) pr
cross join lateral generate_series(1, ((coalesce(p.withdrawn_at, now()) at time zone t.timezone)::date
                                       - (p.enrolled_at at time zone t.timezone)::date) - 1) as d(day)
where p.enrolled_at is not null and t.code in ('NORTHSTAR-2', 'BREATHE-1');

delete from demo_days where missing_roll < 0.08;
delete from demo_days where subject_code in ('NS2-001', 'NS2-002', 'NS2-003')
  and day_start > date_trunc('day', now()) - interval '4 days';

-- NORTHSTAR-2: pain falls faster on active drug; nausea is commoner at the higher dose.
alter table demo_days add column pain int;
update demo_days set pain = greatest(0, least(10, round(
  base_level - (case arm_code when 'placebo' then 0.25 when 'hv101_50' then 0.7 when 'hv101_100' then 1.1 else 0 end) * day / 7.0
  + (r1 - 0.5) * 3)))
where trial_code = 'NORTHSTAR-2';

select id as src_synthetic from clinical.data_sources where code = 'synthetic' \gset
select id as src_ehr from clinical.data_sources where code = 'ehr' \gset
select id as src_wearable from clinical.data_sources where code = 'wearable' \gset
select id as src_manual from clinical.data_sources where code = 'manual' \gset

insert into clinical.import_batches (source_id, trial_id, label, row_count, created_by, metadata)
values (:'src_synthetic'::uuid, :'ns'::uuid, 'Demo seed: NORTHSTAR-2 daily diary', null, 'db/seeds/demo.sql', '{"seed": 0.2026}'),
       (:'src_synthetic'::uuid, :'br'::uuid, 'Demo seed: BREATHE-1 daily diary', null, 'db/seeds/demo.sql', '{"seed": 0.2026}');
select id as batch_ns from clinical.import_batches where trial_id = :'ns'::uuid \gset
select id as batch_br from clinical.import_batches where trial_id = :'br'::uuid \gset

insert into clinical.observations (trial_id, participant_id, measure_id, value_number, value_boolean, unit, observed_at, source_id, import_batch_id)
select dd.trial_id, dd.participant_id, m.id, v.num, v.bool, m.unit, dd.day_start + v.at_time, :'src_synthetic'::uuid, :'batch_ns'::uuid
from demo_days dd
join trial.measures m on m.trial_id = dd.trial_id
cross join lateral (values
  ('pain_score', dd.pain::numeric, null::boolean, interval '20 hours 10 minutes'),
  ('headache_today', null, dd.pain >= 2 or dd.r2 < 0.05, interval '20 hours 11 minutes'),
  ('nausea', null, dd.r3 < case dd.arm_code when 'hv101_100' then 0.18 when 'hv101_50' then 0.1 else 0.05 end, interval '20 hours 12 minutes'),
  ('dose_taken', null, dd.r4 < dd.adherence, interval '9 hours 5 minutes'),
  ('sleep_hours', round((6.4 + dd.r2 * 2.2 - dd.pain * 0.08)::numeric, 1), null, interval '9 hours 6 minutes')
) as v (code, num, bool, at_time)
where dd.trial_code = 'NORTHSTAR-2' and m.code = v.code;

-- Weekly weight comes from the clinic's EHR rather than the diary.
insert into clinical.observations (trial_id, participant_id, measure_id, value_number, unit, observed_at, source_id)
select dd.trial_id, dd.participant_id, m.id,
  round((62 + (abs(hashtext(dd.subject_code)) % 30) + (dd.r1 - 0.5) * 1.2)::numeric, 1), 'kg', dd.day_start + interval '10 hours', :'src_ehr'::uuid
from demo_days dd
join trial.measures m on m.trial_id = dd.trial_id and m.code = 'weight_kg'
where dd.trial_code = 'NORTHSTAR-2' and dd.day % 7 = 0;

-- BREATHE-1: peak flow from the home meter (wearable); AZ-7 improves it faster.
insert into clinical.observations (trial_id, participant_id, measure_id, value_number, value_boolean, unit, observed_at, source_id, import_batch_id)
select dd.trial_id, dd.participant_id, m.id, v.num, v.bool, m.unit, dd.day_start + v.at_time, v.source, v.batch
from demo_days dd
join trial.measures m on m.trial_id = dd.trial_id
cross join lateral (values
  ('peak_flow', round(300 + dd.base_level * 20 + dd.day * case dd.arm_code when 'az7' then 4.2 else 1.1 end + (dd.r1 - 0.5) * 50)::numeric,
   null::boolean, interval '7 hours 40 minutes', :'src_wearable'::uuid, null::uuid),
  ('rescue_puffs', greatest(0, round(4 - dd.day * case dd.arm_code when 'az7' then 0.14 else 0.05 end + (dd.r2 - 0.5) * 4))::numeric,
   null, interval '20 hours 5 minutes', :'src_synthetic'::uuid, :'batch_br'::uuid),
  ('night_symptoms', null, dd.r3 < case dd.arm_code when 'az7' then 0.32 - dd.day * 0.01 else 0.35 end,
   interval '8 hours 2 minutes', :'src_synthetic'::uuid, :'batch_br'::uuid),
  ('dose_taken', null, dd.r4 < dd.adherence, interval '21 hours 3 minutes', :'src_synthetic'::uuid, :'batch_br'::uuid)
) as v (code, num, bool, at_time, source, batch)
where dd.trial_code = 'BREATHE-1' and m.code = v.code;

update clinical.import_batches b set row_count = (select count(*) from clinical.observations o where o.import_batch_id = b.id)
where b.id in (:'batch_ns'::uuid, :'batch_br'::uuid);

-- Check-in history for the last 14 days: answered on days with data, missed otherwise.
insert into patient_agent.check_ins (participant_id, collection_plan_id, scheduled_for, status, answered_at)
select p.id, cp.id, s.slot,
  case when dd.participant_id is not null then 'answered' else 'missed' end,
  case when dd.participant_id is not null then s.slot + interval '9 minutes' end
from trial.participants p
join trial.trials t on t.id = p.trial_id
join trial.collection_plans cp on cp.trial_id = p.trial_id and cp.frequency = 'daily'
join trial.measures m on m.id = cp.measure_id and m.code in ('pain_score', 'peak_flow')
cross join lateral (
  select (date_trunc('day', now() at time zone t.timezone) - make_interval(days => g) + cp.local_time) at time zone t.timezone as slot
  from generate_series(4, 14) g
) s
left join demo_days dd on dd.participant_id = p.id
  and dd.day_start = date_trunc('day', s.slot at time zone t.timezone) at time zone t.timezone
where p.status = 'active' and s.slot > p.enrolled_at;

-- Adverse events --------------------------------------------------------------------
-- Grade 3+ or serious events raise manager alerts through the trigger on clinical.adverse_events.
insert into clinical.adverse_events (trial_id, participant_id, term, description, grade, is_serious, onset_at, resolved_at,
                                     relatedness, action_taken, outcome, status, source_id)
select p.trial_id, p.id, e.term, e.description, e.grade, e.serious,
  now() - make_interval(days => e.onset_days_ago),
  case when e.resolved_days_ago is not null then now() - make_interval(days => e.resolved_days_ago) end,
  e.relatedness, e.action, e.outcome, e.status, :'src_manual'::uuid
from (values
  ('NS2-003', 'Nausea', 'Mild nausea after morning dose', 1, false, 20, 17, 'possible', 'none', 'recovered', 'closed'),
  ('NS2-006', 'Nausea', 'Nausea most mornings in week 2', 2, false, 15, 9, 'probable', 'none', 'recovered', 'confirmed'),
  ('NS2-009', 'Fatigue', 'Tired in the afternoons', 1, false, 12, null, 'unlikely', 'none', 'ongoing', 'under_review'),
  ('NS2-012', 'Nausea', 'Severe nausea with vomiting, missed two doses', 3, false, 6, null, 'probable', 'dose_interrupted', 'ongoing', 'under_review'),
  ('NS2-015', 'Rash', 'Small itchy rash on forearm', 1, false, 10, 4, 'possible', 'none', 'recovered', 'closed'),
  ('NS2-018', 'Dizziness', 'Light-headed when standing up quickly', 2, false, 8, null, 'possible', 'none', 'ongoing', 'reported'),
  ('NS2-021', 'Insomnia', 'Trouble falling asleep', 1, false, 5, null, 'unlikely', 'none', 'ongoing', 'reported'),
  ('BR1-002', 'Oral thrush', 'White patches in mouth', 2, false, 9, 2, 'probable', 'none', 'recovered', 'confirmed'),
  ('BR1-004', 'Asthma exacerbation', 'Emergency room visit for wheezing; treated with nebulizer and released', 3, true, 4, 2, 'unlikely', 'none', 'recovered', 'confirmed'),
  ('BR1-007', 'Hoarseness', 'Hoarse voice after inhaler use', 1, false, 7, null, 'possible', 'none', 'ongoing', 'reported')
) as e (subject_code, term, description, grade, serious, onset_days_ago, resolved_days_ago, relatedness, action, outcome, status)
join trial.participants p on p.subject_code = e.subject_code;

-- Patient agent conversations for NS2-001..003: three evening check-ins each, with the values
-- the agent extracted stored as observations linked to the patient's message.
do $$
declare
  r record;
  d int;
  thread uuid;
  q_msg uuid; a_msg uuid; q2_msg uuid; a2_msg uuid; check_in uuid;
  pain int; nausea boolean; t0 timestamptz; first_name text;
  src uuid := (select id from clinical.data_sources where code = 'patient_agent');
  i int := 0;
  memories text[][] := array[
    ['preference', 'Prefers short texts and evening check-ins after 8pm.'],
    ['routine', 'Takes the study dose with coffee around 7:30am.'],
    ['concern', 'Wonders whether long screen days at work trigger afternoon headaches.'],
    ['preference', 'Likes a quick thank-you; does not want daily motivational messages.'],
    ['routine', 'Runs on weekend mornings; headaches are rarer on those days.'],
    ['goal', 'Hopes to cut down on rescue painkillers before a family wedding in December.'],
    ['fact', 'Works night shifts twice a week, so morning check-ins can arrive late.'],
    ['instruction', 'Asked not to be texted before 9am on weekends.'],
    ['concern', 'Felt dizzy when standing up quickly last week; mentioned it once.']
  ];
begin
  for r in
    select p.id, p.trial_id, pe.display_name, pe.phone_e164
    from trial.participants p join core.people pe on pe.id = p.person_id
    where p.subject_code in ('NS2-001', 'NS2-002', 'NS2-003') order by p.subject_code
  loop
    i := i + 1;
    first_name := split_part(r.display_name, ' ', 1);
    insert into patient_agent.threads (participant_id, channel, handle, agent_handle, status)
    values (r.id, 'imessage', r.phone_e164, '+16175550199', 'active') returning id into thread;

    for d in reverse 3..1 loop
      t0 := (date_trunc('day', now() at time zone 'America/New_York') - make_interval(days => d) + interval '20 hours') at time zone 'America/New_York';
      pain := 1 + floor(random() * 6)::int;
      nausea := random() < 0.35;

      insert into patient_agent.messages (thread_id, participant_id, direction, author, body, sent_at, model)
      values (thread, r.id, 'outbound', 'agent',
              format('Hi %s, evening check-in: on a scale of 0 to 10, how bad was your worst headache today?', first_name),
              t0, 'claude-haiku-5-5') returning id into q_msg;
      insert into patient_agent.check_ins (participant_id, collection_plan_id, scheduled_for, status, prompt_message_id)
      select r.id, cp.id, t0, 'sent', q_msg from trial.collection_plans cp
      join trial.measures m on m.id = cp.measure_id where cp.trial_id = r.trial_id and m.code = 'pain_score'
      returning id into check_in;
      insert into patient_agent.messages (thread_id, participant_id, direction, author, body, sent_at)
      values (thread, r.id, 'inbound', 'patient',
              case when pain <= 1 then 'barely anything today, maybe a 1'
                   when pain >= 5 then format('ugh, a %s. hit hard after lunch', pain)
                   else format('maybe a %s', pain) end,
              t0 + interval '6 minutes') returning id into a_msg;
      update patient_agent.check_ins set status = 'answered', response_message_id = a_msg, answered_at = t0 + interval '6 minutes'
      where id = check_in;
      insert into clinical.observations (trial_id, participant_id, measure_id, value_number, observed_at, source_id, message_id, check_in_id, confidence)
      select r.trial_id, r.id, m.id, pain, t0 + interval '6 minutes', src, a_msg, check_in, 0.95
      from trial.measures m where m.trial_id = r.trial_id and m.code = 'pain_score';

      insert into patient_agent.messages (thread_id, participant_id, direction, author, body, sent_at, model)
      values (thread, r.id, 'outbound', 'agent', format('Thanks %s, logged a %s. Any nausea today?', first_name, pain),
              t0 + interval '7 minutes', 'claude-haiku-5-5') returning id into q2_msg;
      insert into patient_agent.messages (thread_id, participant_id, direction, author, body, sent_at)
      values (thread, r.id, 'inbound', 'patient', case when nausea then 'a little queasy after breakfast' else 'nope' end,
              t0 + interval '9 minutes') returning id into a2_msg;
      insert into clinical.observations (trial_id, participant_id, measure_id, value_boolean, observed_at, source_id, message_id, confidence)
      select r.trial_id, r.id, m.id, nausea, t0 + interval '9 minutes', src, a2_msg, case when nausea then 0.85 else 0.97 end
      from trial.measures m where m.trial_id = r.trial_id and m.code = 'nausea';
      insert into patient_agent.messages (thread_id, participant_id, direction, author, body, sent_at, model)
      values (thread, r.id, 'outbound', 'agent',
              case when nausea then 'Got it, I''ve noted some nausea. If it gets worse or you can''t keep your dose down, tell me and the study team will follow up. Rest well!'
                   else 'Great, all logged. Thanks for checking in, rest well!' end,
              t0 + interval '10 minutes', 'claude-haiku-5-5');
    end loop;

    update patient_agent.threads set last_message_at = t0 + interval '10 minutes' where id = thread;

    insert into patient_agent.memories (participant_id, kind, content, importance)
    select r.id, memories[k][1], memories[k][2], 3
    from generate_series((i - 1) * 3 + 1, i * 3) k;
    insert into patient_agent.memories (participant_id, kind, content, importance, covers_from, covers_to)
    values (r.id, 'summary',
            format('%s answered every evening check-in this week. Headaches were mild to moderate; nausea came up on some days and the agent reminded them to report anything worse.', first_name),
            4, now() - interval '3 days', now());
  end loop;
end $$;

-- Manager agent: a thread for Dr. Avery Chen with one question, its analysis and memories.
do $$
declare
  manager uuid := (select id from core.people where phone_e164 = '+16175550100');
  ns uuid := (select id from trial.trials where code = 'NORTHSTAR-2');
  thread uuid; q uuid; a uuid;
  result jsonb;
  t0 timestamptz := now() - interval '2 hours';
begin
  insert into manager_agent.threads (person_id, channel, handle, agent_handle, default_trial_id, last_message_at)
  values (manager, 'imessage', '+16175550100', '+16175550198', ns, t0 + interval '1 minute') returning id into thread;

  select jsonb_agg(row_to_json(x) order by x.arm_code) into result from (
    select arm_code, round(avg(share_true) * 100) as adherence_pct
    from analytics.measure_daily
    where trial_code = 'NORTHSTAR-2' and measure_code = 'dose_taken' and local_date > current_date - 7
    group by arm_code
  ) x;

  insert into manager_agent.messages (thread_id, person_id, direction, author, body, sent_at)
  values (thread, manager, 'inbound', 'manager', 'How is dose adherence looking by arm this week?', t0) returning id into q;
  insert into manager_agent.messages (thread_id, person_id, direction, author, body, sent_at, model)
  values (thread, manager, 'outbound', 'agent',
          'Dose adherence, last 7 days: ' || (select string_agg(r->>'arm_code' || ' ' || (r->>'adherence_pct') || '%', ', ') from jsonb_array_elements(result) r)
          || '. NS2-006 and NS2-012 are the lowest. Want their check-in history?',
          t0 + interval '1 minute', 'claude-haiku-5-5') returning id into a;

  insert into manager_agent.analyses (person_id, trial_id, thread_id, request_message_id, response_message_id, question,
                                      sql_text, result, narrative, status, model, completed_at)
  values (manager, ns, thread, q, a, 'How is dose adherence looking by arm this week?',
          'select arm_code, round(avg(share_true) * 100) as adherence_pct from analytics.measure_daily where trial_code = ''NORTHSTAR-2'' and measure_code = ''dose_taken'' and local_date > current_date - 7 group by arm_code',
          result, (select body from manager_agent.messages where id = a), 'succeeded', 'claude-haiku-5-5', t0 + interval '1 minute');

  insert into manager_agent.memories (person_id, trial_id, kind, content, importance) values
    (manager, null, 'preference', 'Wants a Monday 8am summary: enrollment vs target, adherence by arm, new grade 2+ adverse events.', 5),
    (manager, ns, 'focus', 'Watching nausea in the 100 mg arm after NS2-012''s grade 3 event.', 4),
    (manager, null, 'instruction', 'Always use subject codes, never patient names.', 5),
    (manager, ns, 'saved_question', 'How is dose adherence looking by arm this week?', 3);
end $$;

commit;

-- What was created
select 'people' as item, count(*) from core.people where is_synthetic
union all select 'participants', count(*) from trial.participants where is_synthetic
union all select 'observations', count(*) from clinical.observations o join trial.trials t on t.id = o.trial_id where t.is_synthetic
union all select 'adverse events', count(*) from clinical.adverse_events e join trial.trials t on t.id = e.trial_id where t.is_synthetic
union all select 'manager alerts', count(*) from manager_agent.alerts a join trial.trials t on t.id = a.trial_id where t.is_synthetic
union all select 'check-ins', count(*) from patient_agent.check_ins c join trial.participants p on p.id = c.participant_id where p.is_synthetic
union all select 'patient messages', count(*) from patient_agent.messages m join trial.participants p on p.id = m.participant_id where p.is_synthetic;
