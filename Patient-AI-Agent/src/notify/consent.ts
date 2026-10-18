// The site's principal investigator hears by email when someone signs the informed consent: the
// participant's code, study and site, the ICF version and time, how their identity was checked,
// and what happens next. Codes only, no name or contact details. PI_EMAIL sends it to one address
// instead of the investigator's on file. A failure is logged and never touches the signature.
import { config } from "../config.ts";
import { asPerson } from "../db.ts";
import * as store from "../store.ts";
import { emailEnabled, sendEmail, simpleHtml } from "./email.ts";

interface Notice {
  participant_code: string;
  study_code: string;
  study_title: string;
  intervention: string | null;
  site_name: string;
  investigator: string | null;
  investigator_email: string | null;
  consent_id: string;
  consent_version: string;
  signed_at: Date;
  method: string | null;
  prescreen: string | null;
}

const METHOD: Record<string, string> = { passkey: "Face ID (passkey)", typed_name: "Typed full name" };
const PRESCREEN: Record<string, string> = { likely_eligible: "Likely eligible", needs_review: "Needs review", not_eligible: "Not eligible", unknown: "Not done" };

/** Emails the site investigator about a signed consent. Returns Resend's id, or undefined when it didn't send. */
export async function emailInvestigator(personId: string, engagementId: string, timeZone: string): Promise<string | undefined> {
  if (!emailEnabled()) return undefined;
  const [n] = await asPerson(personId, (q) => q<Notice>("select * from assistant.consent_notice($1)", [engagementId]));
  if (!n) return undefined;
  const onFile = n.investigator_email && !/@example\.(org|com|net)$/i.test(n.investigator_email) ? n.investigator_email : undefined;
  const to = config.email.piOverride ?? onFile;
  if (!to) {
    console.warn(`email: no investigator address for ${n.study_code} at ${n.site_name}; set PI_EMAIL`);
    return undefined;
  }
  const short = n.intervention ?? n.study_code;
  const when = new Date(n.signed_at).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const rows: [string, string][] = [
    ["Participant", n.participant_code],
    ["Study", `${short} (${n.study_code})`],
    ["Site", n.site_name],
    ["Consent", `ICF ${n.consent_version}, signed ${when}`],
    ["Identity check", METHOD[n.method ?? ""] ?? n.method ?? "Recorded"],
    ["Sage's prescreen", PRESCREEN[n.prescreen ?? ""] ?? n.prescreen ?? "Not recorded"],
  ];
  const greeting = n.investigator ? `${n.investigator},` : "Hello,";
  const intro = `${n.participant_code} signed the informed consent for ${short} at ${n.site_name} through Sage, the study's iMessage assistant.`;
  const outro = "Next, Sage helps them book a screening visit. After it, confirm their enrollment in Trial Ops (https://ops.hackharvard2026.velroi.com). This is synthetic demo data; the email names no one and carries no contact details.";
  const id = await sendEmail({
    to: [to],
    subject: `Consent signed: ${n.participant_code}, ${short} (ICF ${n.consent_version})`,
    text: `${greeting}\n\n${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${outro}\n`,
    html: simpleHtml("Consent signed.", `${greeting} ${intro}`, rows, outro),
    idempotencyKey: `consent-signed:${n.consent_id}`,
  });
  await asPerson(personId, (q) => store.audit(q, personId, engagementId, "assistant", "investigator_emailed", {
    consent_id: n.consent_id, resend_id: id, to_override: Boolean(config.email.piOverride),
  }));
  console.log(`email: told the ${n.study_code} investigator that ${n.participant_code} signed (${id})`);
  return id;
}
