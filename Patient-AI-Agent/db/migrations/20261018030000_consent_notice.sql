-- migrate:up
-- What the site's principal investigator is told by email when someone signs the informed consent:
-- the participant's code, study, site, the ICF version and time, how their identity was checked, and
-- Sage's prescreen. Codes only: no name, phone or contact details. Scoped to the current person like
-- the rest of the bridge.
set local role app_owner;

create function assistant.consent_notice(p_engagement uuid)
returns table (participant_code text, study_code text, study_title text, intervention text, site_name text,
               investigator text, investigator_email text, consent_id uuid, consent_version text, signed_at timestamptz,
               method text, prescreen text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.participant_code, st.study_code, st.title, st.intervention, s.institution_name,
         u.display_name, u.email, c.id, d.version, c.signed_at, c.audit_metadata->>'method', e.eligibility
  from assistant.engagements e
  join public.participants p on p.id = e.participant_id
  join public.studies st on st.id = p.study_id
  join public.sites s on s.id = p.site_id
  join public.participant_consents c on c.participant_id = p.id and c.status = 'signed'
  join public.consent_documents d on d.id = c.consent_document_id
  left join lateral (
    select su.display_name, su.email from public.study_staff x join private.staff_users su on su.id = x.staff_user_id
    where x.study_id = p.study_id and x.site_id = p.site_id and x.role = 'principal_investigator' and x.is_active and su.is_active
    order by x.created_at limit 1
  ) u on true
  where e.id = (assistant.my_engagement(p_engagement)).id
  order by c.signed_at desc
  limit 1
$$;
comment on function assistant.consent_notice(uuid) is 'The consent-signed email to the site investigator: codes, study, site, ICF version and time, identity check, prescreen. No contact details.';
revoke execute on function assistant.consent_notice(uuid) from public;
grant execute on function assistant.consent_notice(uuid) to patient_assistant;

-- migrate:down
set local role app_owner;
drop function assistant.consent_notice(uuid);
