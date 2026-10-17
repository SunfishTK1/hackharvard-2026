# Clinical-DB

The shared Postgres database for the clinical trial hackathon project. It holds trial configuration, the per-patient iMessage agent's conversations and memory, patient data from the agent and other sources (synthetic, EHR, wearables, labs), the trial manager's cross-patient views, and the trial manager agent's conversations and memory.

**Start with [docs/ONTOLOGY.md](docs/ONTOLOGY.md)**: it explains every schema and table, how data flows between the two agents, and the security model.

> **Synthetic data only.** This server isn't set up for real patient data (PHI/HIPAA). Use generated or fully de-identified data.

| | |
| --- | --- |
| Database | PostgreSQL 18.6 with pgvector 0.8.7, database `clinical_trials` |
| Host | `db.hackharvard2026.velroi.com`, port `5432`, TLS required (`sslmode=require`) |
| Web browser (read-only) | https://db.hackharvard2026.velroi.com (team login) |
| Demo data | Two fictional trials: NORTHSTAR-2 (migraine, 3 arms) and BREATHE-1 (asthma) |

## Connect

Connection strings for every role are in `Clinical-DB/.env`, which isn't in git. Ask a teammate who has it to send it to you privately, and save it as `Clinical-DB/.env`.

```sh
psql "postgres://developer:<password>@db.hackharvard2026.velroi.com:5432/clinical_trials?sslmode=require"
```

```ts
// Node (pg)
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
```

```python
# Python (psycopg 3)
import os, psycopg
conn = psycopg.connect(os.environ["DATABASE_URL"])  # the URL already has sslmode=require
```

The server uses a self-signed certificate, so connections are encrypted but the certificate isn't verified (`sslmode=require`, `rejectUnauthorized: false`).

### Roles

| Role | `.env` variable | For | Can do |
| --- | --- | --- | --- |
| `developer` | `DATABASE_URL` | Teammates | Everything, including migrations |
| `analyst` | `ANALYST_DATABASE_URL` | Notebooks, dashboards, the web browser | Read everything; can't write |
| `patient_agent` | `PATIENT_AGENT_DATABASE_URL` | The patient iMessage agent | One patient at a time, after `patient_agent.use_participant()` |
| `manager_agent` | `MANAGER_AGENT_DATABASE_URL` | The trial manager iMessage agent | `analytics.*` for one manager's trials, after `manager_agent.use_staff()` |

Agents should use their own role, never `developer`: that's what keeps one patient's agent session out of another patient's data. See "Security and scoping" in the ontology.

## Change the schema

Schema changes are SQL migrations in `db/migrations`, applied in order by [dbmate](https://github.com/amacneil/dbmate). Everyone uses migrations; nobody edits tables by hand on the server.

```sh
brew install dbmate             # or: npm install -g dbmate
cd Clinical-DB                  # dbmate reads DATABASE_URL from .env here

dbmate status                   # what's applied
dbmate new add_symptom_photos   # creates db/migrations/<timestamp>_add_symptom_photos.sql
# edit the new file (template below), then:
dbmate up                       # apply to the shared database
dbmate rollback                 # undo the last migration, if you need to
```

`.env` sets `DBMATE_NO_DUMP_SCHEMA=true`, because dbmate's automatic schema dump needs a local `pg_dump` matching the server's version 18.

Migration template:

```sql
-- migrate:up
set local role app_owner;   -- keeps the team as owner of everything
create table clinical.symptom_photos (
  id              uuid primary key default uuidv7(),
  participant_id  uuid not null references trial.participants (id) on delete cascade,
  ...
);
comment on table clinical.symptom_photos is 'What it is and who writes it.';

-- migrate:down
set local role app_owner;
drop table clinical.symptom_photos;
```

Patient-level tables also need row-level security and grants; the checklist is at the end of [docs/ONTOLOGY.md](docs/ONTOLOGY.md#extending-the-schema). Commit the migration file. Run `dbmate status` before you start so you build on the latest schema, and coordinate in chat if two people are changing the same table.

Adding a measure, arm, site or prompt is data, not schema: just insert rows.

`db/schema.sql` is a reference dump of the current schema. Regenerate it after migrations (see Operations).

## Files

```
compose.yaml             Postgres, dbmate (migrate), pgweb (ui)
docker/start.sh          creates the TLS certificate on first start
docker/pg_hba.conf       connection rules: TLS + password; no network superuser
scripts/roles.sql        login roles, passwords (from .env) and guard rails
db/migrations/           schema history, one domain per migration
db/seeds/demo.sql        synthetic demo trials (safe to re-run)
db/tests/access.sql      proves the access rules hold
db/schema.sql            reference dump of the current schema
docs/ONTOLOGY.md         what everything means
```

## Operations

The database runs on the team server as the Compose project `/opt/apps/clinical-db` (see [../server/README.md](../server/README.md)). Server commands run there:

```sh
ssh root@hackharvard2026.velroi.com
cd /opt/apps/clinical-db

docker compose run --rm migrate up      # apply migrations (as superuser)
docker compose run --rm migrate status
docker compose exec -T postgres psql -U postgres -d clinical_trials -f /db/seeds/demo.sql    # reload demo data
docker compose exec -T postgres psql -U postgres -d clinical_trials -f /db/tests/access.sql  # check access rules
docker compose exec -T postgres psql -U postgres -d clinical_trials -f /scripts/roles.sql    # after changing passwords in .env
docker compose exec postgres psql -U postgres -d clinical_trials                              # SQL shell
docker compose logs -f postgres

# Backup and restore
docker compose exec -T postgres pg_dump -U postgres -Fc clinical_trials > clinical_trials-$(date +%F).dump
docker compose exec -T postgres pg_restore -U postgres -d clinical_trials --clean --if-exists < clinical_trials-2026-10-17.dump
```

To ship changes to compose, config or seed files, run `server/deploy.sh Clinical-DB` from the repo root. It restarts Postgres for a few seconds and keeps the data and `.env`. Migrations that teammates applied with dbmate are already live; files only need deploying for the server-side commands above.

Regenerate the reference schema from the repo root:

```sh
ssh root@hackharvard2026.velroi.com 'cd /opt/apps/clinical-db && docker compose exec -T postgres pg_dump -U postgres -d clinical_trials --schema-only --no-owner --no-privileges -n core -n trial -n patient_agent -n clinical -n manager_agent -n analytics' > Clinical-DB/db/schema.sql
```

### Network access

The server's own firewall allows 5432, but the hosting provider (IONOS) also filters traffic before it reaches the server. To connect from outside, TCP 5432 must be allowed in the IONOS Cloud Panel: **Network → Firewall Policies**, add an inbound rule for TCP 5432 to the policy attached to this server. Until then, the database is reachable from the server itself (and from apps deployed there) and through the web browser.
