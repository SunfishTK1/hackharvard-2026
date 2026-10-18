-- migrate:up
-- Trial Ops reaches out: a text when a new alert at or above the manager's level comes in at one of
-- their studies, and a morning briefing at their time. Each manager sets both in chat or on the
-- Notifications screen; ops.notices records what was sent, so nothing goes twice.
set local role app_owner;

alter table ops.managers add column prefs jsonb not null default '{"alerts": "high", "briefing": "08:00"}'
  check (prefs->>'alerts' in ('all', 'high', 'critical', 'off')
         and (prefs->>'briefing' = 'off' or prefs->>'briefing' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
comment on column ops.managers.prefs is 'alerts: which new alerts Trial Ops texts about (all, high = high and critical, critical, off); briefing: the morning briefing time (HH:MM, team time zone) or off.';

create table ops.notices (
  manager_id uuid not null references ops.managers (id) on delete cascade,
  kind text not null check (kind in ('alert', 'briefing')),
  -- The alert's id, or the briefing's date.
  ref text not null,
  sent_at timestamptz not null default now(),
  primary key (manager_id, kind, ref)
);

grant select, insert on ops.notices to manager_agent;
grant update (prefs) on ops.managers to manager_agent;

-- migrate:down
set local role app_owner;
drop table ops.notices;
alter table ops.managers drop column prefs;
