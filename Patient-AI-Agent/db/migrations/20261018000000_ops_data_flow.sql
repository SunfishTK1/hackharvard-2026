-- migrate:up
-- What Sage writes follows the platform's own conventions (the synthetic seed shows them), so the
-- ops home, the trial manager view and the analytics views read Sage's participants like any other:
--   * a reading is checked against the study's enabled alert rules; a match flags it for review and
--     raises that rule's alert (alert_type = rule type, linked rule, the seed's wording);
--   * every alert is assigned: the site coordinator, or for a safety review the site investigator,
--     who also gets a review_safety task waiting for their approval;
--   * a second reading in the same window corrects the first (supersedes_observation_id);
--   * consent steps are logged as participant events (invitation sent, opened, signed, declined).
-- Existing open alerts, readings and consents from Sage are brought in line once, below.
set local role app_owner;

-- The study_staff assignment that handles an alert: this role at the participant's site, else
-- study-wide. Only active staff who receive alerts (the platform's assignment trigger checks the same).
create function assistant.staff_assignment(p_study uuid, p_site uuid, p_role text) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select s.id from public.study_staff s join private.staff_users u on u.id = s.staff_user_id
  where s.study_id = p_study and s.role = p_role and s.is_active and u.is_active and s.receives_alerts
    and (s.site_id = p_site or s.site_id is null)
  order by s.site_id is null, s.created_at
  limit 1
$$;

-- Raises an assigned alert; a safety review also gets the investigator's review_safety task.
-- Returns null when the same alert is already open.
create function assistant.raise_alert(p_study uuid, p_participant uuid, p_rule uuid, p_type text, p_severity text,
                                      p_reason text, p_action text, p_dedupe text, p_observation uuid default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  site uuid;
  safety boolean := p_type = 'safety_review';
  assignee uuid;
  new_id uuid;
begin
  select p.site_id into site from public.participants p where p.id = p_participant and p.study_id = p_study;
  assignee := coalesce(assistant.staff_assignment(p_study, site, case when safety then 'principal_investigator' else 'coordinator' end),
                       assistant.staff_assignment(p_study, site, 'coordinator'),
                       assistant.staff_assignment(p_study, site, 'trial_manager'));
  begin
    insert into public.alerts (study_id, participant_id, rule_id, assigned_site_id, assigned_staff_id, alert_type, severity,
                               reason, recommended_action, deduplication_key)
    values (p_study, p_participant, p_rule, site, assignee, p_type, p_severity, left(p_reason, 2000), left(p_action, 1000), p_dedupe)
    returning id into new_id;
  exception when unique_violation then
    return null;
  end;
  if safety then
    insert into public.workflow_tasks (study_id, participant_id, rule_id, assigned_staff_id, action_type, payload,
                                       deduplication_key, status, requires_approval)
    values (p_study, p_participant, p_rule, assignee, 'review_safety',
            jsonb_build_object('alert_id', new_id, 'observation_id', p_observation, 'source', 'patient_assistant'),
            'review_safety:' || new_id, 'waiting_review', true);
  end if;
  return new_id;
end $$;

-- Whether a reading meets a rule's condition, judged as the platform's seed judges them. Free text
-- that plainly says there is nothing ("No symptoms today.", "None so far", "I feel fine") counts as
-- one of the rule's "nothing" answers, so a check-in doesn't raise a safety review for it.
create function assistant.rule_matches(c jsonb, num numeric, bool boolean, txt text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  with t(said) as (select regexp_replace(regexp_replace(lower(btrim(txt)), '[[:punct:][:space:]]+$', ''), '\s+', ' ', 'g'))
  select coalesce(case c->>'op'
    when '>=' then num >= (c->>'value')::numeric
    when '>' then num > (c->>'value')::numeric
    when '<=' then num <= (c->>'value')::numeric
    when '<' then num < (c->>'value')::numeric
    when 'is_true' then bool
    when 'text_not_in' then (select said <> ''
      and said not in (select lower(v) from jsonb_array_elements_text(c->'values') v)
      and said !~ '^(no|none|nope|nothing|nil|n/?a)( new)?( symptoms?| issues?| problems?| side effects?| complaints?)?( (today|at all|to report|so far|reported|right now))*$'
      and said !~ '^(i feel |i''m |im |feeling )?(fine|good|great|well|ok|okay|all good)( today| now)?$'
      from t)
  end, false)
$$;

-- The seed's alert wording for a rule match.
create function assistant.rule_alert_reason(m public.measure_definitions, p_code text, num numeric, bool boolean, txt text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select format('%s reported for %s: %s%s.', m.label, p_code,
    coalesce(trim_scale(num)::text, txt, case when bool then 'Yes' else 'No' end), coalesce(' ' || m.unit, ''))
$$;

create function assistant.rule_alert_action(p_rule_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_rule_type when 'safety_review'
    then 'Investigator review of the participant report, following the site safety plan.'
    else 'Coordinator follow-up with the participant; escalate to the investigator if confirmed.' end
$$;

-- Raises the alerts a stored reading's rules call for. Returns how many were raised.
create function assistant.apply_alert_rules(p_observation uuid) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  o public.observations;
  m public.measure_definitions;
  r public.alert_rules;
  code text;
  raised integer := 0;
begin
  select * into o from public.observations where id = p_observation;
  select * into m from public.measure_definitions where id = o.measure_id;
  select participant_code into code from public.participants where id = o.participant_id;
  for r in select * from public.alert_rules a where a.study_id = o.study_id and a.measure_id = o.measure_id and a.enabled
             and a.rule_type in ('value_threshold', 'safety_review') order by a.rule_code loop
    if assistant.rule_matches(r.condition, o.numeric_value, o.boolean_value, o.text_value) then
      if assistant.raise_alert(o.study_id, o.participant_id, r.id, r.rule_type, r.severity,
           assistant.rule_alert_reason(m, code, o.numeric_value, o.boolean_value, o.text_value),
           assistant.rule_alert_action(r.rule_type), r.rule_code || ':' || o.id, o.id) is not null then
        raised := raised + 1;
      end if;
    end if;
  end loop;
  return raised;
end $$;

-- A study value the participant reported (check-in or chat). As before, plus: a second answer in
-- the same window corrects the first, and the study's alert rules are applied.
create or replace function assistant.record_observation(p_engagement uuid, p_measure_code text, p_value jsonb, p_source_type text,
                                                        p_raw text, p_platform_message uuid, p_confidence numeric) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  m public.measure_definitions;
  due uuid;
  due_status text;
  earlier uuid;
  num numeric;
  bool boolean;
  txt text;
  flagged boolean;
  new_id uuid;
begin
  select * into m from public.measure_definitions where study_id = e.study_id and measure_code = p_measure_code and is_active;
  if not found then raise exception 'Unknown measure %', p_measure_code using errcode = '23514'; end if;
  -- The open expected assessment this answers, or one already answered in this window.
  select a.id, a.status into due, due_status from public.scheduled_assessments a
  where a.participant_id = e.participant_id and a.measure_id = m.id and a.status in ('pending', 'completed')
    and now() between a.window_opens_at and a.window_closes_at
  order by a.status <> 'pending', a.due_at limit 1;
  if due_status = 'completed' then
    -- Answered already: this corrects the current answer if Sage recorded it, else stands alone.
    select x.id into earlier from public.observations x
    where x.scheduled_assessment_id = due and x.review_status <> 'rejected' and x.source_payload->>'via' = 'patient_assistant'
      and not exists (select 1 from public.observations n where n.supersedes_observation_id = x.id)
    order by x.captured_at desc limit 1;
    if earlier is null then due := null; end if;
  end if;
  num := case when m.data_type in ('numeric', 'integer') then (p_value #>> '{}')::numeric end;
  bool := case when m.data_type = 'boolean' then (p_value #>> '{}')::boolean end;
  txt := case when m.data_type in ('text', 'choice') then p_value #>> '{}' end;
  flagged := exists (select 1 from public.alert_rules r where r.study_id = e.study_id and r.measure_id = m.id and r.enabled
                       and r.rule_type in ('value_threshold', 'safety_review') and assistant.rule_matches(r.condition, num, bool, txt));
  insert into public.observations (study_id, participant_id, measure_id, scheduled_assessment_id, supersedes_observation_id, source_type,
                                   raw_value, source_payload, numeric_value, boolean_value, text_value, json_value, unit, raw_message_id,
                                   parser_confidence, captured_at, requires_review, metadata)
  values (e.study_id, e.participant_id, m.id, due, earlier, p_source_type, left(p_raw, 2000),
          jsonb_build_object('value', p_value, 'via', 'patient_assistant'), num, bool, txt,
          case when m.data_type = 'json' then p_value end,
          m.unit, p_platform_message, p_confidence, now(), flagged, jsonb_build_object('engagement_id', e.id))
  returning id into new_id;
  if flagged then perform assistant.apply_alert_rules(new_id); end if;
  return new_id;
end $$;
comment on function assistant.record_observation(uuid, text, jsonb, text, text, uuid, numeric) is 'Inserts a participant-reported observation: completes the open scheduled assessment, or corrects the answer Sage already recorded in that window, and applies the study''s alert rules (flag for review, assigned alert, investigator task for safety reviews).';

-- The rule alerts raised for this person's readings, so Sage can say the team knows (and not raise its own).
create function assistant.rule_alerts(p_engagement uuid, p_observations uuid[])
returns table (name text, severity text, safety_review boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select r.name, a.severity, a.alert_type = 'safety_review'
  from public.alerts a join public.alert_rules r on r.id = a.rule_id
  where a.participant_id = (assistant.my_engagement(p_engagement)).participant_id
    and a.deduplication_key = any (select r.rule_code || ':' || o from unnest(p_observations) o)
  order by a.created_at
$$;

-- Asks staff to act. With a participant: an assigned platform alert at their site (a safety review
-- goes to the investigator, with their review task). Before one: a notify_staff task.
create or replace function assistant.notify_staff(p_engagement uuid, p_severity text, p_reason text, p_action text,
                                                  p_alert_type text default 'patient_assistant', p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  dedupe text := 'assistant:' || e.id || ':' || coalesce(p_dedupe, md5(p_alert_type || p_reason));
  new_id uuid;
begin
  if e.participant_id is not null then
    return assistant.raise_alert(e.study_id, e.participant_id, null, p_alert_type, p_severity, p_reason, p_action, dedupe);
  end if;
  insert into public.workflow_tasks (study_id, action_type, payload, deduplication_key, requires_approval)
  values (e.study_id, 'notify_staff', jsonb_build_object('reason', left(p_reason, 2000), 'recommended_action', left(p_action, 1000),
          'severity', p_severity, 'alert_type', p_alert_type, 'source', 'patient_assistant', 'engagement_id', e.id, 'phase', e.phase),
          dedupe, false)
  on conflict (study_id, deduplication_key) do nothing returning id into new_id;
  return new_id;
end $$;

-- After the screening visit is booked, the site investigator confirms enrollment (as in the seed:
-- assigned to them, waiting for their review).
create or replace function assistant.request_enrollment(p_engagement uuid, p_visit_at timestamptz) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  site uuid;
  new_id uuid;
begin
  if e.participant_id is null then raise exception 'No participant yet' using errcode = '23514'; end if;
  select p.site_id into site from public.participants p where p.id = e.participant_id;
  insert into public.workflow_tasks (study_id, participant_id, assigned_staff_id, action_type, payload, deduplication_key, status, requires_approval, run_after)
  values (e.study_id, e.participant_id,
          coalesce(assistant.staff_assignment(e.study_id, site, 'principal_investigator'), assistant.staff_assignment(e.study_id, site, 'trial_manager')),
          'confirm_enrollment',
          jsonb_build_object('source', 'patient_assistant', 'screening_visit_at', p_visit_at, 'prescreen', e.eligibility,
            'consent_version', (select d.version from public.consent_documents d where d.id = public.current_consent_document(e.study_id, e.participant_id))),
          'confirm_enrollment:' || e.participant_id, 'waiting_review', true, now())
  on conflict (study_id, deduplication_key) do update set payload = excluded.payload
  returning id into new_id;
  return new_id;
end $$;

-- Consent steps, as participant events alongside the platform's own status events.
create function assistant.consent_event(p_study uuid, p_participant uuid, p_type text, p_document uuid, p_at timestamptz, p_extra jsonb default '{}')
returns void language sql security definer set search_path = pg_catalog, pg_temp as $$
  insert into public.participant_events (study_id, participant_id, event_type, metadata, occurred_at)
  select p_study, p_participant, p_type,
         jsonb_build_object('consent_version', d.version, 'via', 'patient_assistant') || p_extra, p_at
  from public.consent_documents d where d.id = p_document
$$;

create or replace function assistant.present_consent(p_engagement uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  doc uuid;
  consent uuid;
begin
  if e.participant_id is null then raise exception 'No participant yet' using errcode = '23514'; end if;
  doc := public.current_consent_document(e.study_id, e.participant_id);
  if doc is null then raise exception 'The study has no active consent document' using errcode = '23514'; end if;
  insert into public.participant_consents (study_id, participant_id, consent_document_id, status, presented_at)
  values (e.study_id, e.participant_id, doc, 'sent', now())
  on conflict (participant_id, consent_document_id) do nothing returning id into consent;
  if consent is not null then
    perform assistant.consent_event(e.study_id, e.participant_id, 'consent_invitation_sent', doc, now(), '{"channel": "imessage"}');
    return consent;
  end if;
  return (select c.id from public.participant_consents c where c.participant_id = e.participant_id and c.consent_document_id = doc);
end $$;

create or replace function assistant.consent_opened(p_engagement uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  doc uuid := public.current_consent_document(e.study_id, e.participant_id);
begin
  update public.participant_consents set status = 'opened', opened_at = now()
  where participant_id = e.participant_id and status = 'sent' and consent_document_id = doc;
  if found then perform assistant.consent_event(e.study_id, e.participant_id, 'consent_opened', doc, now()); end if;
end $$;

create or replace function assistant.sign_consent(p_engagement uuid, p_signed_by text, p_evidence jsonb) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  doc uuid := public.current_consent_document(e.study_id, e.participant_id);
  signed timestamptz := now();
begin
  update public.participant_consents
  set status = 'signed', opened_at = coalesce(opened_at, signed), signed_at = signed, signed_by = left(p_signed_by, 200),
      copy_provided_at = signed, audit_metadata = audit_metadata || p_evidence || jsonb_build_object('via', 'patient_assistant')
  where participant_id = e.participant_id and status in ('sent', 'opened') and consent_document_id = doc;
  if not found then raise exception 'No outstanding consent to sign' using errcode = '23514'; end if;
  perform assistant.consent_event(e.study_id, e.participant_id, 'consent_signed', doc, signed);
  update public.participants set status = 'consented' where id = e.participant_id and status = 'consent_pending';
  return signed;
end $$;

create or replace function assistant.leave_study(p_engagement uuid, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  c record;
begin
  if e.participant_id is null then return; end if;
  for c in update public.participant_consents set status = 'declined', declined_at = now(),
             audit_metadata = audit_metadata || jsonb_build_object('declined_via', 'patient_assistant', 'reason', left(p_reason, 300))
           where participant_id = e.participant_id and status in ('sent', 'opened')
           returning consent_document_id, declined_at loop
    perform assistant.consent_event(e.study_id, e.participant_id, 'consent_declined', c.consent_document_id, c.declined_at);
  end loop;
  update public.participants set status = 'withdrawn', withdrawn_at = now()
  where id = e.participant_id and status in ('consent_pending', 'consented', 'enrolled', 'active');
end $$;

-- Only the bridge functions are for Sage; the helpers run inside them.
revoke execute on function assistant.staff_assignment(uuid, uuid, text), assistant.raise_alert(uuid, uuid, uuid, text, text, text, text, text, uuid),
  assistant.rule_matches(jsonb, numeric, boolean, text), assistant.rule_alert_reason(public.measure_definitions, text, numeric, boolean, text),
  assistant.rule_alert_action(text), assistant.apply_alert_rules(uuid), assistant.consent_event(uuid, uuid, text, uuid, timestamptz, jsonb),
  assistant.rule_alerts(uuid, uuid[]) from public;
grant execute on function assistant.rule_alerts(uuid, uuid[]) to patient_assistant;

-- Bring what Sage already wrote in line --------------------------------------------------------

-- Open alerts Sage raised with no one assigned: symptom reports become investigator safety reviews.
update public.alerts set alert_type = 'safety_review' where deduplication_key like 'assistant:%' and alert_type = 'adverse_event' and status <> 'resolved';
update public.alerts a set assigned_staff_id = coalesce(
    assistant.staff_assignment(a.study_id, a.assigned_site_id, case when a.alert_type = 'safety_review' then 'principal_investigator' else 'coordinator' end),
    assistant.staff_assignment(a.study_id, a.assigned_site_id, 'coordinator'),
    assistant.staff_assignment(a.study_id, a.assigned_site_id, 'trial_manager'))
where a.deduplication_key like 'assistant:%' and a.assigned_staff_id is null and a.status <> 'resolved';
insert into public.workflow_tasks (study_id, participant_id, assigned_staff_id, action_type, payload, deduplication_key, status, requires_approval, created_at)
select a.study_id, a.participant_id, a.assigned_staff_id, 'review_safety', jsonb_build_object('alert_id', a.id, 'source', 'patient_assistant'),
       'review_safety:' || a.id, 'waiting_review', true, a.created_at
from public.alerts a
where a.deduplication_key like 'assistant:%' and a.alert_type = 'safety_review' and a.status <> 'resolved'
on conflict (study_id, deduplication_key) do nothing;

-- Enrollment confirmations Sage asked for: to the site investigator, waiting for their review.
update public.workflow_tasks t set
    assigned_staff_id = coalesce(t.assigned_staff_id,
      assistant.staff_assignment(t.study_id, (select site_id from public.participants where id = t.participant_id), 'principal_investigator'),
      assistant.staff_assignment(t.study_id, (select site_id from public.participants where id = t.participant_id), 'trial_manager')),
    status = 'waiting_review', updated_at = now()
where t.action_type = 'confirm_enrollment' and t.payload->>'source' = 'patient_assistant' and t.status = 'pending';

-- Sage's current readings, judged by the study's rules.
update public.observations o set requires_review = true
where o.source_payload->>'via' = 'patient_assistant' and not o.requires_review and o.review_status <> 'rejected'
  and not exists (select 1 from public.observations n where n.supersedes_observation_id = o.id)
  and exists (select 1 from public.alert_rules r where r.study_id = o.study_id and r.measure_id = o.measure_id and r.enabled
                and r.rule_type in ('value_threshold', 'safety_review') and assistant.rule_matches(r.condition, o.numeric_value, o.boolean_value, o.text_value));
select assistant.apply_alert_rules(o.id) from public.observations o
where o.source_payload->>'via' = 'patient_assistant' and o.requires_review and o.review_status <> 'rejected'
  and not exists (select 1 from public.observations n where n.supersedes_observation_id = o.id);

-- Consent events for consents Sage handled before this.
select assistant.consent_event(c.study_id, c.participant_id, v.type, c.consent_document_id, v.at, v.extra)
from public.participant_consents c
cross join lateral (values ('consent_invitation_sent', c.presented_at, '{"channel": "imessage"}'::jsonb),
                           ('consent_opened', c.opened_at, '{}'::jsonb),
                           ('consent_signed', c.signed_at, '{}'::jsonb),
                           ('consent_declined', c.declined_at, '{}'::jsonb)) v(type, at, extra)
where c.participant_id in (select participant_id from assistant.engagements where participant_id is not null)
  and v.at is not null
  and not exists (select 1 from public.participant_events x where x.participant_id = c.participant_id and x.event_type = v.type);

-- migrate:down
-- Restores the bridge functions of 20261017220000_patient_assistant.sql. Alerts, tasks, flags and
-- events written meanwhile stay (the platform keeps evidence).
set local role app_owner;

create or replace function assistant.present_consent(p_engagement uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  doc uuid;
  consent uuid;
begin
  if e.participant_id is null then raise exception 'No participant yet' using errcode = '23514'; end if;
  doc := public.current_consent_document(e.study_id, e.participant_id);
  if doc is null then raise exception 'The study has no active consent document' using errcode = '23514'; end if;
  insert into public.participant_consents (study_id, participant_id, consent_document_id, status, presented_at)
  values (e.study_id, e.participant_id, doc, 'sent', now())
  on conflict (participant_id, consent_document_id) do nothing returning id into consent;
  return coalesce(consent, (select c.id from public.participant_consents c where c.participant_id = e.participant_id and c.consent_document_id = doc));
end $$;

create or replace function assistant.consent_opened(p_engagement uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  update public.participant_consents set status = 'opened', opened_at = now()
  where participant_id = e.participant_id and status = 'sent'
    and consent_document_id = public.current_consent_document(e.study_id, e.participant_id);
end $$;

create or replace function assistant.sign_consent(p_engagement uuid, p_signed_by text, p_evidence jsonb) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  signed timestamptz := now();
begin
  update public.participant_consents
  set status = 'signed', opened_at = coalesce(opened_at, signed), signed_at = signed, signed_by = left(p_signed_by, 200),
      copy_provided_at = signed, audit_metadata = audit_metadata || p_evidence || jsonb_build_object('via', 'patient_assistant')
  where participant_id = e.participant_id and status in ('sent', 'opened')
    and consent_document_id = public.current_consent_document(e.study_id, e.participant_id);
  if not found then raise exception 'No outstanding consent to sign' using errcode = '23514'; end if;
  update public.participants set status = 'consented' where id = e.participant_id and status = 'consent_pending';
  return signed;
end $$;

create or replace function assistant.leave_study(p_engagement uuid, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare e assistant.engagements := assistant.my_engagement(p_engagement);
begin
  if e.participant_id is null then return; end if;
  update public.participant_consents set status = 'declined', declined_at = now(),
         audit_metadata = audit_metadata || jsonb_build_object('declined_via', 'patient_assistant', 'reason', left(p_reason, 300))
  where participant_id = e.participant_id and status in ('sent', 'opened');
  update public.participants set status = 'withdrawn', withdrawn_at = now()
  where id = e.participant_id and status in ('consent_pending', 'consented', 'enrolled', 'active');
end $$;

create or replace function assistant.record_observation(p_engagement uuid, p_measure_code text, p_value jsonb, p_source_type text,
                                                        p_raw text, p_platform_message uuid, p_confidence numeric) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  m public.measure_definitions;
  due uuid;
  new_id uuid;
begin
  select * into m from public.measure_definitions where study_id = e.study_id and measure_code = p_measure_code and is_active;
  if not found then raise exception 'Unknown measure %', p_measure_code using errcode = '23514'; end if;
  select a.id into due from public.scheduled_assessments a
  where a.participant_id = e.participant_id and a.measure_id = m.id and a.status = 'pending'
    and now() between a.window_opens_at and a.window_closes_at
  order by a.due_at limit 1;
  insert into public.observations (study_id, participant_id, measure_id, scheduled_assessment_id, source_type, raw_value, source_payload,
                                   numeric_value, boolean_value, text_value, json_value, unit, raw_message_id, parser_confidence, captured_at, metadata)
  values (e.study_id, e.participant_id, m.id, due, p_source_type, left(p_raw, 2000), jsonb_build_object('value', p_value, 'via', 'patient_assistant'),
          case when m.data_type in ('numeric', 'integer') then (p_value #>> '{}')::numeric end,
          case when m.data_type = 'boolean' then (p_value #>> '{}')::boolean end,
          case when m.data_type in ('text', 'choice') then p_value #>> '{}' end,
          case when m.data_type = 'json' then p_value end,
          m.unit, p_platform_message, p_confidence, now(), jsonb_build_object('engagement_id', e.id))
  returning id into new_id;
  return new_id;
end $$;
comment on function assistant.record_observation(uuid, text, jsonb, text, text, uuid, numeric) is 'Inserts a participant-reported observation, completing the matching open scheduled assessment if there is one.';

create or replace function assistant.notify_staff(p_engagement uuid, p_severity text, p_reason text, p_action text,
                                                  p_alert_type text default 'patient_assistant', p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  site uuid;
  dedupe text := 'assistant:' || e.id || ':' || coalesce(p_dedupe, md5(p_alert_type || p_reason));
  new_id uuid;
begin
  if e.participant_id is not null then
    select p.site_id into site from public.participants p where p.id = e.participant_id;
    begin
      insert into public.alerts (study_id, participant_id, assigned_site_id, alert_type, severity, reason, recommended_action, deduplication_key)
      values (e.study_id, e.participant_id, site, p_alert_type, p_severity, left(p_reason, 2000), left(p_action, 1000), dedupe)
      returning id into new_id;
    exception when unique_violation then
      return null; -- the same alert is already open
    end;
  else
    insert into public.workflow_tasks (study_id, action_type, payload, deduplication_key, requires_approval)
    values (e.study_id, 'notify_staff', jsonb_build_object('reason', left(p_reason, 2000), 'recommended_action', left(p_action, 1000),
            'severity', p_severity, 'alert_type', p_alert_type, 'source', 'patient_assistant', 'engagement_id', e.id, 'phase', e.phase),
            dedupe, false)
    on conflict (study_id, deduplication_key) do nothing returning id into new_id;
  end if;
  return new_id;
end $$;

create or replace function assistant.request_enrollment(p_engagement uuid, p_visit_at timestamptz) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  e assistant.engagements := assistant.my_engagement(p_engagement);
  new_id uuid;
begin
  if e.participant_id is null then raise exception 'No participant yet' using errcode = '23514'; end if;
  insert into public.workflow_tasks (study_id, participant_id, action_type, payload, deduplication_key, requires_approval, run_after)
  values (e.study_id, e.participant_id, 'confirm_enrollment',
          jsonb_build_object('source', 'patient_assistant', 'screening_visit_at', p_visit_at, 'prescreen', e.eligibility),
          'confirm_enrollment:' || e.participant_id, true, now())
  on conflict (study_id, deduplication_key) do update set payload = excluded.payload
  returning id into new_id;
  return new_id;
end $$;

drop function assistant.rule_alerts(uuid, uuid[]);
drop function assistant.apply_alert_rules(uuid);
drop function assistant.consent_event(uuid, uuid, text, uuid, timestamptz, jsonb);
drop function assistant.raise_alert(uuid, uuid, uuid, text, text, text, text, text, uuid);
drop function assistant.rule_alert_action(text);
drop function assistant.rule_alert_reason(public.measure_definitions, text, numeric, boolean, text);
drop function assistant.rule_matches(jsonb, numeric, boolean, text);
drop function assistant.staff_assignment(uuid, uuid, text);
