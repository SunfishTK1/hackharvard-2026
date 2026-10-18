// Shapes of the /api responses. The server composes every sentence; the client only renders.

export type TagKind = "need" | "info";

export interface Change {
  when: string;
  text: string;
  where: string;
  tag: string;
  kind: TagKind;
  href?: string;
}

export interface WaitingItem {
  code: string;
  text: string;
  age: string;
  href?: string;
}

export interface WaitingPerson {
  name: string;
  site: string;
  ageDays: number;
  typicalDays: number;
  items: WaitingItem[];
}

export interface WaitingGroup {
  title: string;
  summary: string;
  people: WaitingPerson[];
}

export interface PipelinePoint {
  signedOn: string; // local date, YYYY-MM-DD
  days: number;
  waiting: boolean;
}

export interface StatCard {
  label: string;
  value: string;
  note: string;
}

export interface BlindSpot {
  context: string;
  title: string;
  body: string;
  action: string;
  href?: string;
}

export interface StudyRow {
  short: string;
  meta: string;
  active: number;
  enrolled: number;
  consented: number;
  pending: number;
  withdrawn: number;
  lifecycle: string;
  consent: string;
  alerts: string;
  alertNote: string;
  waiting: string;
  href?: string;
}

/** One of the "top three" items: ranked safety first, then by how far past its usual turnaround. */
export interface Priority {
  kind: "safety" | "overdue" | "follow-up";
  label: string;
  title: string;
  detail: string;
  where: string;
  owner: string;
  waited: string;
  href: string;
}

export interface Priorities {
  items: Priority[];
  /** All open items in scope, including the ones not shown. */
  total: number;
}

export interface HomeData {
  generatedAt: string;
  priorities?: Priorities;
  dateLabel: string;
  hero: { headline: [string, string]; body: string; points?: { label: string; text: string }[] };
  changes: { heading: string; subheading: string; items: Change[] };
  waiting: {
    groups: WaitingGroup[];
    onParticipants: string;
    notStarted: string | null;
  };
  pipeline: {
    heading: string;
    body: string;
    typicalDays: number;
    today: string;
    points: PipelinePoint[];
    chartLabel: string;
    cards: StatCard[];
  };
  blindSpots: { cards: BlindSpot[]; dataQuality: string | null };
  studies: { heading: string; rows: StudyRow[] };
}

// ---------------------------------------------------------------------------
// Inner pages. Codes in links are the database's own: STUDY-001, SITE-001-A,
// STUDY-001-P003.
// ---------------------------------------------------------------------------

/** Participant lifecycle counts, drawn as a segmented bar. */
export interface Lifecycle {
  active: number;
  enrolled: number;
  consented: number;
  pending: number;
  withdrawn: number;
  text: string;
}

export interface Tile {
  value: string;
  label: string;
  dark?: boolean;
}

export interface StudyCard {
  code: string;
  href: string;
  studyCode: string;
  status: string;
  title: string;
  phase: string;
  condition: string;
  counts: string;
  lifecycle: Lifecycle;
  consentPct: number | null;
  consentNote: string;
  completionPct: number | null;
  completionNote: string;
  openAlerts: number;
  alertNote: string;
  waiting: string | null;
}

export interface StudiesData {
  generatedAt: string;
  summary: string;
  studies: StudyCard[];
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface CalendarCell {
  /** 0-1 share answered, or null for no questions that day. */
  share: number | null;
  open: boolean;
  alert: boolean;
  corrected: boolean;
  aria: string;
}

export interface CalendarRow {
  code: string;
  site: string;
  href: string;
  cells: CalendarCell[];
  note: string;
  stalled: boolean;
}

export interface TimedLine {
  when: string;
  text: string;
  meta?: string;
  href?: string;
}

export interface AlertLine {
  code: string;
  title: string;
  meta: string;
  status: string;
  href: string;
}

export interface SiteCard {
  name: string;
  href: string;
  meta: string;
  participants: string;
  note: string;
}

/** The tabs on a study's pages: its overview, each of its sites, and its participant timelines. */
export interface StudyNav {
  overview: string;
  sites: { label: string; href: string }[];
  timelines: string;
}

export interface StudyData {
  generatedAt: string;
  nav: StudyNav;
  priorities: Priorities;
  crumbs: Crumb[];
  eyebrow: string;
  title: string;
  facts: string[];
  tiles: Tile[];
  calendar: { heading: string; days: { label: string; today: boolean }[]; rows: CalendarRow[]; questionsPerDay: number };
  upcoming: { heading: string; items: TimedLine[] };
  sites: { heading: string; items: SiteCard[] };
  alerts: AlertLine[];
  activity: TimedLine[];
  firstSiteHref: string | null;
}

export interface SiteParticipantRow {
  code: string;
  href: string;
  status: string;
  consent: string;
  day: string;
  completion: string;
  last: string;
  missing: string;
  alerts: string;
  next: string;
  tags: string[];
}

export interface SiteData {
  generatedAt: string;
  nav: StudyNav;
  priorities: Priorities;
  crumbs: Crumb[];
  studyHref: string;
  name: string;
  place: string;
  facts: { label?: string; value: string; note?: string }[];
  status: string;
  tiles: Tile[];
  summary: string;
  rows: SiteParticipantRow[];
}

export interface MeasurementRow {
  measure: string;
  day: string;
  date: string;
  due: string;
  status: string;
  value: string;
  source: string;
}

export interface SeriesChart {
  title: string;
  heading: string;
  /** Points by study day; null value = no answer that day. */
  points: { day: number; value: number | null }[];
  min: number;
  max: number;
  threshold: { value: number; label: string } | null;
  aria: string;
}

export interface ChatLine {
  kind: "study" | "participant" | "event";
  meta: string;
  body: string;
}

export interface ParticipantData {
  generatedAt: string;
  nav: StudyNav;
  siteHref: string;
  crumbs: Crumb[];
  code: string;
  facts: { label: string; value: string }[];
  banner: { eyebrow: string; title: string; body: string } | null;
  tiles: Tile[];
  measurements: { heading: string; rows: MeasurementRow[] };
  charts: SeriesChart[];
  messages: { heading: string; meta: string; lines: ChatLine[] };
  alert: {
    severity: string;
    rule: string;
    title: string;
    reason: string;
    facts: { label: string; value: string }[];
    status: string;
  } | null;
  summary: string;
  lifecycle: { state: string; when: string; detail: string; open: boolean }[];
  consent: { version: string; note: string; lines: string[]; status: string } | null;
  contact: { channel: string; note: string };
}

export interface ApprovalTask {
  id: string;
  kind: string;
  code: string;
  href: string;
  summary: string;
  meta: string;
  approver: string;
}

export type AlertGroup = "threshold" | "safety" | "missed" | "consent" | "other";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface AlertCard {
  id: string;
  code: string;
  href: string;
  study: string;
  site: string;
  type: string;
  group: AlertGroup;
  rule: string;
  severity: string;
  severityRank: number;
  reason: string;
  opened: string;
  status: AlertStatus;
  last: string;
}

export interface AlertsData {
  generatedAt: string;
  tasks: ApprovalTask[];
  alerts: AlertCard[];
}

export interface JourneyRow {
  code: string;
  site: string;
  href: string;
  /** Day offsets from today (0 = today, negative = past). null = never happened. */
  roster: number;
  invited: number | null;
  signed: number | null;
  declined: number | null;
  enrolled: number | null;
  activated: number | null;
  ended: number | null;
  silentFrom: number | null;
  alerts: { day: number; status: AlertStatus }[];
  note: string;
  stalled: boolean;
}

export interface JourneyStudy {
  short: string;
  nav: StudyNav;
  meta: string;
  rows: JourneyRow[];
}

export interface JourneysData {
  generatedAt: string;
  total: number;
  firstDay: number;
  ticks: { day: number; label: string }[];
  studies: JourneyStudy[];
  typicalNote: string;
}

export type CellKind = "done" | "missed" | "open" | "upcoming" | "none";

export interface ReportedSlot {
  kind: CellKind;
  text: string;
  flagged: boolean;
  corrected: boolean;
  numeric: number | null;
}

export interface ReportedMeasure {
  label: string;
  sub: string;
  /** Indexed like ReportedData.days. */
  cells: ReportedSlot[][];
  numeric: { lo: number; hi: number } | null;
}

export interface DayItemLine {
  kind: "out" | "in" | "note" | "flag";
  text: string;
  meta?: string;
}

export interface DayItem {
  time: string;
  label: string;
  status: string;
  statusKind: "ok" | "flag" | "missed" | "open";
  lines: DayItemLine[];
}

export interface ReportedDay {
  date: string; // YYYY-MM-DD
  dow: string;
  label: string; // Oct 17
  longDate: string;
  studyDay: number | null;
  today: boolean;
  items: DayItem[];
}

export interface ReportedPicker {
  code: string;
  study: string;
  site: string;
  why: string;
}

export interface ReportedData {
  generatedAt: string;
  nav: StudyNav | null;
  siteHref: string | null;
  crumbs: Crumb[];
  pickers: ReportedPicker[];
  /** Every participant, for the full selector. */
  all: { code: string; study: string; site: string }[];
  participant: {
    code: string;
    site: string;
    coordinator: string;
    studyDay: string;
    length: string;
  } | null;
  days: ReportedDay[];
  measures: ReportedMeasure[];
}

export type CalendarKind = "booked" | "visit";

export interface CalendarEvent {
  id: string;
  date: string; // local YYYY-MM-DD
  time: string; // "10:00 AM"
  minutes: number; // minutes after local midnight, for ordering
  kind: CalendarKind;
  /** e.g. "Screening visit", "Week 4 visit" */
  type: string;
  title: string;
  detail: string;
  study: string;
  where: string;
  status: string;
  attention: string | null;
  href: string | null;
}

export interface CalendarData {
  generatedAt: string;
  today: string;
  from: string;
  to: string;
  events: CalendarEvent[];
  /** False when the patient assistant's booking table isn't in this database. */
  bookingsAvailable: boolean;
}

// Study and site setup (setup.ts). A draft comes from the uploaded documents; the person
// reviews and edits it, then the server checks it against the database and creates it.

export type DocumentKind = "protocol" | "icf" | "schedule_of_activities" | "epro" | "site_roster" | "site_info" | "site_icf" | "unknown";

/** One uploaded file, sent as base64 so the server can hash and keep the original. */
export interface UploadFile {
  name: string;
  data: string;
}

export interface ParsedFile {
  name: string;
  kind: DocumentKind;
  /** e.g. "Protocol", "Site information sheet" */
  label: string;
  version: string | null;
  sha256: string;
  bytes: number;
  studyCode: string | null;
  siteCodes: string[];
  synthetic: boolean;
  /** What the parser read, before anyone edited it; stored as the extraction. */
  extracted: Record<string, unknown>;
  notes: string[];
}

export type MeasureType = "numeric" | "integer" | "boolean" | "text" | "choice" | "json";
export type ScheduleFrequency = "once" | "daily" | "weekly" | "custom_days";

export interface DraftMeasure {
  fieldId: string;
  code: string;
  label: string;
  prompt: string;
  responseType: string;
  frequencyText: string;
  sourceText: string;
  dataType: MeasureType;
  unit: string;
  min: number | null;
  max: number | null;
  choices: string[];
  sourceType: string;
  frequency: ScheduleFrequency;
  times: string[];
  weekdays: number[];
  studyDays: number[];
  graceMinutes: number;
}

export interface DraftArm {
  code: string;
  name: string;
  intervention: string;
  dose: string;
  frequency: string;
  control: boolean;
}

export interface DraftRule {
  code: string;
  name: string;
  type: "consent_overdue" | "missing_assessments" | "value_threshold" | "safety_review";
  measureCode: string | null;
  condition: Record<string, unknown>;
  severity: "low" | "medium" | "high" | "critical";
  action: "remind" | "notify_staff" | "require_review";
  enabled: boolean;
  why: string;
}

export interface StudyDraft {
  code: string;
  title: string;
  protocolId: string;
  protocolVersion: string;
  sponsor: string;
  phase: string;
  condition: string;
  design: string;
  intervention: string;
  targetEnrollment: number | null;
  durationWeeks: number | null;
  primaryOutcome: string;
  icfVersion: string;
  soaVersion: string;
  eproVersion: string;
  arms: DraftArm[];
  inclusion: string[];
  exclusion: string[];
  visits: string[];
  activities: { name: string; visits: string[] }[];
  measures: DraftMeasure[];
  risks: string[];
  rules: DraftRule[];
  managerName: string;
  managerEmail: string;
  activate: boolean;
}

export interface SiteDraft {
  code: string;
  institution: string;
  address: string;
  city: string;
  state: string;
  country: string;
  timeZone: string;
  status: "setup" | "active" | "paused" | "closed";
  pi: string;
  coordinator: string;
  coordinatorEmail: string;
  coordinatorPhone: string;
  localIcfVersion: string;
  /** Uploaded files (by name) that belong to this site. */
  infoFile: string | null;
  icfFile: string | null;
}

export interface SetupContext {
  signedIn: boolean;
  actor: string | null;
  studies: { code: string; title: string; status: string; sites: string[]; icfVersion: string | null; manager: string | null }[];
  staff: string[];
  samples: { study: string; title: string; files: string[]; siteFiles: string[] }[];
}

export interface ParseResult {
  files: ParsedFile[];
  study: StudyDraft | null;
  studyCode: string | null;
  sites: SiteDraft[];
  warnings: string[];
}

export interface SetupOutcome {
  ok: true;
  dryRun: boolean;
  code: string;
  href: string;
  /** Plain-language list of what was (or would be) created. */
  created: string[];
  warnings: string[];
}
