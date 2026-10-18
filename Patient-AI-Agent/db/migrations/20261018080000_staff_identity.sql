-- migrate:up
-- Which of a manager's staff identities a decision is made as: their own (the identity with their
-- name) first, then an investigator, then a trial manager, then a coordinator; a site's own over a
-- study-wide one. So an investigator who uses Trial Ops confirms as themselves.
set local role app_owner;
create or replace function ops.staff_identity(p_manager uuid, p_study uuid, p_site uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select ms.staff_user_id
  from ops.manager_staff ms
  join ops.managers m on m.id = ms.manager_id and m.is_active
  join private.staff_users u on u.id = ms.staff_user_id and u.is_active
  join public.study_staff s on s.staff_user_id = ms.staff_user_id and s.study_id = p_study and s.is_active
    and (s.site_id is null or s.site_id = p_site) and s.role in ('principal_investigator', 'trial_manager', 'coordinator')
  where ms.manager_id = p_manager and public.staff_authorized(p_study, ms.staff_user_id, p_site)
  order by (u.display_name = m.display_name) desc,
           case s.role when 'principal_investigator' then 0 when 'trial_manager' then 1 else 2 end,
           s.site_id is null
  limit 1
$$;

-- migrate:down
set local role app_owner;
create or replace function ops.staff_identity(p_manager uuid, p_study uuid, p_site uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select ms.staff_user_id from ops.manager_staff ms
  join ops.managers m on m.id = ms.manager_id and m.is_active
  where ms.manager_id = p_manager and public.staff_authorized(p_study, ms.staff_user_id, p_site)
  order by ms.staff_user_id limit 1
$$;
