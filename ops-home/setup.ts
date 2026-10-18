// Study and site setup from the documents a trial already has (see PROJECT_HANDOFF.md).
// Study: Protocol, ICF, Schedule of Activities and ePRO PDFs. Site: a site roster (CSV),
// a site information sheet and the site's own ICF (PDFs). The parser proposes a draft,
// a signed-in manager reviews and edits it, and one transaction creates everything the
// way 002_seed_synthetic_demo.sql set up the first five studies: approved source documents
// with their extractions, then arms, eligibility, consent forms, measures, schedules and rules.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { pdfLines, type Line } from "./pdf.ts";
import { loadSite, loadStudy } from "./pages.ts";
import type {
  DocumentKind, DraftArm, DraftMeasure, DraftRule, MeasureType, ParseResult, ParsedFile,
  SetupContext, SetupOutcome, SiteDraft, StudyDraft, UploadFile,
} from "./src/types.ts";

type Env = Record<string, string | undefined>;
type Client = pg.PoolClient;

const MAX_BODY = 12 * 1024 * 1024;
const MAX_FILES = 40;
const PARSER = "ops-home-setup/1.0";
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

class SetupError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- Reading documents --------------------------------------------------------------------

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KIND_LABEL: Record<DocumentKind, string> = {
  protocol: "Protocol", icf: "Informed consent form", schedule_of_activities: "Schedule of activities",
  epro: "Patient questionnaire (ePRO)", site_roster: "Site roster", site_info: "Site information sheet",
  site_icf: "Site consent form", unknown: "Not recognised",
};

/** Label/value rows: "Phase | Phase 2", "Version: 1.3", or a label line followed by its value. */
function fields(lines: Line[], labels: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const want = labels.map((l) => [l, l.toLowerCase()] as const);
  let current: string | null = null;
  let labelX = 0;
  for (const line of lines) {
    const first = line.cells[0].text;
    const hit = want.find(([, l]) => first.toLowerCase() === l || first.toLowerCase() === `${l}:`
      || first.toLowerCase().startsWith(`${l}:`));
    if (hit) {
      const sameCell = first.slice(hit[0].length).replace(/^:\s*/, "");
      const value = clean([sameCell, ...line.cells.slice(1).map((c) => c.text)].join(" "));
      current = hit[0];
      labelX = line.cells[0].x;
      out.set(hit[0], value);
      continue;
    }
    // A wrapped value continues in the value column; anything else ends the row.
    if (current && line.cells.length === 1 && line.cells[0].x > labelX + 40 && !line.cells[0].bold) {
      out.set(current, clean(`${out.get(current)} ${first}`));
    } else {
      current = null;
    }
  }
  return out;
}

const isHeading = (l: Line) => l.cells.length === 1 && l.cells[0].bold;

/** Body lines under the first heading that matches, up to the next heading. */
function section(lines: Line[], heading: RegExp): Line[] {
  const start = lines.findIndex((l) => isHeading(l) && heading.test(l.text));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return end < 0 ? rest : rest.slice(0, end);
}

const paragraph = (ls: Line[]) => clean(ls.map((l) => l.text).join(" "));

function bullets(ls: Line[]): string[] {
  const out: string[] = [];
  for (const l of ls) {
    const m = l.text.match(/^\s*(?:[-•*▪●]|\d+[.)])\s+(.*)$/);
    if (m) out.push(clean(m[1]));
    else if (out.length) out[out.length - 1] = clean(`${out[out.length - 1]} ${l.text}`);
  }
  return out;
}

/** Title, protocol and study IDs, and the document's own version from the top of page one. */
function header(lines: Line[]) {
  const all = lines.map((l) => l.text).join("\n");
  const top = lines.filter((l) => l.page === 0).slice(0, 12);
  const idLine = top.findIndex((l) => /protocol id\s*:/i.test(l.text));
  const sized = top.slice(0, idLine < 0 ? 8 : idLine).filter((l) => !/synthetic demo document/i.test(l.text));
  const biggest = Math.max(...sized.map((l) => l.cells[0].size), 0);
  const banner = top[0]?.text ?? "";
  const titleLines = sized.filter((l) => l.cells[0].size >= biggest - 0.1 && l.text !== banner);
  return {
    banner,
    title: clean(titleLines.map((l) => l.text).join(" ")),
    protocolId: all.match(/Protocol ID\s*:\s*([A-Za-z0-9][\w.-]*)/i)?.[1] ?? "",
    studyCode: all.match(/Study ID\s*:\s*([A-Za-z0-9][\w-]*)/i)?.[1] ?? null,
    version: top.map((l) => l.text.match(/(?:ICF version|Version)\s*:\s*([\w.-]+)/i)?.[1]).find(Boolean) ?? null,
    synthetic: /SYNTHETIC/.test(all),
  };
}

const PROTOCOL_FIELDS = ["Protocol version", "Sponsor", "Phase", "Condition", "Design", "Target enrollment", "Duration", "Primary objective", "Primary endpoint"];
const SITE_FIELDS = ["Site ID", "Institution", "Street address", "Address", "City", "State", "Country", "Time zone",
  "Principal investigator", "Study coordinator", "Coordinator", "Coordinator email", "Coordinator phone", "Site status",
  "Local ICF version", "Based on master ICF version"];

function readProtocol(lines: Line[]) {
  const h = header(lines);
  const f = fields(lines, PROTOCOL_FIELDS);
  const measurements = bullets(section(lines, /measurements|assessments/i)).map((b) => {
    const m = b.match(/^(.*?):\s*(.*?)\s*\(([^)]*)\)\s*$/);
    return m ? { name: clean(m[1]), frequency: clean(m[2]), source: clean(m[3]) } : { name: b, frequency: "", source: "" };
  });
  const armsText = paragraph(section(lines, /study arms|arms|treatment groups/i));
  return {
    study_id: h.studyCode, protocol_id: h.protocolId, title: h.title,
    condition: f.get("Condition") ?? "", phase: f.get("Phase") ?? "", design: f.get("Design") ?? "",
    sponsor: f.get("Sponsor") ?? "",
    target_enrollment: Number(f.get("Target enrollment")?.match(/\d+/)?.[0] ?? NaN) || null,
    duration_weeks: Number(f.get("Duration")?.match(/(\d+)\s*weeks?/i)?.[1] ?? NaN) || null,
    arms: armsText ? armsText.replace(/\.$/, "").split(/\s*;\s*/).map(clean).filter(Boolean) : [],
    intervention: paragraph(section(lines, /synopsis/i)).match(/evaluates (.+?) in participants/i)?.[1] ?? "",
    protocol_version: f.get("Protocol version") ?? h.version ?? "",
    inclusion: bullets(section(lines, /inclusion/i)),
    exclusion: bullets(section(lines, /exclusion/i)),
    primary: f.get("Primary objective") ?? f.get("Primary endpoint") ?? "",
    measures: measurements.map((m) => [m.name, "", m.frequency, m.source]),
  };
}

function readIcf(lines: Line[]) {
  const h = header(lines);
  const risksText = paragraph(section(lines, /risks/i));
  const listed = risksText.match(/include (.+?)\.(?:\s|$)/i)?.[1] ?? "";
  const collect = paragraph(section(lines, /what information/i)).match(/collect:\s*(.+?)\.?$/i)?.[1] ?? "";
  const site = fields(lines, SITE_FIELDS);
  return {
    study_id: h.studyCode, protocol_id: h.protocolId, title: h.title, icf_version: h.version ?? "",
    intervention: paragraph(section(lines, /purpose/i)).match(/evaluating (.+?)\./i)?.[1] ?? "",
    duration_weeks: Number(paragraph(section(lines, /purpose/i)).match(/(\d+)\s*weeks/i)?.[1] ?? NaN) || null,
    collected_measures: collect ? collect.split(/\s*,\s*/).map(clean) : [],
    risks: listed ? listed.split(/\s*,\s*(?:and\s+)?/).map(clean).filter(Boolean) : [],
    participation_voluntary: /voluntary/i.test(paragraph(section(lines, /have to participate/i))),
    electronic_communication: section(lines, /electronic communication/i).length > 0,
    ...(site.get("Site ID") ? { site: Object.fromEntries(site) } : {}),
  };
}

function readSchedule(lines: Line[]) {
  const h = header(lines);
  const headRow = lines.findIndex((l) => l.cells.length > 2 && /^(activity|procedure|assessment)/i.test(l.cells[0].text));
  const visits: { name: string; center: number }[] = headRow < 0 ? [] : lines[headRow].cells.slice(1)
    .map((c) => ({ name: c.text, center: (c.x + c.end) / 2 }));
  const activities: { name: string; visits: string[]; marks: string[] }[] = [];
  for (const l of headRow < 0 ? [] : lines.slice(headRow + 1)) {
    if (l.cells.length === 1 && (l.text.startsWith("*") || isHeading(l))) break;
    if (l.page !== lines[headRow].page && /^(activity|procedure)/i.test(l.cells[0].text)) continue; // repeated header
    const marks = l.cells.slice(1).map((c) => {
      const center = (c.x + c.end) / 2;
      const v = visits.reduce((a, b) => (Math.abs(b.center - center) < Math.abs(a.center - center) ? b : a));
      return { visit: v.name, mark: c.text };
    });
    activities.push({ name: l.cells[0].text, visits: marks.map((m) => m.visit), marks: marks.map((m) => m.mark) });
  }
  return {
    study_id: h.studyCode, soa_version: h.version ?? "", visits: visits.map((v) => v.name),
    activities: activities.map((a) => ({ name: a.name, visits: a.visits, remote: a.marks.some((m) => /remote/i.test(m)) })),
  };
}

function readEpro(lines: Line[]) {
  const h = header(lines);
  const headRow = lines.findIndex((l) => l.cells.length >= 4 && /field|item|id/i.test(l.cells[0].text) && /prompt|question/i.test(l.text));
  const cols = headRow < 0 ? [] : lines[headRow].cells.map((c) => ({ name: c.text.toLowerCase(), x: c.x }));
  const at = (re: RegExp) => cols.findIndex((c) => re.test(c.name));
  const idx = { id: 0, prompt: at(/prompt|question/), type: at(/response|type|format/), freq: at(/frequen|when/), source: at(/source|method/) };
  const items: Array<{ field_id: string; prompt: string; response_type: string; frequency: string; source: string }> = [];
  for (const l of headRow < 0 ? [] : lines.slice(headRow + 1)) {
    if (isHeading(l)) break;
    const row: string[] = cols.map(() => "");
    for (const c of l.parts) {
      let k = 0;
      cols.forEach((col, i) => { if (c.x >= col.x - 4) k = i; });
      row[k] = clean(`${row[k]} ${c.text}`);
    }
    if (/^[A-Z]{0,4}\d{1,3}[a-z]?$/.test(row[0])) {
      items.push({ field_id: row[0], prompt: row[idx.prompt] ?? "", response_type: row[idx.type] ?? "", frequency: row[idx.freq] ?? "", source: row[idx.source] ?? "" });
    } else if (items.length && !row[0]) {
      const last = items[items.length - 1];
      if (idx.prompt >= 0 && row[idx.prompt]) last.prompt = clean(`${last.prompt} ${row[idx.prompt]}`);
      if (idx.type >= 0 && row[idx.type]) last.response_type = clean(`${last.response_type} ${row[idx.type]}`);
      if (idx.freq >= 0 && row[idx.freq]) last.frequency = clean(`${last.frequency} ${row[idx.freq]}`);
      if (idx.source >= 0 && row[idx.source]) last.source = clean(`${last.source} ${row[idx.source]}`);
    } else if (items.length) {
      break;
    }
  }
  return { study_id: h.studyCode, epro_version: h.version ?? "", items };
}

function readSiteInfo(lines: Line[]) {
  const h = header(lines);
  const f = fields(lines, SITE_FIELDS);
  return { study_id: h.studyCode, protocol_id: h.protocolId, ...Object.fromEntries(f) };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") { cell += "\""; i++; }
      else if (ch === "\"") quoted = false;
      else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

function readRoster(text: string) {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const keys = (head ?? []).map((h) => slug(h));
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])) as Record<string, string>);
}

type Parsed = ParsedFile & { buffer: Buffer };

export function parseUpload(file: UploadFile): Parsed {
  const buffer = Buffer.from(file.data, "base64");
  const name = file.name.replace(/[^\w .()-]+/g, "_").slice(0, 120) || "document";
  const base = { name, sha256: sha256(buffer), bytes: buffer.length, buffer, notes: [] as string[] };
  if (/\.csv$/i.test(name) || !buffer.subarray(0, 1024).toString("latin1").includes("%PDF")) {
    const rows = /\.(csv|txt)$/i.test(name) ? readRoster(buffer.toString("utf8")) : [];
    if (rows.length && "site_id" in rows[0] && !("participant_id" in rows[0])) {
      const studies = [...new Set(rows.map((r) => r.study_id).filter(Boolean))];
      return { ...base, kind: "site_roster", label: KIND_LABEL.site_roster, version: null, studyCode: studies[0] ?? null,
        siteCodes: rows.map((r) => r.site_id).filter(Boolean), synthetic: false, extracted: { sites: rows },
        notes: studies.length > 1 ? ["This roster lists sites for more than one study."] : [] };
    }
    const note = /(^|,)\s*"?participant_id/i.test(buffer.toString("utf8").split(/\r?\n/)[0] ?? "")
      ? "This is a participant roster. Participants are added later, with data collection."
      : "Only PDF documents and site roster CSV files can be read here.";
    return { ...base, kind: "unknown", label: KIND_LABEL.unknown, version: null, studyCode: null, siteCodes: [], synthetic: false, extracted: {}, notes: [note] };
  }
  let lines: Line[];
  try {
    lines = pdfLines(buffer);
  } catch (err) {
    return { ...base, kind: "unknown", label: KIND_LABEL.unknown, version: null, studyCode: null, siteCodes: [], synthetic: false, extracted: {},
      notes: [`This PDF couldn't be read (${err instanceof Error ? err.message : "unknown format"}).`] };
  }
  if (!lines.length) {
    return { ...base, kind: "unknown", label: KIND_LABEL.unknown, version: null, studyCode: null, siteCodes: [], synthetic: false, extracted: {},
      notes: ["This PDF has no text layer (it may be a scan), so nothing could be read from it."] };
  }
  const h = header(lines);
  const top = lines.slice(0, 4).map((l) => l.text).join(" ");
  const hint = `${top} ${name}`;
  let kind: DocumentKind = "unknown";
  if (/site information/i.test(hint)) kind = "site_info";
  else if (/informed consent|\bICF\b/i.test(hint)) kind = fields(lines, ["Site ID"]).get("Site ID") ? "site_icf" : "icf";
  else if (/schedule of activities|\bSoA\b/i.test(hint)) kind = "schedule_of_activities";
  else if (/questionnaire|ePRO|patient-reported/i.test(hint)) kind = "epro";
  else if (/protocol/i.test(hint)) kind = "protocol";
  const extracted: Record<string, unknown> =
    kind === "protocol" ? readProtocol(lines)
    : kind === "icf" || kind === "site_icf" ? readIcf(lines)
    : kind === "schedule_of_activities" ? readSchedule(lines)
    : kind === "epro" ? readEpro(lines)
    : kind === "site_info" ? readSiteInfo(lines)
    : {};
  const siteCode = kind === "site_info" ? (extracted["Site ID"] as string | undefined)
    : kind === "site_icf" ? ((extracted.site as Record<string, string> | undefined)?.["Site ID"]) : undefined;
  const version = kind === "protocol" ? String(extracted.protocol_version || "") || null
    : kind === "site_info" ? null : h.version;
  const notes: string[] = [];
  if (kind === "unknown") notes.push("This doesn't look like a protocol, consent form, schedule, questionnaire or site sheet.");
  if (kind === "epro" && !(extracted.items as unknown[]).length) notes.push("No questionnaire items were found in a table.");
  if (kind === "schedule_of_activities" && !(extracted.visits as unknown[]).length) notes.push("No visit columns were found.");
  return { ...base, kind, label: KIND_LABEL[kind], version, studyCode: h.studyCode, siteCodes: siteCode ? [siteCode] : [],
    synthetic: h.synthetic, extracted, notes };
}

// --- Turning documents into a draft -------------------------------------------------------

const UNITS: Record<string, { unit: string; min: number | null; max: number | null }> = {
  "mg/dl": { unit: "mg/dL", min: 20, max: 600 }, kg: { unit: "kg", min: 30, max: 250 }, lb: { unit: "lb", min: 60, max: 550 },
  f: { unit: "F", min: 90, max: 110 }, c: { unit: "C", min: 32, max: 43 }, mmhg: { unit: "mmHg", min: 30, max: 300 },
  bpm: { unit: "bpm", min: 25, max: 250 }, hours: { unit: "hours", min: 0, max: 24 }, minutes: { unit: "minutes", min: 0, max: 1440 },
  l: { unit: "L", min: 0.3, max: 8 }, "l/min": { unit: "L/min", min: 50, max: 900 }, "mg/l": { unit: "mg/L", min: 0, max: 500 },
  "pg/ml": { unit: "pg/mL", min: 0, max: 35000 }, "%": { unit: "%", min: 0, max: 100 }, "mmol/l": { unit: "mmol/L", min: 1, max: 35 },
};
const RECIST = ["baseline_documented", "CR", "PR", "SD", "PD", "NE"];

function sourceType(text: string): string {
  const t = text.toLowerCase();
  if (/device|sensor|wearable|connected/.test(t)) return "device";
  if (/laborator|\blab\b/.test(t)) return "laboratory";
  if (/site|clinic|imaging/.test(t)) return "site_visit";
  if (/questionnaire|survey|form/.test(t)) return "questionnaire";
  if (/app/.test(t)) return "app_event";
  return "patient_message";
}

function measureType(label: string, response: string): Pick<DraftMeasure, "dataType" | "unit" | "min" | "max" | "choices"> {
  const r = response.trim();
  const range = r.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) return { dataType: "integer", unit: "", min: Number(range[1]), max: Number(range[2]), choices: [] };
  if (/^yes\s*\/\s*no$/i.test(r)) return { dataType: "boolean", unit: "", min: null, max: null, choices: [] };
  if (/^count$/i.test(r)) return { dataType: "integer", unit: "", min: 0, max: null, choices: [] };
  if (/^score$/i.test(r)) return { dataType: "integer", unit: "", min: 0, max: null, choices: [] };
  if (/free text|text/i.test(r) || !r) return { dataType: "text", unit: "", min: null, max: null, choices: [] };
  if (/recist/i.test(r)) return { dataType: "choice", unit: "", min: null, max: null, choices: RECIST };
  const known = UNITS[r.toLowerCase()];
  if (known) {
    let { min, max } = known;
    if (known.unit === "%" && /a1c/i.test(label)) [min, max] = [3, 20];
    if (known.unit === "mmHg" && /systolic/i.test(label)) [min, max] = [50, 300];
    if (known.unit === "mmHg" && /diastolic/i.test(label)) [min, max] = [30, 200];
    return { dataType: "numeric", unit: known.unit, min, max, choices: [] };
  }
  if (/^[A-Z]{1,4}\s*\/\s*[A-Z]{1,4}$/.test(r)) return { dataType: "json", unit: "", min: null, max: null, choices: [] };
  if (/^[\w/%µ.]{1,10}$/.test(r)) return { dataType: "numeric", unit: r, min: null, max: null, choices: [] };
  return { dataType: "text", unit: "", min: null, max: null, choices: [] };
}

function schedule(label: string, dataType: MeasureType, freq: string, source: string):
  Pick<DraftMeasure, "frequency" | "times" | "weekdays" | "studyDays" | "graceMinutes"> {
  const f = freq.toLowerCase();
  const weeks = f.match(/weeks?\s+([\d,\s]+)/);
  if (weeks) {
    const days = weeks[1].split(/[,\s]+/).filter(Boolean).map((w) => Number(w) * 7);
    return { frequency: "custom_days", times: ["10:00"], weekdays: [], studyDays: days, graceMinutes: source === "laboratory" ? 10080 : 4320 };
  }
  if (/twice daily|2 times\/day|bid/.test(f)) return { frequency: "daily", times: ["07:00", "19:00"], weekdays: [], studyDays: [], graceMinutes: 180 };
  const perWeek = f.match(/(\d)\s*times?\s*(?:\/|per|a)\s*week/);
  if (perWeek) {
    const spread: Record<string, number[]> = { "1": [7], "2": [2, 5], "3": [1, 3, 5], "4": [1, 3, 5, 7], "5": [1, 2, 3, 4, 5], "6": [1, 2, 3, 4, 5, 6] };
    return { frequency: "weekly", times: ["20:00"], weekdays: spread[perWeek[1]] ?? [1, 3, 5], studyDays: [], graceMinutes: 180 };
  }
  if (/weekly|once a week|every week/.test(f)) return { frequency: "weekly", times: ["18:00"], weekdays: [7], studyDays: [], graceMinutes: 2880 };
  if (/once|baseline only|single/.test(f)) return { frequency: "once", times: ["10:00"], weekdays: [], studyDays: [], graceMinutes: 4320 };
  if (dataType === "boolean" && /medication|taken|dose|inhaler|injection|used/i.test(label)) {
    return { frequency: "daily", times: ["09:00"], weekdays: [], studyDays: [], graceMinutes: 720 };
  }
  if (source === "device") return { frequency: "daily", times: ["08:00"], weekdays: [], studyDays: [], graceMinutes: 240 };
  return { frequency: "daily", times: ["20:00"], weekdays: [], studyDays: [], graceMinutes: 240 };
}

function promptFor(label: string, response: string): string {
  if (/^\d+\s*-\s*\d+$/.test(response)) return `On a scale from ${response.replace(/\s*-\s*/, " to ")}, what was your ${label.toLowerCase()} today?`;
  if (/yes\s*\/\s*no/i.test(response)) return `${label}?`;
  return `Please report your ${label.toLowerCase()}.`;
}

function arm(name: string, intervention: string): DraftArm {
  const control = /placebo|control|comparator|usual|standard|sham/i.test(name);
  const dose = name.match(/\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|ml|mL|iu|IU|units)\b/)?.[0] ?? "";
  const frequency = name.match(/(?:once|twice|three times|four times)\s+(?:daily|weekly|a day|a week)|\bdaily\b|\bweekly\b/i)?.[0] ?? "";
  const drug = control ? clean(name.replace(frequency, ""))
    : intervention && name.toLowerCase().startsWith(intervention.toLowerCase()) ? intervention : name;
  const code = (control ? name.split(/\s+/).slice(0, 2).join("_") : `${intervention || name.split(/\s+/)[0]}_${dose}`)
    .toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "ARM";
  return { code, name, intervention: clean(drug), dose, frequency, control };
}

function suggestedRules(measures: DraftMeasure[]): DraftRule[] {
  const rules: DraftRule[] = [{
    code: "CONSENT_OVERDUE_7D", name: "Consent invitation unsigned after 7 days", type: "consent_overdue", measureCode: null,
    condition: { days_since_invitation: 7 }, severity: "low", action: "remind", enabled: true,
    why: "Every study has this reminder.",
  }];
  if (measures.some((m) => m.frequency === "daily" && m.sourceType === "patient_message")) {
    rules.push({ code: "MISSED_DAILY_3D", name: "No daily responses for 3 consecutive days", type: "missing_assessments", measureCode: null,
      condition: { consecutive_days: 3, frequency: "daily", source_type: "patient_message" }, severity: "medium", action: "notify_staff", enabled: true,
      why: "The study asks daily questions by message." });
  }
  for (const m of measures) {
    const base = m.label.replace(/\s+(severity|score)$/i, "");
    if (m.dataType === "integer" && m.min === 0 && m.max === 10 && /severity|pain|swelling|symptom/i.test(m.label)) {
      rules.push({ code: `${slug(base).toUpperCase()}_SEVERE`.slice(0, 40), name: `Severe ${base.toLowerCase()} reported`, type: "value_threshold",
        measureCode: m.code, condition: { op: ">=", value: 8 }, severity: "medium", action: "notify_staff", enabled: true,
        why: "Suggested for 0–10 symptom scales. Use the threshold in the protocol's safety plan." });
    } else if (m.dataType === "boolean" && /symptom|reaction|shortness of breath|safety|bleeding/i.test(m.label)) {
      rules.push({ code: `${slug(base).toUpperCase()}_REPORTED`.slice(0, 40), name: `${m.label} reported`, type: "safety_review",
        measureCode: m.code, condition: { op: "is_true" }, severity: /safety|shortness/i.test(m.label) ? "high" : "medium", action: "require_review",
        enabled: true, why: "A yes answer needs a clinician to look at it." });
    } else if (m.dataType === "text" && /symptom/i.test(m.label)) {
      rules.push({ code: `${slug(base).toUpperCase()}_REPORTED`.slice(0, 40), name: `${m.label} reported`, type: "safety_review",
        measureCode: m.code, condition: { op: "text_not_in", values: ["none", "no", "no new symptoms", "nothing new"] }, severity: "medium",
        action: "require_review", enabled: true, why: "Any reported symptom is reviewed by the site." });
    } else if (m.unit === "F" && /temp/i.test(m.label)) {
      rules.push({ code: "FEVER", name: "Temperature at or above 100.4 F", type: "value_threshold", measureCode: m.code,
        condition: { op: ">=", value: 100.4 }, severity: "high", action: "notify_staff", enabled: true, why: "Fever threshold." });
    } else if (m.unit === "mmHg" && /systolic/i.test(m.label)) {
      rules.push({ code: "SYSTOLIC_HIGH", name: "Systolic BP at or above 180 mmHg", type: "value_threshold", measureCode: m.code,
        condition: { op: ">=", value: 180 }, severity: "high", action: "notify_staff", enabled: true, why: "Hypertensive urgency threshold." });
    }
  }
  return rules;
}

const ofKind = (files: Parsed[], kind: DocumentKind) => files.find((f) => f.kind === kind);

export function studyDraft(files: Parsed[], warnings: string[]): StudyDraft | null {
  const protocol = ofKind(files, "protocol")?.extracted as ReturnType<typeof readProtocol> | undefined;
  const icf = ofKind(files, "icf")?.extracted as ReturnType<typeof readIcf> | undefined;
  const soa = ofKind(files, "schedule_of_activities")?.extracted as ReturnType<typeof readSchedule> | undefined;
  const epro = ofKind(files, "epro")?.extracted as ReturnType<typeof readEpro> | undefined;
  if (!protocol && !icf && !soa && !epro) return null;
  const codes = [...new Set([protocol, icf, soa, epro].map((d) => d?.study_id).filter(Boolean))];
  if (codes.length > 1) warnings.push(`These documents name different studies (${codes.join(", ")}). Check that they belong together.`);
  const intervention = protocol?.intervention || icf?.intervention || "";
  const durationWeeks = protocol?.duration_weeks ?? icf?.duration_weeks ?? null;

  // Questionnaire items lead; the protocol's measurement list fills in anything the ePRO lacks.
  const items = epro?.items.length ? epro.items.map((i) => {
    const fromProtocol = (protocol?.measures ?? [])
      .filter((m) => i.prompt.toLowerCase().includes(String(m[0]).toLowerCase()))
      .sort((a, b) => String(b[0]).length - String(a[0]).length)[0];
    return { fieldId: i.field_id, label: String(fromProtocol?.[0] ?? ""), prompt: i.prompt, response: i.response_type, freq: i.frequency, source: i.source };
  }) : (protocol?.measures ?? []).map((m, n) => ({ fieldId: `Q${String(n + 1).padStart(2, "0")}`, label: String(m[0]), prompt: "", response: "", freq: String(m[2]), source: String(m[3]) }));
  const measures: DraftMeasure[] = items.map((i, n) => {
    const label = i.label || clean(i.prompt
      .replace(/^on a scale from \d+ to \d+, what was your /i, "").replace(/ today\?$/i, "")
      .replace(/^please (enter|report) your /i, "").replace(/\s*\([^)]*\)\.?$/, "").replace(/[?.]$/, ""))
      .replace(/^./, (c) => c.toUpperCase());
    const type = measureType(label, i.response);
    const src = sourceType(i.source);
    return {
      fieldId: i.fieldId, code: `${i.fieldId.toLowerCase()}_${slug(label)}`.slice(0, 48) || `q${n + 1}`, label,
      prompt: i.prompt || promptFor(label, i.response), responseType: i.response, frequencyText: i.freq, sourceText: i.source,
      ...type, sourceType: src, ...schedule(label, type.dataType, i.freq, src),
    };
  });
  if (!epro) warnings.push("No questionnaire (ePRO) was uploaded, so measure types come from the protocol and need checking.");
  if (!icf) warnings.push("No consent form (ICF) was uploaded. A study needs one before anyone can be invited.");
  if (!protocol) warnings.push("No protocol was uploaded. A study can't be approved without an approved protocol.");

  return {
    code: String(codes[0] ?? ""), title: protocol?.title || icf?.title || "", protocolId: protocol?.protocol_id || icf?.protocol_id || "",
    protocolVersion: protocol?.protocol_version ?? "", sponsor: protocol?.sponsor ?? "", phase: protocol?.phase ?? "",
    condition: protocol?.condition ?? "", design: protocol?.design ?? "", intervention,
    targetEnrollment: protocol?.target_enrollment ?? null, durationWeeks, primaryOutcome: protocol?.primary ?? "",
    icfVersion: icf?.icf_version ?? "", soaVersion: soa?.soa_version ?? "", eproVersion: epro?.epro_version ?? "",
    arms: (protocol?.arms ?? []).map((a) => arm(a, intervention)),
    inclusion: protocol?.inclusion ?? [], exclusion: protocol?.exclusion ?? [],
    visits: soa?.visits ?? [], activities: (soa?.activities ?? []).map((a) => ({ name: a.name, visits: a.visits })),
    measures, risks: icf?.risks ?? [], rules: suggestedRules(measures),
    managerName: "", managerEmail: "", activate: true,
  };
}

const STATE_TZ: Record<string, string> = Object.fromEntries([
  ...["CT", "DE", "FL", "GA", "IN", "KY", "ME", "MD", "MA", "MI", "NH", "NJ", "NY", "NC", "OH", "PA", "RI", "SC", "VT", "VA", "WV", "DC"].map((s) => [s, "America/New_York"]),
  ...["AL", "AR", "IL", "IA", "KS", "LA", "MN", "MS", "MO", "NE", "ND", "OK", "SD", "TN", "TX", "WI"].map((s) => [s, "America/Chicago"]),
  ...["CO", "ID", "MT", "NM", "UT", "WY"].map((s) => [s, "America/Denver"]), ["AZ", "America/Phoenix"],
  ...["CA", "NV", "OR", "WA"].map((s) => [s, "America/Los_Angeles"]), ["AK", "America/Anchorage"], ["HI", "Pacific/Honolulu"],
]);

export function siteDrafts(files: Parsed[], studyCode: string | null, warnings: string[]): SiteDraft[] {
  const sites = new Map<string, SiteDraft>();
  const get = (code: string) => {
    let s = sites.get(code);
    if (!s) {
      s = { code, institution: "", address: "", city: "", state: "", country: "US", timeZone: "", status: "setup", pi: "",
        coordinator: "", coordinatorEmail: "", coordinatorPhone: "", localIcfVersion: "", infoFile: null, icfFile: null };
      sites.set(code, s);
    }
    return s;
  };
  const fill = (s: SiteDraft, k: keyof SiteDraft, v: string | undefined) => {
    if (v && !s[k]) (s as unknown as Record<string, unknown>)[k] = v;
  };
  const status = (v: string | undefined) => (["setup", "active", "paused", "closed"].includes((v ?? "").toLowerCase()) ? (v ?? "").toLowerCase() : "") as SiteDraft["status"] | "";
  for (const f of files) {
    if (f.kind === "site_roster") {
      for (const r of (f.extracted.sites as Record<string, string>[])) {
        if (!r.site_id || (studyCode && r.study_id && r.study_id !== studyCode)) continue;
        const s = get(r.site_id);
        fill(s, "institution", r.institution || r.institution_name); fill(s, "city", r.city); fill(s, "state", r.state);
        fill(s, "address", r.address || r.street_address); fill(s, "timeZone", r.time_zone);
        fill(s, "pi", r.principal_investigator || r.pi); fill(s, "coordinator", r.coordinator);
        fill(s, "coordinatorEmail", r.coordinator_email); fill(s, "coordinatorPhone", r.coordinator_phone);
        fill(s, "localIcfVersion", r.local_icf_version);
        const st = status(r.site_status);
        if (st) s.status = st;
      }
    }
    if (f.kind === "site_info" || f.kind === "site_icf") {
      const x = (f.kind === "site_info" ? f.extracted : f.extracted.site) as Record<string, string> | undefined;
      if (!x?.["Site ID"]) continue;
      const s = get(x["Site ID"]);
      if (f.kind === "site_info") s.infoFile = f.name; else s.icfFile = f.name;
      fill(s, "institution", x.Institution); fill(s, "address", x["Street address"] ?? x.Address); fill(s, "city", x.City);
      fill(s, "state", x.State); fill(s, "country", x.Country); fill(s, "timeZone", x["Time zone"]);
      fill(s, "pi", x["Principal investigator"]); fill(s, "coordinator", x["Study coordinator"] ?? x.Coordinator);
      fill(s, "coordinatorEmail", x["Coordinator email"]); fill(s, "coordinatorPhone", x["Coordinator phone"]);
      const version = f.kind === "site_icf" ? f.version ?? undefined : x["Local ICF version"];
      if (version && s.localIcfVersion && version !== s.localIcfVersion) {
        warnings.push(`${s.code}: the files disagree on the local consent version (${s.localIcfVersion} and ${version}).`);
      }
      fill(s, "localIcfVersion", version);
      const st = status(x["Site status"]);
      if (st) s.status = st;
    }
  }
  for (const s of sites.values()) {
    if (!s.timeZone) s.timeZone = STATE_TZ[s.state.toUpperCase()] ?? "America/New_York";
    if (s.localIcfVersion && !s.icfFile) warnings.push(`${s.code} lists local consent version ${s.localIcfVersion}, but its consent form wasn't uploaded. Until it is, the study's master consent form applies at this site.`);
  }
  return [...sites.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// --- Writing to the database --------------------------------------------------------------

function storeFile(dir: string, f: Parsed): string {
  const ext = f.name.match(/\.(pdf|csv)$/i)?.[0].toLowerCase() ?? "";
  const file = `${f.sha256}${ext}`;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, file))) writeFileSync(join(dir, file), f.buffer, { mode: 0o640 });
  return `ops-home://uploads/${file}`;
}

async function staffUser(db: Client, name: string, email: string | null): Promise<{ id: string; created: boolean }> {
  const found = await db.query<{ id: string }>(
    "SELECT id FROM private.staff_users WHERE lower(display_name) = lower($1) AND is_active ORDER BY created_at LIMIT 1", [name]);
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const subject = `ops-home|${slug(name).replace(/_/g, ".")}|${randomUUID().slice(0, 8)}`;
  const r = await db.query<{ id: string }>(
    "INSERT INTO private.staff_users(auth_subject, display_name, email) VALUES ($1,$2,$3) RETURNING id", [subject, name, email || null]);
  return { id: r.rows[0].id, created: true };
}

const need = (ok: unknown, message: string) => {
  if (!ok) throw new SetupError(422, message);
};

function checkStudy(d: StudyDraft, files: Parsed[]) {
  need(CODE_RE.test(d.code), "Give the study a code: letters, numbers and dashes, like STUDY-006.");
  need(d.title.trim(), "The study needs a title.");
  need(d.managerName.trim(), "Name the trial manager who reviewed these documents.");
  need(ofKind(files, "protocol"), "Upload the protocol. A study can't be approved without it.");
  need(ofKind(files, "icf"), "Upload the consent form (ICF).");
  need(d.icfVersion.trim(), "The consent form needs a version.");
  need(d.targetEnrollment === null || (Number.isInteger(d.targetEnrollment) && d.targetEnrollment > 0), "Target enrollment must be a whole number above zero.");
  need(d.durationWeeks === null || (Number.isInteger(d.durationWeeks) && d.durationWeeks > 0), "Duration must be a whole number of weeks.");
  const codes = new Set<string>();
  for (const m of d.measures) {
    need(/^[a-z0-9_]{1,60}$/.test(m.code), `Measure code "${m.code}" can only use lower-case letters, numbers and underscores.`);
    need(!codes.has(m.code), `Two measures share the code ${m.code}.`);
    codes.add(m.code);
    need(m.label.trim(), "Every measure needs a name.");
    need(m.times.length && m.times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)), `${m.label}: times must look like 09:00.`);
    need(m.frequency !== "weekly" || m.weekdays.length, `${m.label}: pick the days of the week.`);
    need(m.frequency !== "custom_days" || m.studyDays.length, `${m.label}: list the study days.`);
    need(m.min === null || m.max === null || m.min <= m.max, `${m.label}: the lowest value is above the highest.`);
    need(m.dataType !== "choice" || m.choices.length, `${m.label}: list the choices.`);
  }
  for (const r of d.rules) need(!r.measureCode || codes.has(r.measureCode), `Rule ${r.name} refers to a measure that isn't in the study.`);
}

function versionOf(f: Parsed | undefined, fallback: string) {
  return (f?.version || fallback || "1.0").slice(0, 40);
}

async function createStudy(db: Client, d: StudyDraft, files: Parsed[], actor: string, store: (f: Parsed) => string): Promise<string[]> {
  checkStudy(d, files);
  const done: string[] = [];
  const exists = await db.query("SELECT 1 FROM public.studies WHERE lower(study_code) = lower($1)", [d.code]);
  need(!exists.rowCount, `${d.code} already exists. Use a new study code, or add sites to it instead.`);
  const synthetic = files.some((f) => f.synthetic);

  const manager = await staffUser(db, d.managerName.trim(), d.managerEmail.trim() || null);
  done.push(manager.created ? `Staff record for ${d.managerName}` : `Uses the existing staff record for ${d.managerName}`);
  const study = await db.query<{ id: string }>(
    `INSERT INTO public.studies(study_code, title, condition, phase, study_type, design, intervention, sponsor, protocol_id,
       protocol_version, target_enrollment, duration_weeks, primary_outcome, status, is_synthetic)
     VALUES ($1,$2,$3,$4,'interventional',$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13) RETURNING id`,
    [d.code, clean(d.title), d.condition || null, d.phase || null, d.design || null, d.intervention || null, d.sponsor || null,
      d.protocolId || null, d.protocolVersion || null, d.targetEnrollment, d.durationWeeks, d.primaryOutcome || null, synthetic]);
  const studyId = study.rows[0].id;
  await db.query(
    "INSERT INTO public.study_staff(study_id, site_id, staff_user_id, role, receives_alerts) VALUES ($1,NULL,$2,'trial_manager',TRUE)",
    [studyId, manager.id]);
  done.push(`Study ${d.code}: ${clean(d.title)}`, `${d.managerName} as trial manager`);

  // Source documents and what was read from each, approved by the trial manager who reviewed the draft.
  const docIds = new Map<DocumentKind, string>();
  const note = `Reviewed and approved in the ops-home setup form (signed in as ${actor}).`;
  for (const kind of ["protocol", "icf", "schedule_of_activities", "epro"] as const) {
    const f = ofKind(files, kind);
    if (!f) continue;
    const version = kind === "protocol" ? d.protocolVersion : kind === "icf" ? d.icfVersion : kind === "epro" ? d.eproVersion : d.soaVersion;
    const doc = await db.query<{ id: string }>(
      `INSERT INTO public.study_documents(study_id, site_id, document_type, version, file_name, storage_uri, sha256, is_current,
         review_status, uploaded_by, reviewed_by, reviewed_at)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,TRUE,'approved',$7,$7,now()) RETURNING id`,
      [studyId, kind, versionOf(f, version), f.name, store(f), f.sha256, manager.id]);
    docIds.set(kind, doc.rows[0].id);
    await db.query(
      `INSERT INTO public.document_extractions(study_id, source_document_id, extractor, proposed_data, status, reviewed_by, reviewed_at, review_notes)
       VALUES ($1,$2,$3,$4,'approved',$5,now(),$6)`,
      [studyId, doc.rows[0].id, PARSER, JSON.stringify(f.extracted), manager.id, note]);
    done.push(`${KIND_LABEL[kind]} v${versionOf(f, version)} (${f.name}), stored and approved`);
  }
  await db.query(`UPDATE public.studies SET status=$2, approved_by=$3, approved_at=now() WHERE id=$1`,
    [studyId, d.activate ? "active" : "approved", manager.id]);
  done.push(d.activate ? "Study approved and active" : "Study approved, not yet active");

  for (const [i, a] of d.arms.entries()) {
    await db.query(
      `INSERT INTO public.study_arms(study_id, arm_code, name, description, intervention_name, dose, frequency, is_control)
       VALUES ($1,$2,$3,'Protocol: Study Arms.',$4,$5,$6,$7)`,
      [studyId, a.code || `ARM_${i + 1}`, a.name, a.intervention || null, a.dose || null, a.frequency || null, a.control]);
  }
  if (d.arms.length) done.push(`${d.arms.length} study arm${d.arms.length === 1 ? "" : "s"}`);

  const rules = [...d.inclusion.map((t) => ["inclusion", t] as const), ...d.exclusion.map((t) => ["exclusion", t] as const)];
  for (const [i, [type, text]] of rules.entries()) {
    const between = text.match(/^Age (\d+)\s*[-–]\s*(\d+) years$/i);
    const atLeast = text.match(/^Age (\d+) years or older$/i);
    const check = between ? ["age_years", "between", JSON.stringify([Number(between[1]), Number(between[2])])]
      : atLeast ? ["age_years", ">=", atLeast[1]] : [null, null, null];
    await db.query(
      `INSERT INTO public.eligibility_rules(study_id, source_document_id, rule_type, description, field_name, operator, rule_value, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [studyId, docIds.get("protocol") ?? null, type, text, ...check, type === "inclusion" ? i + 1 : 100 + i]);
  }
  if (rules.length) done.push(`${d.inclusion.length} inclusion and ${d.exclusion.length} exclusion criteria`);

  await db.query(
    `INSERT INTO public.consent_documents(study_id, site_id, source_document_id, document_name, version, effective_date, is_active)
     VALUES ($1,NULL,$2,$3,$4,CURRENT_DATE,TRUE)`,
    [studyId, docIds.get("icf"), `Informed Consent Form - ${d.code}`, versionOf(ofKind(files, "icf"), d.icfVersion)]);
  done.push(`Master consent form v${d.icfVersion}, in effect from today`);

  const measureIds = new Map<string, string>();
  for (const m of d.measures) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.measure_definitions(study_id, source_document_id, measure_code, label, prompt, data_type, unit,
         min_value, max_value, choices, source_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [studyId, docIds.get("epro") ?? docIds.get("protocol") ?? null, m.code, m.label, m.prompt || null, m.dataType, m.unit || null,
        m.min, m.max, m.dataType === "choice" ? JSON.stringify(m.choices) : null, m.sourceType || null]);
    measureIds.set(m.code, r.rows[0].id);
    await db.query(
      `INSERT INTO public.assessment_schedules(study_id, measure_id, schedule_code, frequency, anchor_event, start_day, end_day,
         times_of_day, weekdays, study_days, grace_period_minutes, is_active)
       VALUES ($1,$2,$3,$4,'activation',0,$5,$6::time[],$7::smallint[],$8::integer[],$9,TRUE)`,
      [studyId, r.rows[0].id, m.code, m.frequency, d.durationWeeks ? d.durationWeeks * 7 : null, m.times,
        m.frequency === "weekly" ? m.weekdays : null, m.frequency === "custom_days" ? m.studyDays : null, m.graceMinutes]);
  }
  if (d.measures.length) done.push(`${d.measures.length} measures, each with its collection schedule`);

  const enabled = d.rules.filter((r) => r.enabled);
  for (const r of enabled) {
    const condition = { ...r.condition, basis: "Set up from the study documents in ops-home. Confirm thresholds against the protocol's safety plan." };
    await db.query(
      `INSERT INTO public.alert_rules(study_id, measure_id, source_document_id, rule_code, name, rule_type, condition, severity,
         action_type, enabled, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,now())`,
      [studyId, r.measureCode ? measureIds.get(r.measureCode) : null, docIds.get("protocol") ?? null, r.code, r.name, r.type,
        JSON.stringify(condition), r.severity, r.type === "safety_review" ? "require_review" : r.action, manager.id]);
  }
  if (enabled.length) done.push(`${enabled.length} alert rule${enabled.length === 1 ? "" : "s"}, approved by ${d.managerName}`);
  return done;
}

async function nextVersion(db: Client, studyId: string, siteId: string | null, kind: string): Promise<string> {
  const r = await db.query<{ n: number }>(
    "SELECT count(*)::int n FROM public.study_documents WHERE study_id=$1 AND site_id IS NOT DISTINCT FROM $2 AND document_type=$3",
    [studyId, siteId, kind]);
  return `${r.rows[0].n + 1}.0`;
}

async function createSites(db: Client, studyCode: string, sites: SiteDraft[], files: Parsed[], actor: string, store: (f: Parsed) => string): Promise<string[]> {
  need(sites.length, "Add at least one site.");
  const study = await db.query<{ id: string; status: string }>("SELECT id, status FROM public.studies WHERE study_code=$1", [studyCode]);
  need(study.rows[0], `There's no study ${studyCode}. Set up the study first.`);
  const studyId = study.rows[0].id;
  const manager = await db.query<{ staff_user_id: string; display_name: string }>(
    `SELECT s.staff_user_id, u.display_name FROM public.study_staff s JOIN private.staff_users u ON u.id=s.staff_user_id
     WHERE s.study_id=$1 AND s.site_id IS NULL AND s.role='trial_manager' AND s.is_active AND u.is_active ORDER BY s.created_at LIMIT 1`, [studyId]);
  const done: string[] = [];
  const seen = new Set<string>();
  for (const s of sites) {
    need(CODE_RE.test(s.code), `"${s.code}" isn't a usable site code. Use letters, numbers and dashes, like SITE-006-A.`);
    need(!seen.has(s.code.toLowerCase()), `${s.code} is listed twice.`);
    seen.add(s.code.toLowerCase());
    need(s.institution.trim(), `${s.code} needs an institution.`);
    need(s.pi.trim(), `${s.code} needs a principal investigator.`);
    need(s.coordinator.trim(), `${s.code} needs a study coordinator.`);
    const taken = await db.query<{ study_code: string }>(
      "SELECT st.study_code FROM public.sites x JOIN public.studies st ON st.id=x.study_id WHERE lower(x.site_code)=lower($1)", [s.code]);
    need(!taken.rowCount, `${s.code} is already a site in ${taken.rows[0]?.study_code}. Site codes have to be unique.`);
  }

  const roster = ofKind(files, "site_roster");
  if (roster) {
    const version = await nextVersion(db, studyId, null, "site_roster");
    await db.query(
      `UPDATE public.study_documents SET is_current=FALSE, review_status='superseded'
       WHERE study_id=$1 AND site_id IS NULL AND document_type='site_roster' AND is_current`, [studyId]);
    const reviewer = manager.rows[0]?.staff_user_id ?? null;
    need(reviewer, `${studyCode} has no trial manager to approve the roster.`);
    await db.query(
      `INSERT INTO public.study_documents(study_id, site_id, document_type, version, file_name, storage_uri, sha256, is_current,
         review_status, uploaded_by, reviewed_by, reviewed_at)
       VALUES ($1,NULL,'site_roster',$2,$3,$4,$5,TRUE,'approved',$6,$6,now())`,
      [studyId, version, roster.name, store(roster), roster.sha256, reviewer]);
    done.push(`Site roster v${version} (${roster.name}), stored and approved`);
  }

  for (const s of sites) {
    const site = await db.query<{ id: string }>(
      `INSERT INTO public.sites(study_id, site_code, institution_name, city, state, country, time_zone, status, principal_investigator)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [studyId, s.code, clean(s.institution), s.city || null, s.state || null, s.country || "US", s.timeZone || "UTC", s.status, clean(s.pi)]);
    const siteId = site.rows[0].id;
    const pi = await staffUser(db, clean(s.pi), null);
    const coord = await staffUser(db, clean(s.coordinator), s.coordinatorEmail || null);
    for (const [user, role] of [[pi.id, "principal_investigator"], [coord.id, "coordinator"]] as const) {
      await db.query(
        `INSERT INTO public.study_staff(study_id, site_id, staff_user_id, role, receives_alerts) VALUES ($1,$2,$3,$4,TRUE)`,
        [studyId, siteId, user, role]);
    }
    done.push(`Site ${s.code}: ${clean(s.institution)}${s.city ? `, ${s.city}${s.state ? `, ${s.state}` : ""}` : ""} (${s.status})`,
      `${clean(s.pi)} as principal investigator and ${clean(s.coordinator)} as coordinator at ${s.code}`);
    const reviewer = manager.rows[0]?.staff_user_id ?? pi.id;

    const info = files.find((f) => f.name === s.infoFile && f.kind === "site_info");
    if (info) {
      await db.query(
        `INSERT INTO public.study_documents(study_id, site_id, document_type, version, file_name, storage_uri, sha256, is_current,
           review_status, uploaded_by, reviewed_by, reviewed_at)
         VALUES ($1,$2,'other',$3,$4,$5,$6,TRUE,'approved',$7,$7,now())`,
        [studyId, siteId, await nextVersion(db, studyId, siteId, "other"), info.name, store(info), info.sha256, reviewer]);
      done.push(`Site information sheet for ${s.code}, stored`);
    }
    const icf = files.find((f) => f.name === s.icfFile && f.kind === "site_icf");
    if (icf) {
      const version = (s.localIcfVersion || icf.version || "").slice(0, 40);
      need(version, `${s.code}: the site consent form needs a version.`);
      const doc = await db.query<{ id: string }>(
        `INSERT INTO public.study_documents(study_id, site_id, document_type, version, file_name, storage_uri, sha256, is_current,
           review_status, uploaded_by, reviewed_by, reviewed_at)
         VALUES ($1,$2,'icf',$3,$4,$5,$6,TRUE,'approved',$7,$7,now()) RETURNING id`,
        [studyId, siteId, version, icf.name, store(icf), icf.sha256, reviewer]);
      await db.query(
        `INSERT INTO public.document_extractions(study_id, source_document_id, extractor, proposed_data, status, reviewed_by, reviewed_at, review_notes)
         VALUES ($1,$2,$3,$4,'approved',$5,now(),$6)`,
        [studyId, doc.rows[0].id, PARSER, JSON.stringify(icf.extracted), reviewer, `Reviewed and approved in the ops-home setup form (signed in as ${actor}).`]);
      await db.query(
        `INSERT INTO public.consent_documents(study_id, site_id, source_document_id, document_name, version, effective_date, is_active)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,TRUE)`,
        [studyId, siteId, doc.rows[0].id, `Informed Consent Form - ${clean(s.institution)}`, version]);
      done.push(`Site consent form v${version} for ${s.code}, in effect from today`);
    }
  }
  if (study.rows[0].status !== "active") done.push(`${studyCode} isn't active yet, so these sites won't send messages until it is.`);
  return done;
}

// --- HTTP ------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new SetupError(413, "Those files are too large together. The limit is 9 MB per upload.");
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new SetupError(400, "The request wasn't valid JSON.");
  }
}

function uploads(body: Record<string, unknown>): Parsed[] {
  const list = Array.isArray(body.files) ? body.files : [];
  if (list.length > MAX_FILES) throw new SetupError(400, `Upload at most ${MAX_FILES} files at once.`);
  return list.map((f) => {
    const file = f as Partial<UploadFile>;
    if (typeof file?.name !== "string" || typeof file.data !== "string") throw new SetupError(400, "Each file needs a name and its contents.");
    return parseUpload({ name: file.name, data: file.data });
  });
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Writes need a signed-in trial manager (the same Trial Ops session Agentic mode uses). */
export function setupApi(env: Env, pool: pg.Pool | null, distDir: string, onChange: () => void) {
  const base = (env.TRIAL_OPS_API_URL ?? "http://patient-assistant:3012").replace(/\/+$/, "");
  const uploadDir = env.UPLOAD_DIR ?? join(process.cwd(), "uploads");
  const sessions = new Map<string, { at: number; name: string | null }>();

  async function actor(req: IncomingMessage): Promise<string | null> {
    if (env.SETUP_WITHOUT_SIGN_IN === "1") return env.SETUP_ACTOR ?? "Local developer";
    const session = cookie(req, "ops_session");
    if (!session || !env.TRIAL_OPS_API_TOKEN) return null;
    const hit = sessions.get(session);
    if (hit && Date.now() - hit.at < 60_000) return hit.name;
    let name: string | null = null;
    try {
      const r = await fetch(`${base}/v1/me`, {
        headers: { Authorization: `Bearer ${env.TRIAL_OPS_API_TOKEN}`, "X-Ops-Session": session, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) name = ((await r.json()) as { manager?: { name?: string } }).manager?.name ?? null;
    } catch (err) {
      console.error("setup: sign-in check failed:", err instanceof Error ? err.message : err);
    }
    if (sessions.size > 500) sessions.clear();
    sessions.set(session, { at: Date.now(), name });
    return name;
  }

  function samples(): SetupContext["samples"] {
    const dir = join(distDir, "samples");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => /^STUDY-\d+$/.test(d)).sort().map((study) => {
      const files = readdirSync(join(dir, study)).filter((f) => /\.pdf$/i.test(f)).map((f) => `/samples/${study}/${f}`);
      const siteDir = join(dir, study, "sites");
      const siteFiles = existsSync(siteDir) ? readdirSync(siteDir).filter((f) => /\.(pdf|csv)$/i.test(f)).sort().map((f) => `/samples/${study}/sites/${f}`) : [];
      return { study, title: "", files, siteFiles };
    });
  }

  async function transaction<T>(fn: (db: Client) => Promise<T>, dryRun: boolean): Promise<T> {
    if (!pool) throw new SetupError(503, "No database is configured.");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout = '20s'");
      await db.query("SELECT set_config('app.request_id', $1, true)", [`ops-home-setup:${randomUUID()}`]);
      const out = await fn(db);
      await db.query(dryRun ? "ROLLBACK" : "COMMIT");
      return out;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
    if (!urlPath.startsWith("/api/setup/")) return false;
    const route = urlPath.slice("/api/setup/".length);
    try {
      if (req.method === "GET" && route === "context") {
        const who = await actor(req);
        if (!pool) throw new SetupError(503, "No database is configured.");
        const studies = await pool.query<SetupContext["studies"][number]>(
          `SELECT st.study_code code, st.title, st.status,
             coalesce((SELECT array_agg(x.site_code ORDER BY x.site_code) FROM public.sites x WHERE x.study_id=st.id), '{}') sites,
             coalesce((SELECT c.version FROM public.consent_documents c WHERE c.study_id=st.id AND c.site_id IS NULL AND c.is_active LIMIT 1),
               (SELECT d.version FROM public.study_documents d WHERE d.study_id=st.id AND d.site_id IS NULL AND d.document_type='icf' AND d.is_current LIMIT 1)) "icfVersion",
             (SELECT u.display_name FROM public.study_staff s JOIN private.staff_users u ON u.id=s.staff_user_id
               WHERE s.study_id=st.id AND s.site_id IS NULL AND s.role='trial_manager' AND s.is_active ORDER BY s.created_at LIMIT 1) manager
           FROM public.studies st ORDER BY st.study_code`);
        const staff = await pool.query<{ display_name: string }>(
          "SELECT DISTINCT display_name FROM private.staff_users WHERE is_active ORDER BY display_name");
        const body: SetupContext = { signedIn: Boolean(who), actor: who, studies: studies.rows, staff: staff.rows.map((r) => r.display_name), samples: samples() };
        send(res, 200, body);
        return true;
      }
      if (req.method !== "POST") throw new SetupError(404, "Not found.");
      const origin = req.headers.origin;
      if (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) {
        throw new SetupError(403, "Cross-site request refused.");
      }
      const who = await actor(req);
      if (!who) throw new SetupError(401, "Sign in to set up studies and sites.");
      const body = await readJson(req);
      const files = uploads(body);
      const store = (f: Parsed) => storeFile(uploadDir, f);
      const dryRun = body.dryRun !== false;

      if (route === "parse") {
        const warnings: string[] = [];
        const study = studyDraft(files, warnings);
        const studyCode = typeof body.studyCode === "string" && body.studyCode ? body.studyCode
          : study?.code || files.find((f) => f.studyCode)?.studyCode || null;
        const sites = siteDrafts(files, studyCode, warnings);
        if (study) study.managerName = who === "Local developer" ? "" : who;
        const result: ParseResult = { files: files.map(({ buffer: _b, ...f }) => f), study, studyCode, sites, warnings };
        send(res, 200, result);
        return true;
      }
      if (route === "study") {
        const draft = body.draft as StudyDraft;
        if (!draft || typeof draft !== "object") throw new SetupError(400, "Send the reviewed draft.");
        // Sites can come along in the same transaction, so a study and its sites succeed or fail together.
        const sites = Array.isArray(body.sites) ? (body.sites as SiteDraft[]) : [];
        const created = await transaction(async (db) => {
          const keep = dryRun ? () => "ops-home://uploads/(not stored in a check)" : store;
          const done = await createStudy(db, draft, files, who, keep);
          if (sites.length) done.push(...await createSites(db, draft.code, sites, files, who, keep));
          await loadStudy(db, draft.code, env.DISPLAY_TZ ?? "America/New_York"); // the study page must build
          for (const s of sites) await loadSite(db, s.code, env.DISPLAY_TZ ?? "America/New_York");
          return done;
        }, dryRun);
        if (!dryRun) onChange();
        const out: SetupOutcome = { ok: true, dryRun, code: draft.code, href: `/studies/${encodeURIComponent(draft.code)}`, created, warnings: [] };
        send(res, 200, out);
        return true;
      }
      if (route === "sites") {
        const studyCode = String(body.studyCode ?? "");
        const sites = Array.isArray(body.sites) ? (body.sites as SiteDraft[]) : [];
        const created = await transaction(async (db) => {
          const done = await createSites(db, studyCode, sites, files, who, dryRun ? () => "ops-home://uploads/(not stored in a check)" : store);
          for (const s of sites) await loadSite(db, s.code, env.DISPLAY_TZ ?? "America/New_York");
          return done;
        }, dryRun);
        if (!dryRun) onChange();
        const out: SetupOutcome = { ok: true, dryRun, code: studyCode, href: `/studies/${encodeURIComponent(studyCode)}`, created, warnings: [] };
        send(res, 200, out);
        return true;
      }
      throw new SetupError(404, "Not found.");
    } catch (err) {
      if (err instanceof SetupError) send(res, err.status, { error: err.message });
      else if (err && typeof err === "object" && "code" in err && /^(23|22)/.test(String((err as { code: unknown }).code))) {
        // Database rules (triggers and constraints) explain themselves; pass the reason on.
        const e = err as unknown as { message: string; detail?: string };
        send(res, 422, { error: `The database refused this: ${e.message}${e.detail ? ` (${e.detail})` : ""}` });
      } else {
        console.error("setup error:", err instanceof Error ? err.message : err);
        send(res, 500, { error: "Something went wrong while setting this up. Nothing was saved." });
      }
    }
    return true;
  };
}
