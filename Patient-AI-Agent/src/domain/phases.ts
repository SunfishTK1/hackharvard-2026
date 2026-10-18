// The journey a person takes with a trial, and what the assistant is for in each phase.
// Transitions are guarded here, in code, so the model can ask to move but can't skip steps
// (no scheduling without a signed consent, no check-ins before enrollment).

export const PHASES = [
  "prequalification",
  "consent",
  "scheduling",
  "screening",
  "active",
  "completed",
  "not_eligible",
  "declined",
  "withdrawn",
] as const;
export type Phase = (typeof PHASES)[number];

export type CardKind = "prescreen" | "info" | "consent" | "schedule" | "checkin" | "document" | "study" | StudyView;

/** Cards that open one screen of the study page: report a symptom, the next visit, the week so far. */
export const STUDY_VIEWS = ["symptom", "visit", "week"] as const;
export type StudyView = (typeof STUDY_VIEWS)[number];
export const isStudyView = (kind: string): kind is StudyView => (STUDY_VIEWS as readonly string[]).includes(kind);

export interface PhaseDefinition {
  label: string;
  /** What the assistant is trying to achieve; goes into the prompt. */
  purpose: string;
  /** Tone and boundaries specific to this phase. */
  guidance: string;
  /** Mini-apps the assistant may send in this phase. */
  cards: CardKind[];
  /** Phases reachable from here. */
  next: Phase[];
  terminal?: boolean;
}

export const PHASE_DEFINITIONS: Record<Phase, PhaseDefinition> = {
  prequalification: {
    label: "Pre-qualification",
    purpose:
      "Help the person decide whether the study interests them, answer their questions, and find out whether they are likely eligible using the prescreen mini-app.",
    guidance:
      "They are not a participant yet. Be welcoming, explain plainly, never pressure. Collect eligibility answers with the prescreen card rather than one question at a time in chat, unless they prefer chat. Never tell someone they are definitely eligible; the study team decides.",
    cards: ["info", "prescreen"],
    next: ["consent", "not_eligible", "declined"],
  },
  consent: {
    label: "Informed consent",
    purpose:
      "Help them understand the study well enough to make a free, informed choice, and collect their e-signature on the consent form if they choose to join.",
    guidance:
      "Consent must be voluntary and unhurried. Encourage questions, check understanding, remind them they can say no or stop later. Send the consent card; it verifies identity with Face ID before signing. Never sign or agree on their behalf.",
    cards: ["consent", "info"],
    next: ["scheduling", "declined", "not_eligible"],
  },
  scheduling: {
    label: "Scheduling",
    purpose: "Book their screening visit at a convenient site and time with the scheduling mini-app, then help them prepare.",
    guidance: "Offer the scheduler card. Confirm the time and place clearly once booked, and share what to bring.",
    cards: ["schedule", "info", "document"],
    next: ["screening", "declined", "withdrawn"],
  },
  screening: {
    label: "Screening visit",
    purpose: "Get them to their screening visit prepared and on time, and answer questions while the site confirms eligibility.",
    guidance: "Send reminders and preparation tips. Rescheduling is fine. The site enrolls them after the visit.",
    cards: ["schedule", "info", "document"],
    next: ["active", "not_eligible", "withdrawn"],
  },
  active: {
    label: "Active participant",
    purpose:
      "Support them through the study: collect daily check-ins, catch side effects early, remind them about doses and visits, and keep them motivated.",
    guidance:
      "Keep check-ins quick (the check-in card takes a minute). Record any symptom they mention as a possible side effect and tell them the study team will follow up. For anything urgent or severe, tell them to call 911 or the study doctor right away. Never give medical advice or change doses.",
    cards: ["study", "checkin", "symptom", "visit", "week", "info", "document"],
    next: ["completed", "withdrawn"],
  },
  completed: {
    label: "Completed",
    purpose: "Thank them, answer questions about what happens next, and share results when available.",
    guidance: "Warm and appreciative. No more data collection.",
    cards: ["info", "document"],
    next: [],
    terminal: true,
  },
  not_eligible: {
    label: "Not eligible",
    purpose: "Close the loop kindly: explain in general terms why this study isn't a fit and offer to keep them in mind for future studies.",
    guidance: "Don't list sensitive reasons back at them unless they ask. Never make them feel at fault.",
    cards: ["info"],
    next: ["prequalification"],
    terminal: true,
  },
  declined: {
    label: "Declined",
    purpose: "Respect their decision. Answer any last questions and make it easy to come back.",
    guidance: "No persuasion. One short, kind message is enough.",
    cards: ["info"],
    next: ["prequalification"],
    terminal: true,
  },
  withdrawn: {
    label: "Withdrawn",
    purpose: "Respect their decision to stop, make sure the study team knows, and handle any safety follow-up the team needs.",
    guidance: "Withdrawal is always their right. Confirm it once, and let them know the team may ask about their safety.",
    cards: ["info", "document"],
    next: [],
    terminal: true,
  },
};

/** What the engine knows when deciding whether a move is allowed. */
export interface TransitionFacts {
  eligibility: "unknown" | "likely_eligible" | "needs_review" | "not_eligible";
  hasSignedConsent: boolean;
  hasBookedAppointment: boolean;
  isEnrolled: boolean;
}

/** Why a move isn't allowed yet, or undefined if it is. */
export function transitionBlocker(from: Phase, to: Phase, facts: TransitionFacts): string | undefined {
  if (from === to) return "already in that phase";
  if (!PHASE_DEFINITIONS[from].next.includes(to)) return `can't move from ${from} to ${to}`;
  switch (to) {
    case "consent":
      // Consent comes before the screening visit, where staff confirm eligibility; answers that
      // need a person's review don't hold up the consent conversation.
      return facts.eligibility === "likely_eligible" || facts.eligibility === "needs_review" ? undefined : "the prescreen hasn't passed";
    case "not_eligible":
      return facts.eligibility === "not_eligible" || from === "screening" ? undefined : "the prescreen hasn't ruled them out";
    case "scheduling":
      return facts.hasSignedConsent ? undefined : "they haven't signed the consent form";
    case "screening":
      return facts.hasBookedAppointment ? undefined : "no screening visit is booked";
    case "active":
      return facts.isEnrolled ? undefined : "site staff haven't enrolled them";
    case "prequalification":
      return undefined; // starting over after declining or not qualifying
    default:
      return undefined; // completed, declined, withdrawn: always allowed when listed in `next`
  }
}
