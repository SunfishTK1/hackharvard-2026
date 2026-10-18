-- migrate:up
-- When Face ID or a passkey doesn't work for a manager, they can confirm a decision by typing their
-- full name instead. It's recorded as such (verified_method = 'override', with the name typed), so
-- the record shows which decisions were confirmed without Face ID.
set local role app_owner;
alter table ops.approvals add column verified_method text check (verified_method in ('passkey', 'override'));
alter table ops.approvals add column override_name text check (length(override_name) <= 200);
update ops.approvals set verified_method = 'passkey' where verified_with is not null;
alter table ops.approvals drop constraint approvals_check;
alter table ops.approvals add constraint approvals_verified_check check (
  status not in ('verified', 'done')
  or (verified_at is not null and (verified_with is not null or (verified_method = 'override' and override_name is not null)))
);
grant update (verified_method, override_name) on ops.approvals to manager_agent;

-- migrate:down
set local role app_owner;
alter table ops.approvals drop constraint approvals_verified_check;
alter table ops.approvals add constraint approvals_check check (status not in ('verified', 'done') or (verified_with is not null and verified_at is not null)) not valid;
alter table ops.approvals drop column override_name;
alter table ops.approvals drop column verified_method;
