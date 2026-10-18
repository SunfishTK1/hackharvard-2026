-- migrate:up
-- Computer sizes for Trial Ops analyses: standard, large (more CPU and memory) or gpu. A manager has
-- one computer at a time; asking for another size replaces it.
set local role app_owner;
alter table ops.computers add column machine text not null default 'standard' check (machine in ('standard', 'large', 'gpu'));
alter table ops.computers add column gpu integer not null default 0;

-- migrate:down
set local role app_owner;
alter table ops.computers drop column gpu;
alter table ops.computers drop column machine;
