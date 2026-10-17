// What the assistant needs to know about a study. ConsentFirstKnowledge reads it from the
// consent-first platform (public.studies and friends) plus the assistant's optional presentation
// tables; nothing else in the agent reads study tables, so another source only needs to implement
// TrialKnowledge.
import type { Question } from "../domain/eligibility.ts";
import type { SiteHours } from "../domain/scheduling.ts";

export interface Site {
  id: string;
  code: string;
  name: string;
  city: string | null;
  region: string | null;
  principalInvestigator: string | null;
  timeZone: string;
  status: string;
}

export interface Arm {
  code: string;
  name: string;
  description: string | null;
  isControl: boolean;
}

export interface TrialSummary {
  id: string;
  code: string;
  title: string;
  shortTitle: string;
  phase: string | null;
  status: string;
  condition: string | null;
  intervention: string | null;
  sponsor: string | null;
  design: string | null;
  /** Plain-language summary for patients (study profile), falling back to the title. */
  summary: string;
  primaryEndpoint: string | null;
  durationWeeks: number | null;
  timeCommitment: string | null;
  compensation: string | null;
  contactPhone: string | null;
  /** Time zone for the study as a whole (its first active site's). */
  timezone: string;
  isSynthetic: boolean;
  sites: Site[];
  arms: Arm[];
  /** What participants report and how often, e.g. "Worst pain today: daily". */
  assessments: { label: string; frequency: string }[];
}

export interface ConsentSection {
  id: string;
  heading: string;
  body: string;
  key_point: boolean;
}

export interface ComprehensionQuestion {
  id: string;
  question: string;
  options: string[];
  answer: number;
}

export interface ConsentDocument {
  /** public.consent_documents id. */
  id: string;
  version: string;
  title: string;
  summary: string;
  sections: ConsentSection[];
  comprehension: ComprehensionQuestion[];
  /** Fingerprint of exactly what the person read, recorded with the signature. */
  contentHash: string;
  /** sha256 of the approved ICF file the presentation stands for. */
  sourceSha256: string | null;
  /** True when built from the study record because no presentation was loaded for this ICF. */
  generated: boolean;
  /** The platform will accept a signature: the ICF is approved, active and in effect. */
  signable: boolean;
}

export interface CheckInMeasure {
  measureId: string;
  code: string;
  label: string;
  valueType: "number" | "integer" | "scale" | "boolean" | "choice" | "text";
  unit: string | null;
  min: number | null;
  max: number | null;
  choices: string[] | null;
  required: boolean;
  prompt: string;
}

/** A study someone could join now. */
export interface StudyListing {
  id: string;
  code: string;
  shortTitle: string;
  title: string;
  condition: string | null;
}

export interface TrialKnowledge {
  /** A study by code, or with no code the study now recruiting (the most recently updated active one). */
  trialByCode(code?: string): Promise<TrialSummary | undefined>;
  trial(id: string): Promise<TrialSummary>;
  /** Active studies with an active site, for matching a person to the right one. */
  recruitingStudies(): Promise<StudyListing[]>;
  prescreenQuestions(trialId: string): Promise<Question[]>;
  /** The consent form to present; site-specific when the site has its own ICF. */
  consentDocument(trialId: string, siteId?: string | null): Promise<ConsentDocument | undefined>;
  siteHours(trialId: string): Promise<SiteHours[]>;
  /** What enrolled participants report in their check-ins. */
  checkInMeasures(trialId: string): Promise<CheckInMeasure[]>;
  /** Study-specific instructions for the patient-facing agent, if the study has any. */
  agentInstructions(trialId: string): Promise<string | undefined>;
}
