// The data an analysis works on: the ops.* views as CSV files, plus a data dictionary. This is what
// leaves for the Daytona computer, so it is the manager's view of the platform without message
// text: codes not names, no contact details, signatures or consent evidence (the views never had
// them), and the message log as metadata only.
import type { Query } from "../db.ts";

const TABLES: { name: string; about: string; sql: string }[] = [
  { name: "studies", about: "One row per study (study_code, intervention, condition, phase, status, target_enrollment, duration_weeks, managers).", sql: "select * from ops.studies" },
  { name: "sites", about: "Study sites, with the investigator and coordinator.", sql: "select * from ops.sites" },
  { name: "staff", about: "Study team assignments (name, role, site).", sql: "select assignment_id, study_id, site_id, name, role, receives_alerts, is_active from ops.staff" },
  { name: "arms", about: "Study arms (randomization groups) and allocation ratios.", sql: "select * from ops.arms" },
  { name: "participants", about: "Pseudonymous roster: status (consent_pending, consented, enrolled, active, completed, withdrawn, screen_failed), arm, lifecycle timestamps, via_sage (recruited by the iMessage assistant).", sql: "select id, study_id, study_code, site_id, site_code, participant_code, status, eligibility_status, arm_code, arm_name, enrolled_at, activated_at, completed_at, withdrawn_at, created_at, has_current_consent, via_sage, is_synthetic from ops.participants" },
  { name: "consents", about: "Consent invitations and their status, with presented/opened/signed/declined/revoked times.", sql: "select * from ops.consents" },
  { name: "events", about: "Append-only participant lifecycle events (status_changed with previous/new status, consent_* events, randomized, ...).", sql: "select id, study_id, participant_id, participant_code, event_type, previous_status, new_status, actor, metadata::text as metadata, occurred_at from ops.events" },
  { name: "measures", about: "What participants report (measure_code, label, data_type, unit, valid range, source_type).", sql: "select * from ops.measures" },
  { name: "assessments", about: "Expected assessments (one row per due check-in item): due window and status (pending, completed, overdue, skipped, cancelled).", sql: "select * from ops.assessments" },
  { name: "readings", about: "Observations participants reported: value (numeric_value / boolean_value / text_value), requires_review (flagged by rules or out of range), review_status, superseded (corrected by a later reading via supersedes_observation_id).", sql: "select id, study_id, participant_id, participant_code, site_id, measure_code, label, unit, data_type, numeric_value, boolean_value, text_value, source_type, via_sage, requires_review, review_status, supersedes_observation_id, superseded, scheduled_assessment_id, captured_at from ops.readings" },
  { name: "alert_rules", about: "Each study's monitoring rules (value thresholds, safety reviews, missing data, consent overdue).", sql: "select id, study_id, rule_code, name, rule_type, severity, action_type, enabled, measure_code, condition::text as condition from ops.alert_rules" },
  { name: "alerts", about: "Alerts raised: severity, status (open, acknowledged, resolved), reason, rule, assignee and role, acknowledge/resolve times.", sql: "select id, study_id, study_code, participant_id, participant_code, site_id, site_code, alert_type, severity, status, reason, recommended_action, rule_code, rule_name, assignee, assignee_role, acknowledged_by, resolved_by, created_at, acknowledged_at, resolved_at, from_sage from ops.alerts" },
  { name: "tasks", about: "Workflow tasks (send_consent, confirm_enrollment, review_safety, notify_staff, ...), status, assignee, approvals.", sql: "select id, study_id, study_code, participant_id, participant_code, site_id, action_type, status, requires_approval, assignee, assignee_role, approved_by, approved_at, run_after, completed_at, created_at from ops.tasks" },
  { name: "messages", about: "The study message log as metadata only (no text): direction, channel, type, delivery status and times.", sql: "select id, study_id, participant_id, participant_code, site_id, direction, channel, provider, message_type, status, error_code, sent_at, delivered_at, received_at, created_at from ops.messages_log" },
  { name: "site_metrics", about: "The platform's own per-site analytics (participants, consent, completion rate, overdue, open alerts).", sql: "select * from ops.site_metrics" },
  { name: "sage_funnel", about: "The iMessage assistant's recruitment funnel per study (people, prescreened, likely eligible, consented, enrolled).", sql: "select * from ops.sage_funnel" },
];

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface Snapshot {
  files: { name: string; content: Buffer }[];
  tables: { name: string; rows: number }[];
  takenAt: string;
}

/** Every table as CSV, plus README.md describing them. */
export async function snapshot(q: Query): Promise<Snapshot> {
  const files: Snapshot["files"] = [];
  const tables: Snapshot["tables"] = [];
  const dictionary: string[] = [];
  for (const t of TABLES) {
    const rows = await q<Record<string, unknown>>(t.sql);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))];
    files.push({ name: `${t.name}.csv`, content: Buffer.from(`${lines.join("\n")}\n`, "utf8") });
    tables.push({ name: t.name, rows: rows.length });
    dictionary.push(`## ${t.name}.csv (${rows.length} rows)\n${t.about}\nColumns: ${columns.join(", ") || "(empty)"}\n`);
  }
  const takenAt = new Date().toISOString();
  files.push({
    name: "README.md",
    content: Buffer.from(`# Clinical trial platform snapshot\n\nTaken ${takenAt}. Synthetic demo data from the consent-first clinical trial platform, as trial managers see it (participant codes, no names or contact details, no message text). Join on the *_id columns; timestamps are UTC ISO 8601.\n\n${dictionary.join("\n")}`, "utf8"),
  });
  return { files, tables, takenAt };
}
