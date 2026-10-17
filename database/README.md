# Consent-first clinical trial database

This design follows the project handoff, including the SQL proposal, workbook,
synthetic rosters/configuration, and all 20 bundled study PDFs. `study` and
`clinical trial` mean the same entity.

## Layout

There are **23 project tables**, one migration-tracking table, and six read-only
analytics views. The proposed table names are retained. Identifiable contacts and
staff identities are deliberately outside `public`.

### Deployment status

The replacement committed to `clinical_trials`, followed by the synthetic demo
seed (`002_seed_synthetic_demo.sql`, described below). Read-only structural
verification passed. The contract suite passed 78 checks on a restored copy, both
empty and seeded. That suite covers this replacement, not other application schemas.

An `assistant` schema (15 tables, 7 functions, 27 configuration rows) was created
by another process while the replacement was being prepared. Dropping the old schemas
removed its 19 cross-schema foreign keys and five update-timestamp triggers. It
was then removed on request with `DROP SCHEMA assistant CASCADE`, after confirming
that no object outside it depended on it. The live database now contains only the
`public`, `private`, `audit`, and `analytics` schemas.

`pre-replacement.dump` contains the complete old schema **and** the assistant
schema with its original dependencies. The earlier `clinical_trials.dump` was
taken before assistant existed. `post-replacement-with-assistant.dump` preserves
the committed replacement plus the remaining assistant objects and data.

| Schema | Tables | Purpose |
| --- | --- | --- |
| `public` | `studies`, `sites`, `study_staff` | Study configuration, site hierarchy, and responsible team assignments |
| `public` | `study_documents`, `document_extractions` | Versioned source files and separately reviewed AI extraction drafts |
| `public` | `study_arms`, `eligibility_rules` | Shared study configuration, not copies on every participant |
| `public` | `consent_documents`, `participant_consents` | Controlled master/site ICF versions, signatures, revocations, copy delivery |
| `public` | `participants`, `participant_events` | Pseudonymous roster and append-only lifecycle history |
| `public` | `measure_definitions`, `assessment_schedules`, `scheduled_assessments`, `observations` | Definitions, recurrence, expected instances, and actual source-backed responses |
| `public` | `message_threads`, `messages` | Provider conversation identifiers, original messages, and delivery states |
| `public` | `alert_rules`, `alerts`, `workflow_tasks` | Reviewed monitoring rules, site/staff routing, and retryable work |
| `private` | `participant_contacts`, `staff_users` | Contact methods, messaging permission, and staff authentication references |
| `audit` | `events` | Change identifiers, column names, database actor, and request correlation, without sensitive before/after values |
| `public` | `schema_migrations` | Applied database migration version |

`study_staff.id` identifies a **study/site assignment**, not a staff identity.
For example, `alerts.assigned_staff_id` references an assignment, whereas
`alerts.resolved_by` references `private.staff_users.id`.

### Main design improvements over the supplied draft

- Composite foreign keys prevent cross-study sites, arms, measures, consent
  documents, messages, assessments, and observations from being mixed.
- All new participants start `consent_pending`. Database triggers enforce
  `consent_pending -> consented -> enrolled -> active -> completed`, with allowed
  withdrawal/screen-failure exits. Enrollment requires eligibility, an active
  study, current signed consent, and confirmation by authorized staff.
- Documents and extractions need staff review. Study approval/activation requires
  an approved protocol extraction. Consent versions must reference an approved
  ICF with the same study/site/version.
- A site-specific active ICF overrides the master. Expired local ICFs do not
  silently fall back to an old signed master. A new active version or revocation
  blocks study-message dispatch until applicable consent is signed.
- A consent invitation identifies its approved ICF. Study messaging checks
  lifecycle, contact channel, opt-in, study/site activation, and consent when
  messages enter the dispatch states. Inbound messages remain recordable after
  withdrawal, so late safety-related source material is not lost.
- Consent, source-document, observation, and message evidence cannot be hard
  deleted/truncated through normal DML. Source content cannot be overwritten after
  it becomes evidence. Observation corrections are new, linked records.
- Numeric, integer, boolean, choice, text, and compound JSON measures are supported.
  Outliers are retained and marked for review, not discarded. In-use measure
  types/units/bounds/choices cannot be changed underneath existing responses.
- Schedules represent twice-daily times, selected weekdays, and explicit study
  days for visits/labs. Store due windows as UTC `timestamptz`; the scheduler must
  calculate them using the participant's IANA time zone and DST rules.
- An expected assessment is separate from a response. A non-rejected,
  non-superseded response marks it completed. Rejecting the only current response
  reopens it. Overdue is calculated from its closing time rather than stored as
  a potentially stale status.
- Workflow/message idempotency keys and unresolved-alert deduplication prevent
  duplicate work. Safety-review and enrollment-confirmation tasks require staff
  approval before running/completing.
- Withdrawal/completion/screen failure cancel pending assessments, pending review
  tasks, and draft/queued outbound messages. A worker must also recheck state
  immediately before every external action, including work already claimed.

The six `analytics` views are `study_dashboard`, `site_metrics`,
`participant_attention`, `assessment_status`, `alert_queue`, and `message_metrics`.
Completion rate means **non-rejected responses / due expected assessments**,
excluding skipped/cancelled instances and not yet due instances. It is an
operational response metric, not a claim of clinical validity or safety review.
Zero denominators produce `NULL`, not a misleading zero percent.

## Access and application integration

- `app_owner` owns the application objects. The existing `developer` membership
  retains administrative access. These are trusted backend/admin privileges, not
  credentials to give browsers, patients, or an LLM.
- `analyst` and `manager_agent` can read the six analytics views. They cannot
  directly read contacts, raw message bodies, signatures, or observation values.
  These views cover all studies. They are not a multi-tenant authorization layer.
- `patient_agent` deliberately has no unscoped table access. Integrate a trusted,
  authenticated backend that scopes every request to the correct participant
  before enabling patient-facing APIs.
- Existing login roles/passwords, PostgreSQL settings, and installed extensions
  are preserved. The old application schemas and lookup functions are removed.
  Existing demo apps must be updated; no application containers/configuration
  were rewritten or restarted by this migration.
- Staff IDs in writes must come from authenticated backend identity, never an
  untrusted model or client. Triggers check assignments, not whether a human
  actually clicked an approval button. Use a dedicated least-privilege runtime
  role before exposing a real application.
- `SET LOCAL app.request_id = 'your-request-id'` adds request correlation to audit
  records. No caller-supplied session setting grants access.
- Audit/evidence triggers protect normal SQL operations. A superuser or object
  owner can bypass them with DDL. This is not tamper-proof regulatory storage.

This creates database structures and guardrails. It does **not** implement PDF
parsing, signatures, authentication, a scheduler/queue worker, clinical decisions,
or actual messaging. For workers, claim due tasks using a short transaction with
`FOR UPDATE SKIP LOCKED`, respect attempt limits, revalidate permissions before
dispatch, and use provider idempotency keys. Never execute `alert_rules.condition`
as arbitrary SQL or let an LLM directly send messages or confirm enrollment.

## Synthetic demo data

`002_seed_synthetic_demo.sql` loads a coherent demo into an empty migrated
database. Its source of truth is the handoff package: `study_config.json`, the 20
study PDFs, `all_sites.csv`, and `all_participants_initial.csv`. The workbook's
event and alert sheets were not imported, because they conflict with the roster
(all 40 start `consent_pending`) and list 19 measures instead of the 25 in the
configuration and PDFs.

What it contains:

- The 5 studies, 10 sites, 9 arms, 25 ePRO measures and schedules, and eligibility
  rules, all checked against `study_config.json` during the load.
- Staff: PIs and coordinators from the site roster, plus invented trial managers
  and one analyst. Study documents carry the SHA-256 of each package file.
  Site-level ICFs (for example `2.1-BOS`) are not in the package, so they have no hash.
- The 40 roster participants, moved through the lifecycle by the schema's own
  triggers: 19 active, 5 enrolled, 4 consented, 8 consent pending, 4 withdrawn
  (one revoked consent and replied STOP, one declined, two left the study).
- About 2,300 expected assessments, 2,000 observations, and 3,200 synthetic SMS
  records: prompts, reminders, replies, consent invitations, a failed delivery,
  a skipped week, and a misparsed reply ("60" on a 0-10 scale) that is rejected
  and corrected.
- 16 alerts derived from the data by each rule's condition (thresholds, safety
  reports, 3 missed days, consent unsigned after 7 days), with acknowledgements,
  resolutions, and the matching workflow tasks.

Timestamps are relative to the day the seed runs (America/New_York), so overdue
consents and open alerts are true at load time. Nothing refreshes them later.
Alert thresholds are demo assumptions; the protocols do not state values.

The seed is a single transaction with built-in consistency checks. It records
`002_synthetic_demo_seed` in `schema_migrations` and does nothing on a second run.
It refuses to load if any project table already has rows. Evidence tables are
append-only, so a fresh demo day needs a freshly migrated database, not a re-run.

All contacts use `555` numbers and the `synthetic-sms` provider. Never dispatch
messages to synthetic contacts.

## Files and validation

- `001_replace_clinical_trials.sql`: destructive, atomic, one-time migration from
  the original demo schema. It refuses to run against an already migrated or
  unexpected starting layout. It does not guard against every cross-schema
  dependency, so inspect those before running it.
- `tests/schema_contract.sql`: transactional fixtures covering cross-study
  integrity, lifecycle, approval, consent/reconsent, messaging, source retention,
  typed responses, assessment completion, task/alert routing, metrics, and roles.
  All fixtures roll back.
- `002_seed_synthetic_demo.sql`: idempotent synthetic demo data (see above). Run it
  after the migration with the same `psql` options.
- `verify.sql`: read-only structural validation and aggregate table inventory.

Run as a database administrator with a securely configured connection:

```sh
psql -X -v ON_ERROR_STOP=1 -d clinical_schema_test -f database/001_replace_clinical_trials.sql
psql -X -v ON_ERROR_STOP=1 -d clinical_schema_test -f database/tests/schema_contract.sql
psql -X -v ON_ERROR_STOP=1 -d clinical_schema_test -f database/verify.sql
```

The test database must start as a restore of the original schema, not an empty
database. The migration includes its own transaction; do not wrap it in
`psql --single-transaction`. Run the contract tests on an isolated database first,
then apply the exact tested migration to the target.

### Backup and recovery

The pre-replacement backup stays on the VPS, outside the repository:

`/root/clinical-trials-backup-20261017-VQuQdY/`

The directory is root-only (`0700`) and dump files are `0600`.
`clinical_trials.dump` is the first backup, successfully restored before schema
testing. `pre-replacement.dump` is the fresh backup taken immediately before the
final migration rehearsal/deployment. `pre-seed.dump` is the migrated, empty
database taken immediately before the demo seed.

For recovery, first restore the chosen custom-format dump into a **new** database
using `pg_restore --exit-on-error --single-transaction`. Verify it before changing
application connections. Do not blindly restore with `--clean` over the new
schema: that will not necessarily remove objects absent from the old archive.
Database-level ACLs/settings and cluster roles are not recreated by a plain
database dump; check those before cutting over. No automatic rollback or
credential/role reset is included.

## Recommended next tables, when the corresponding feature is built

1. **`visit_definitions` / `scheduled_visits`**: add when a visit needs independent
   rescheduling, attendance, or several linked assessments. For now, fixed
   visit/lab measurement days fit assessment schedules.
2. **`adverse_events` / `protocol_deviations`**: keep staff-adjudicated clinical
   events separate from operational alerts. An AI safety flag is not a confirmed
   adverse event.
3. **Study configuration releases and source-field provenance**: add immutable
   approved configuration snapshots plus document/page/field references when
   supporting protocol amendments or explaining extraction decisions in detail.
4. **Provider delivery events**: add append-only webhook receipts if delivery
   retries/ordering must be audited independently of the current message state.

Before using real patient data, add scoped authorization, verified opt-in and
eConsent integrations, encryption/key management, retention policies, immutable
external audit storage, tested disaster recovery, and clinical/regulatory review.
