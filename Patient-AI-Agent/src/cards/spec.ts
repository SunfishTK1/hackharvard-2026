// What a mini-app card says, independent of the channel. The Spectrum channel turns a CardSpec
// into an iMessage app card (static layout + rendered image); the console prints it.
import type { CardKind } from "../domain/phases.ts";

export interface CardSpec {
  /** A Sage mini-app, or a Trial Ops view ("ops:home"). */
  kind: CardKind | `ops:${string}`;
  url: string;
  /** Large text drawn into the card image. */
  headline: string;
  subline: string;
  /** Small chip in the image, e.g. "2 min" or "Signed". */
  badge: string;
  done: boolean;
  trialName: string;
  /** iMessage layout slots. */
  caption: string;
  subcaption: string;
  imageTitle: string;
  summary: string;
}

interface CardText {
  headline: string;
  subline: string;
  badge: string;
  caption: string;
  subcaption: string;
  imageTitle: string;
}

/** Facts a card can show: the prescreen length, a result or time, the study week, the next visit. */
export interface CardDetail {
  questions?: number;
  result?: string;
  when?: string;
  week?: number;
  weeks?: number;
  /** Check-in days this week (the weekly summary). */
  days?: number;
  /** The next visit's name and badge ("Tomorrow"). */
  visit?: string;
  badge?: string;
}

/** Card copy for each mini-app, before and after it's completed. */
export function cardText(kind: CardKind, done: boolean, detail: CardDetail = {}): CardText {
  switch (kind) {
    case "prescreen":
      return done
        ? { headline: "Pre-screening done.", subline: detail.result ?? "Thanks for your answers.", badge: "Done", caption: "Pre-screening complete", subcaption: detail.result ?? "Thanks for your answers", imageTitle: "" }
        : { headline: "See if you qualify.", subline: `${detail.questions ?? "A few"} quick questions.`, badge: "2 min", caption: "Pre-screening", subcaption: "About 2 minutes", imageTitle: "" };
    case "info":
      return { headline: "About the study.", subline: "What happens, visits, time and pay.", badge: "Overview", caption: "Study overview", subcaption: "Everything in one place", imageTitle: "" };
    case "consent":
      return done
        ? { headline: "Consent signed.", subline: detail.when ?? "Thank you.", badge: "Signed", caption: "Consent form signed", subcaption: detail.when ?? "Verified with Face ID", imageTitle: "" }
        : { headline: "Consent form.", subline: "Read it, then sign with Face ID.", badge: "10 min", caption: "Informed consent", subcaption: "Read, check, and sign", imageTitle: "" };
    case "schedule":
      return done
        ? { headline: "Visit booked.", subline: detail.when ?? "See you soon.", badge: "Booked", caption: "Screening visit booked", subcaption: detail.when ?? "Added to your calendar", imageTitle: "" }
        : { headline: "Book your visit.", subline: "Pick a time that works for you.", badge: "1 min", caption: "Screening visit", subcaption: "Choose a site and time", imageTitle: "" };
    case "checkin":
      return done
        ? { headline: "Daily check-in.", subline: "Blood pressure, pulse, medicine.", badge: "Done", caption: "Checked in", subcaption: detail.when ?? "Thank you", imageTitle: "" }
        : { headline: "Daily check-in.", subline: "Under a minute. Voice or taps.", badge: "1 min", caption: "Daily check-in", subcaption: "Under a minute", imageTitle: "" };
    case "document":
      return { headline: "Your documents.", subline: "Signed forms and visit details.", badge: "Face ID", caption: "Your documents", subcaption: "Opens with Face ID", imageTitle: "" };
    case "study":
      return { headline: "Your study.", subline: "Today's tasks and next visit.", badge: detail.week ? `Week ${detail.week}` : "Study", caption: "Your study",
        subcaption: detail.when ?? (detail.week && detail.weeks ? `Week ${detail.week} of ${detail.weeks}` : "Progress, tasks and visits"), imageTitle: "" };
    case "symptom":
      return { headline: "How are you feeling?", subline: "Tell the team about a symptom.", badge: "Anytime", caption: "Report a symptom", subcaption: "Goes straight to the team", imageTitle: "" };
    case "visit":
      return { headline: `${detail.visit ?? "Your next visit"}.`, subline: detail.when ?? "Time, place and what to bring.", badge: detail.badge ?? "Visit", caption: "Visit reminder", subcaption: "Tap for details and directions", imageTitle: "" };
    case "week":
      return { headline: "Your week.", subline: detail.days !== undefined ? `${detail.days} of 7 check-ins.` : "Check-ins and readings.", badge: detail.week ? `Week ${detail.week}` : "This week",
        caption: "Weekly summary", subcaption: "Your readings at a glance", imageTitle: "" };
  }
}

export function cardSpec(kind: CardKind, url: string, trialName: string, done = false, detail: Parameters<typeof cardText>[2] = {}): CardSpec {
  // Study cards are places to come back to, not tasks, so they never show as done.
  const finished = done && kind !== "study" && kind !== "symptom" && kind !== "visit" && kind !== "week";
  const text = cardText(kind, finished, detail);
  return { kind, url, trialName, done: finished, ...text, summary: `${text.caption}: ${text.subcaption}. ${url}` };
}
