// The e-consent walkthrough when an approved ICF has no loaded presentation (assistant.
// consent_presentations): a plain-language summary built from the study record, with the
// standard rights every ICF covers and teach-back questions. It says plainly that the approved
// form is the official document. Pure, so the same study always yields the same fingerprint.
import { createHash } from "node:crypto";
import type { ComprehensionQuestion, ConsentSection, TrialSummary } from "./types.ts";

export interface Presentation {
  summary: string;
  sections: ConsentSection[];
  comprehension: ComprehensionQuestion[];
}

const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function presentationHash(p: Presentation): string {
  return createHash("sha256").update(`${p.summary}\n${JSON.stringify(p.sections)}\n${JSON.stringify(p.comprehension)}`).digest("hex");
}

export function generatedPresentation(trial: TrialSummary, doc: { name: string; version: string }): Presentation {
  const control = trial.arms.find((a) => a.isControl);
  const randomized = trial.arms.length > 1;
  const site = trial.sites[0];
  const sections: ConsentSection[] = [
    {
      id: "about", key_point: false, heading: "What this is",
      body: `You're invited to take part in a research study: ${trial.title}. This is a plain-language walkthrough of the approved consent form "${doc.name}" (version ${doc.version}), which is the official document. You can ask for a copy of the full form at any time.`,
    },
    {
      id: "purpose", key_point: false, heading: "Why the study is being done",
      body: [trial.condition && `The study is about ${trial.condition.toLowerCase()}.`, trial.intervention && `It is testing ${trial.intervention}.`,
        trial.primaryEndpoint && `The main question: ${trial.primaryEndpoint.charAt(0).toLowerCase()}${trial.primaryEndpoint.slice(1)}.`, trial.phase && `It is a ${trial.phase} study.`]
        .filter(Boolean).join(" ") || trial.summary,
    },
    {
      id: "what_happens", key_point: false, heading: "What you would do",
      body: [trial.durationWeeks && `You would take part for about ${trial.durationWeeks} weeks.`, trial.timeCommitment,
        trial.assessments.length ? `You'd report ${list(trial.assessments.map((a) => a.label.toLowerCase()))} through quick check-ins by text.` : null,
        "There is a screening visit first, where the study team confirms the study is right for you."].filter(Boolean).join(" "),
    },
    ...(randomized ? [{
      id: "groups", key_point: true, heading: "Study groups",
      body: `People in the study are put into groups by chance, like flipping a coin: ${list(trial.arms.map((a) => a.description ?? a.name))}.${control ? ` Some people will get ${control.name.toLowerCase()} instead of the study medicine.` : ""} You won't choose your group.`,
    }] : []),
    {
      id: "risks", key_point: false, heading: "Risks and discomforts",
      body: "Every study has possible risks, including side effects that aren't known yet. The study doctor will go through the known risks with you before you start, and you can ask about them at any time. Tell the study team about any new or worse symptoms.",
    },
    {
      id: "benefits", key_point: false, heading: "Possible benefits",
      body: "You may or may not benefit from taking part. What the study learns may help other people in the future.",
    },
    ...(trial.compensation ? [{ id: "compensation", key_point: false, heading: "Payment", body: trial.compensation }] : []),
    {
      id: "voluntary", key_point: true, heading: "Your choice",
      body: "Taking part is completely voluntary. You can say no, or stop at any time for any reason, without any penalty or loss of the care you would normally get.",
    },
    {
      id: "privacy", key_point: false, heading: "Your privacy",
      body: "Your study records are labeled with a code instead of your name. Your contact details are kept separately and only the study team can see them.",
    },
    {
      id: "contact", key_point: true, heading: "Questions and emergencies",
      body: `${site ? `Your study team is at ${site.name}${site.principalInvestigator ? `, led by ${site.principalInvestigator}` : ""}. ` : ""}${trial.contactPhone ? `Call ${trial.contactPhone} with questions. ` : "Text us with any questions. "}In a medical emergency, call 911 or go to the nearest emergency room first.`,
    },
  ];

  const comprehension: ComprehensionQuestion[] = [
    { id: "voluntary", question: "Once you sign, do you have to finish the study?", options: ["Yes, I have to finish once I sign", "No, I can stop at any time, for any reason"], answer: 1 },
    ...(randomized && control
      ? [{ id: "groups", question: "Will everyone in the study get the study medicine?", options: ["Yes, everyone gets it", `No, some people get ${control.name.toLowerCase()}`], answer: 1 }]
      : []),
    { id: "emergency", question: "What should you do in a medical emergency?", options: ["Wait and mention it at the next check-in", "Call 911 or go to the emergency room"], answer: 1 },
  ];

  return { summary: trial.summary, sections, comprehension };
}
