// The goals the assistant works toward in each phase. A playbook entry becomes a row in
// assistant.goals for that person's engagement. Trial knowledge can add goals (source
// "trial_knowledge"); staff and the agent can add more later.
import type { Phase } from "./phases.ts";

export interface GoalTemplate {
  key: string;
  title: string;
  instructions: string;
  priority: number;
  source: "playbook" | "trial_knowledge";
}

/** What the trial knowledge offers, as far as goals care. */
export interface PlaybookContext {
  hasPrescreen: boolean;
  hasConsentDocument: boolean;
  hasSiteHours: boolean;
  checkInMeasureCount: number;
}

export function goalsFor(phase: Phase, ctx: PlaybookContext): GoalTemplate[] {
  const goal = (key: string, title: string, instructions: string, priority: number, source: GoalTemplate["source"] = "playbook") =>
    ({ key, title, instructions, priority, source }) satisfies GoalTemplate;

  switch (phase) {
    case "prequalification":
      return [
        goal("welcome", "Welcome and learn their name",
          "Introduce yourself and the study in two sentences, ask what to call them, and remember it.", 10),
        goal("explain_study", "Explain the study",
          "Answer what they want to know. Offer the info card for the full overview (purpose, visits, time, compensation).", 20),
        ctx.hasPrescreen
          ? goal("collect_prescreen", "Complete the prescreen",
            "Once they're interested, send the prescreen card. If they already answered some questions in chat, record those with record_answer first.", 30, "trial_knowledge")
          : goal("collect_prescreen", "Complete the prescreen",
            "This study has no eligibility rules loaded yet. The prescreen card still collects the basics; a coordinator reviews the answers.", 30, "trial_knowledge"),
        goal("share_result", "Share the prescreen result",
          "After the prescreen, explain the outcome kindly and say what happens next.", 40),
      ];
    case "consent":
      return [
        goal("offer_consent", "Send the consent form",
          ctx.hasConsentDocument
            ? "Send the consent card. Explain that it walks through the study, checks a few key points, and asks for Face ID to sign."
            : "No approved consent form is active for this study yet (staff have been told). Tell them the study team will share it soon.", 10, "trial_knowledge"),
        goal("answer_consent_questions", "Answer their questions",
          "Make sure they feel free to ask anything before signing; answer from the consent form and study info, never guessing.", 20),
        goal("sign_consent", "Consent signed",
          "Done when the consent card reports a verified signature. If they hesitate, reassure them there's no rush.", 30),
      ];
    case "scheduling":
      return [
        goal("book_screening_visit", "Book the screening visit",
          ctx.hasSiteHours ? "Send the scheduler card so they can pick a site and time." : "No visit slots are configured. Escalate so a coordinator calls them.", 10, "trial_knowledge"),
        goal("visit_preparation", "Help them prepare",
          "Once booked, tell them what to bring: a photo ID and a list of their current medicines.", 20),
      ];
    case "screening":
      return [
        goal("visit_reminder", "Remind them about the visit",
          "Confirm the visit details and offer to reschedule with the scheduler card if needed.", 10),
        goal("await_enrollment", "Wait for enrollment",
          "Staff confirm eligibility and enrollment after the visit; the journey moves on by itself when they do. Answer questions in the meantime.", 20),
      ];
    case "active":
      return [
        ctx.checkInMeasureCount > 0
          ? goal("daily_check_in", "Daily check-in",
            "When a check-in is due, send the check-in card (or record answers they text with record_observation). It takes about a minute.", 10, "trial_knowledge")
          : goal("daily_check_in", "Daily check-in", "No measures are configured for this study; skip.", 10, "trial_knowledge"),
        goal("safety_watch", "Watch for side effects",
          "If they mention any new or worse symptom, report it with report_symptom (the study team gets an alert) and reassure them the team will follow up.", 20),
        goal("adherence_support", "Support dose adherence",
          "Gently encourage the daily dose; never shame a missed dose. Record what they tell you.", 30),
      ];
    default:
      return [
        goal("close_loop", "Close the loop kindly",
          "Respond to anything they ask, keep it brief and warm, and make it easy to come back.", 10),
      ];
  }
}
