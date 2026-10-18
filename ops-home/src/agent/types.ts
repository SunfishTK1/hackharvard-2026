// The Trial Ops view models, as GET /api/agent/views/<view> returns them (Patient-AI-Agent/src/ops/data.ts),
// and the decision (approval) and preference shapes of the Trial Ops API.

export type ApiView = "home" | "approvals" | "alerts" | "alert" | "study" | "participant" | "pipeline" | "quality" | "analyses" | "analysis";

export interface Link { view: string; params?: Record<string, string> }

export interface StudyRow {
  code: string;
  short: string;
  title: string;
  phase: string;
  status: string;
  managers: string | null;
  target: number | null;
  counts: Record<"consent_pending" | "consented" | "enrolled" | "active" | "completed" | "withdrawn" | "screen_failed", number>;
  participants: number;
  enrolled: number;
  invited: number;
  signed: number;
  openAlerts: number;
  highAlerts: number;
  completion7d: number | null;
  decisions: number;
}

export interface AlertItem {
  id: string;
  study: string;
  participant: string;
  site: string;
  severity: string;
  status: string;
  type: string;
  reason: string;
  rule: string | null;
  assignee: string | null;
  assigneeRole: string | null;
  createdAt: string;
  when: string;
  age: string;
  fromSage: boolean;
}

export interface Change {
  at: string;
  when: string;
  text: string;
  where: string;
  tag: string;
  kind: "need" | "info";
  link?: Link;
}

export interface Home {
  generatedAt: string;
  date: string;
  headline: string;
  lede: string;
  tiles: { label: string; value: string; note: string; tone: "alert" | "good" | "neutral"; link: Link }[];
  studies: StudyRow[];
  changes: Change[];
}

export interface AlertDetail extends AlertItem {
  recommendedAction: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  reviewTaskId: string | null;
  participantStatus: string;
  related: AlertItem[];
}

export interface EnrollmentItem {
  taskId: string;
  study: string;
  participant: string;
  site: string;
  status: string;
  consent: string;
  signedAt: string | null;
  waiting: string;
  waitingDays: number;
  assignee: string | null;
  screeningVisit: string | null;
  prescreen: string | null;
  viaSage: boolean;
}

export interface SafetyItem {
  taskId: string;
  alertId: string | null;
  study: string;
  participant: string;
  site: string;
  severity: string;
  reason: string;
  waiting: string;
  waitingDays: number;
  assignee: string | null;
}

export interface ActivationItem {
  participantId: string;
  study: string;
  participant: string;
  site: string;
  enrolled: string;
  waitingDays: number;
  confirmedBy: string | null;
  viaSage: boolean;
}

export interface Approvals {
  enrollments: EnrollmentItem[];
  safety: SafetyItem[];
  activations: ActivationItem[];
}

export interface StudyDetail {
  study: StudyRow & { design: string | null; condition: string | null; durationWeeks: number | null; primaryOutcome: string | null; sponsor: string | null };
  funnel: { stage: string; count: number }[];
  sites: { code: string; name: string; city: string; investigator: string | null; coordinator: string | null; participants: number; active: number; consentPending: number; completion: number | null; overdue: number; openAlerts: number }[];
  measures: { code: string; label: string; due: number; done: number; rate: number | null }[];
  participants: { code: string; status: string; site: string; openAlerts: number; overdue: number; lastReading: string | null; viaSage: boolean }[];
  alerts: AlertItem[];
  changes: Change[];
  sage: { people: number; prescreened: number; likelyEligible: number; consented: number; enrolled: number } | null;
}

export interface Series {
  code: string;
  label: string;
  unit: string | null;
  numeric: boolean;
  points: { at: string; day: string; value: string; n: number | null; flagged: boolean; superseded: boolean }[];
}

export type PendingKind = "confirm_enrollment" | "review_safety" | "activate";

export interface ParticipantDetail {
  code: string;
  study: string;
  studyShort: string;
  site: string;
  status: string;
  eligibility: string;
  arm: string | null;
  enrolled: string | null;
  activated: string | null;
  confirmedBy: string | null;
  viaSage: boolean;
  consent: { version: string; status: string; invited: string | null; signed: string | null } | null;
  adherence: { due: number; done: number; overdue: number; rate: number | null };
  readings: Series[];
  alerts: AlertItem[];
  timeline: { when: string; text: string }[];
  messages: { inbound: number; outbound: number; lastInbound: string | null; last: { when: string; direction: string; body: string } | null };
  nextVisit: string | null;
  pending: { kind: PendingKind; id: string; text: string }[];
}

export interface Pipeline {
  headline: string;
  lede: string;
  stages: { study: string; short: string; invited: number; opened: number; signed: number; declined: number; enrolled: number; active: number }[];
  medians: { label: string; days: number | null; note: string }[];
  points: { study: string; participant: string; signedOn: string; days: number; waiting: boolean }[];
  stuck: { study: string; participant: string; what: string; age: string; days: number }[];
  sage: { study: string; people: number; prescreened: number; likelyEligible: number; needsReview: number; consented: number; enrolled: number }[];
}

export interface Quality {
  headline: string;
  lede: string;
  completion: { study: string; site: string; due: number; done: number; overdue: number; rate: number | null }[];
  measures: { study: string; label: string; due: number; done: number; rate: number | null }[];
  silent: { study: string; participant: string; site: string; lastReply: string; days: number }[];
  flagged: { study: string; participant: string; measure: string; value: string; when: string }[];
  corrections: { study: string; participant: string; measure: string; from: string; to: string; when: string }[];
  undelivered: { study: string; participant: string; when: string; error: string }[];
  gaps: { study: string; participant: string; measure: string; from: string; days: number }[];
}

export type AnalysisStatus = "running" | "done" | "failed" | "cancelled";
export type AnalysisPhase = "starting" | "installing" | "loading" | "analyzing" | "saving" | "done" | "failed" | "cancelled";

export interface AnalysisSummary {
  id: string;
  title: string;
  request: string;
  status: AnalysisStatus;
  phase: AnalysisPhase;
  when: string;
  finished: string | null;
  steps: number;
  elapsedSeconds: number;
}

export interface AnalysisReport extends AnalysisSummary {
  summary: string | null;
  findings: string[];
  files: { name: string; kind: "image" | "table" | "document" | "other"; size: number; url: string }[];
  error: string | null;
  phases: { key: "computer" | "data" | "analysis" | "report"; label: string; state: "done" | "active" | "todo" | "failed" | "stopped" }[];
  log: { at: string; when: string; kind: "phase" | "step"; text: string; running?: boolean; exitCode?: number; seconds?: number; detail?: string }[];
  computer: { status: string; cpu: number; memory: number; gpu: number; machine: string; idleStopMinutes: number } | null;
  canCancel: boolean;
}

export type DecisionKind = "confirm_enrollment" | "decline_enrollment" | "activate" | "review_safety" | "acknowledge_alert" | "resolve_alert";

export interface Approval {
  id: string;
  kind: DecisionKind;
  status: "pending" | "verified" | "done" | "failed" | "cancelled";
  title: string;
  lines: string[];
  note: string | null;
  needsNote: boolean;
  notePrompt: string | null;
  outcome: string | null;
  error: string | null;
  preparedBy: "agent" | "manager";
  sageFollowUp: boolean;
  /** The decision's mini-app page (Face ID there when this browser can't). */
  url?: string;
}

export interface Prefs {
  alerts: "all" | "high" | "critical" | "off";
  briefing: string;
  timeZone?: string;
}
