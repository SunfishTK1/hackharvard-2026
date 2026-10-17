-- migrate:up
-- The trial manager's view: pseudonymous, cross-patient, cross-source views. The manager agent
-- reads only these. Every view filters with analytics.visible_trial(), which limits the
-- manager_agent role to its staff member's trials and is a no-op for everyone else.
set local role app_owner;

create function analytics.visible_trial(p_trial_id uuid) returns boolean
language sql stable as $$
  select current_user <> 'manager_agent' or p_trial_id = any (manager_agent.my_trial_ids())
$$;
comment on function analytics.visible_trial(uuid) is 'True if the current role may see this trial. Limits manager_agent to its staff member''s trials.';

create view analytics.trials as
select
  t.id as trial_id, t.code as trial_code, t.title, t.phase, t.status, t.therapeutic_area, t.intervention,
  t.primary_endpoint, t.target_enrollment, t.start_date, t.end_date,
  count(p.id) filter (where p.status in ('enrolled', 'active', 'completed')) as enrolled,
  count(p.id) filter (where p.status = 'active') as active,
  count(p.id) filter (where p.status = 'withdrawn') as withdrawn,
  count(p.id) filter (where p.status = 'screening') as screening,
  (select count(*) from clinical.adverse_events e where e.trial_id = t.id and e.status not in ('closed', 'not_an_ae')) as open_adverse_events,
  (select count(*) from clinical.adverse_events e where e.trial_id = t.id and e.is_serious) as serious_adverse_events,
  (select count(*) from manager_agent.alerts a where a.trial_id = t.id and a.status in ('open', 'sent')) as open_alerts,
  (select count(*) from clinical.observations o where o.trial_id = t.id and o.observed_at > now() - interval '7 days') as observations_7d,
  t.is_synthetic
from trial.trials t
left join trial.participants p on p.trial_id = t.id
where analytics.visible_trial(t.id)
group by t.id;
comment on view analytics.trials is 'One row per trial: status, enrollment against target, open safety items, recent data volume.';

create view analytics.enrollment as
select
  t.id as trial_id, t.code as trial_code, a.code as arm_code, a.name as arm_name, a.is_control,
  a.target_enrollment,
  count(p.id) filter (where p.status in ('enrolled', 'active', 'completed')) as enrolled,
  count(p.id) filter (where p.status = 'active') as active,
  count(p.id) filter (where p.status = 'completed') as completed,
  count(p.id) filter (where p.status = 'withdrawn') as withdrawn
from trial.arms a
join trial.trials t on t.id = a.trial_id
left join trial.participants p on p.arm_id = a.id
where analytics.visible_trial(t.id)
group by t.id, a.id;
comment on view analytics.enrollment is 'Enrollment by arm against target.';

create view analytics.participants as
select
  p.id as participant_id, p.trial_id, t.code as trial_code, p.subject_code,
  a.code as arm_code, a.name as arm_name, s.code as site_code,
  p.status, p.sex, p.birth_year, p.enrolled_at, p.completed_at, p.withdrawn_at, p.withdrawal_reason,
  (now() at time zone t.timezone)::date - (p.enrolled_at at time zone t.timezone)::date as study_day,
  th.last_message_at,
  coalesce(msg.from_patient_7d, 0) as messages_from_patient_7d,
  coalesce(ci.prompted_14d, 0) as check_ins_14d,
  coalesce(ci.answered_14d, 0) as check_ins_answered_14d,
  round(ci.answered_14d::numeric / nullif(ci.prompted_14d, 0), 2) as check_in_response_rate_14d,
  coalesce(obs.count_7d, 0) as observations_7d,
  obs.last_observed_at,
  coalesce(ae.open_count, 0) as open_adverse_events,
  ae.max_grade as max_adverse_event_grade,
  p.is_synthetic
from trial.participants p
join trial.trials t on t.id = p.trial_id
left join trial.arms a on a.id = p.arm_id
left join trial.sites s on s.id = p.site_id
left join patient_agent.threads th on th.participant_id = p.id and th.channel = 'imessage'
left join lateral (
  select count(*) filter (where m.direction = 'inbound' and m.sent_at > now() - interval '7 days') as from_patient_7d
  from patient_agent.messages m where m.participant_id = p.id
) msg on true
left join lateral (
  select count(*) filter (where c.status in ('sent', 'answered', 'missed')) as prompted_14d,
         count(*) filter (where c.status = 'answered') as answered_14d
  from patient_agent.check_ins c
  where c.participant_id = p.id and c.scheduled_for > now() - interval '14 days'
) ci on true
left join lateral (
  select count(*) filter (where o.observed_at > now() - interval '7 days') as count_7d, max(o.observed_at) as last_observed_at
  from clinical.observations o where o.participant_id = p.id and o.status <> 'entered_in_error'
) obs on true
left join lateral (
  select count(*) filter (where e.status not in ('closed', 'not_an_ae')) as open_count, max(e.grade) as max_grade
  from clinical.adverse_events e where e.participant_id = p.id
) ae on true
where analytics.visible_trial(p.trial_id);
comment on view analytics.participants is 'Pseudonymous roster with engagement and safety signals per participant: check-in response rate, recent data, open AEs.';

create view analytics.observations as
select
  o.id as observation_id, o.trial_id, t.code as trial_code, o.participant_id, p.subject_code, a.code as arm_code,
  m.code as measure_code, m.label as measure_label, m.category, m.value_type,
  o.value_number, o.value_boolean, o.value_text, o.value_json,
  coalesce(o.value_number::text, o.value_boolean::text, o.value_text, o.value_json::text) as value_display,
  coalesce(o.unit, m.unit) as unit,
  o.observed_at, (o.observed_at at time zone t.timezone)::date as local_date,
  ds.code as source_code, ds.kind as source_kind, o.confidence, o.status,
  o.message_id is not null as from_conversation
from clinical.observations o
join trial.trials t on t.id = o.trial_id
join trial.participants p on p.id = o.participant_id
left join trial.arms a on a.id = p.arm_id
join trial.measures m on m.id = o.measure_id
join clinical.data_sources ds on ds.id = o.source_id
where o.status <> 'entered_in_error' and analytics.visible_trial(o.trial_id);
comment on view analytics.observations is 'Every valid observation in long format with measure, arm and source labels. The base for ad hoc analysis.';

create view analytics.latest_observations as
select distinct on (participant_id, measure_code) *
from analytics.observations
order by participant_id, measure_code, observed_at desc;
comment on view analytics.latest_observations is 'Most recent value of each measure for each participant.';

create view analytics.measure_daily as
select
  trial_id, trial_code, arm_code, measure_code, measure_label, value_type, unit, local_date,
  count(distinct participant_id) as participants,
  count(*) as observations,
  round(avg(value_number), 2) as mean_value,
  min(value_number) as min_value,
  max(value_number) as max_value,
  round(avg(value_boolean::int), 3) as share_true
from analytics.observations
group by trial_id, trial_code, arm_code, measure_code, measure_label, value_type, unit, local_date;
comment on view analytics.measure_daily is 'Daily aggregates per trial, arm and measure: means for numbers, share true for yes/no measures.';

create view analytics.adverse_events as
select
  e.id as adverse_event_id, e.trial_id, t.code as trial_code, e.participant_id, p.subject_code, a.code as arm_code,
  e.term, e.description, e.grade, e.is_serious, e.relatedness, e.action_taken, e.outcome, e.status,
  e.onset_at, e.resolved_at,
  round(extract(epoch from e.resolved_at - e.onset_at) / 86400.0, 1) as days_to_resolution,
  ds.code as reported_via,
  e.message_id is not null as from_conversation
from clinical.adverse_events e
join trial.trials t on t.id = e.trial_id
join trial.participants p on p.id = e.participant_id
left join trial.arms a on a.id = p.arm_id
join clinical.data_sources ds on ds.id = e.source_id
where analytics.visible_trial(e.trial_id);
comment on view analytics.adverse_events is 'Adverse events with subject code, arm, and how they were reported.';

create view analytics.adverse_event_summary as
select
  trial_id, trial_code, arm_code, term,
  count(*) as events,
  count(distinct participant_id) as participants,
  max(grade) as max_grade,
  count(*) filter (where is_serious) as serious,
  count(*) filter (where status not in ('closed', 'not_an_ae')) as open
from analytics.adverse_events
where status <> 'not_an_ae'
group by trial_id, trial_code, arm_code, term;
comment on view analytics.adverse_event_summary is 'Adverse event counts by trial, arm and term: the safety table.';

create view analytics.check_in_adherence as
select
  p.trial_id, t.code as trial_code, p.id as participant_id, p.subject_code, a.code as arm_code,
  date_trunc('week', c.scheduled_for at time zone t.timezone)::date as week_start,
  count(*) filter (where c.status in ('sent', 'answered', 'missed')) as prompted,
  count(*) filter (where c.status = 'answered') as answered,
  count(*) filter (where c.status = 'missed') as missed,
  round(count(*) filter (where c.status = 'answered')::numeric
        / nullif(count(*) filter (where c.status in ('sent', 'answered', 'missed')), 0), 2) as response_rate
from patient_agent.check_ins c
join trial.participants p on p.id = c.participant_id
join trial.trials t on t.id = p.trial_id
left join trial.arms a on a.id = p.arm_id
where analytics.visible_trial(p.trial_id)
group by p.trial_id, t.id, p.id, a.code, week_start;
comment on view analytics.check_in_adherence is 'Weekly check-in response rate per participant: how reliably each patient answers the agent.';

create view analytics.source_coverage as
select
  trial_id, trial_code, source_code, source_kind,
  count(*) as observations,
  count(distinct participant_id) as participants,
  count(distinct measure_code) as measures,
  min(observed_at) as first_observed_at,
  max(observed_at) as last_observed_at
from analytics.observations
group by trial_id, trial_code, source_code, source_kind;
comment on view analytics.source_coverage is 'How much data each source contributes per trial: agent-collected vs synthetic vs EHR, wearables and labs.';

-- migrate:down
set local role app_owner;
drop view analytics.source_coverage, analytics.check_in_adherence, analytics.adverse_event_summary,
  analytics.adverse_events, analytics.measure_daily, analytics.latest_observations, analytics.observations,
  analytics.participants, analytics.enrollment, analytics.trials;
drop function analytics.visible_trial(uuid);
