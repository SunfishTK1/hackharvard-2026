-- Turns on login for the application roles, sets their passwords from the container's
-- environment (.env), and applies session guard rails. Safe to re-run, for example to rotate
-- passwords after editing .env.
-- On the server, in /opt/apps/clinical-db:
--   docker compose exec -T postgres psql -U postgres -d clinical_trials -f /scripts/roles.sql
\set ON_ERROR_STOP on
\getenv developer_password DEVELOPER_PASSWORD
\getenv patient_agent_password PATIENT_AGENT_PASSWORD
\getenv manager_agent_password MANAGER_AGENT_PASSWORD
\getenv analyst_password ANALYST_PASSWORD

select (coalesce(:'developer_password', '') = '' or coalesce(:'patient_agent_password', '') = ''
     or coalesce(:'manager_agent_password', '') = '' or coalesce(:'analyst_password', '') = '') as missing \gset
\if :missing
  \echo 'Set DEVELOPER_PASSWORD, PATIENT_AGENT_PASSWORD, MANAGER_AGENT_PASSWORD and ANALYST_PASSWORD in .env first.'
  \quit
\endif

-- The first migration also creates these (without login), so either can run first.
select format('create role %I nologin', r)
from unnest(array['app_owner', 'developer', 'patient_agent', 'manager_agent', 'analyst']) as r
where not exists (select from pg_roles where rolname = r) \gexec

alter role developer     login password :'developer_password'     connection limit 20;
alter role patient_agent login password :'patient_agent_password' connection limit 20;
alter role manager_agent login password :'manager_agent_password' connection limit 10;
alter role analyst       login password :'analyst_password'       connection limit 10 bypassrls;
grant app_owner to developer;

-- Guard rails for model-written SQL and for the read-only role.
alter role patient_agent set statement_timeout = '5s';
alter role manager_agent set statement_timeout = '15s';
alter role analyst       set statement_timeout = '60s';
alter role analyst       set default_transaction_read_only = on;

\echo 'Roles ready: developer, patient_agent, manager_agent, analyst.'
