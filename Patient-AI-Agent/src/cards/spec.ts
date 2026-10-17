// What a mini-app card says, independent of the channel. The Spectrum channel turns a CardSpec
// into an iMessage app card (static layout + rendered image); the console prints it.
import type { CardKind } from "../domain/phases.ts";

export interface CardSpec {
  kind: CardKind;
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

/** Card copy for each mini-app, before and after it's completed. */
export function cardText(kind: CardKind, done: boolean, detail: { questions?: number; result?: string; when?: string } = {}): CardText {
  switch (kind) {
    case "prescreen":
      return done
        ? { headline: "Pre-screening done", subline: detail.result ?? "Thanks for your answers", badge: "Done", caption: "Pre-screening complete", subcaption: detail.result ?? "Thanks for your answers", imageTitle: "Completed" }
        : { headline: "See if you qualify", subline: `${detail.questions ?? "A few"} quick questions`, badge: "2 min", caption: "Pre-screening", subcaption: "About 2 minutes", imageTitle: "Tap to start" };
    case "info":
      return { headline: "About the study", subline: "What happens, visits, time and pay", badge: "Overview", caption: "Study overview", subcaption: "Everything in one place", imageTitle: "Tap to read" };
    case "consent":
      return done
        ? { headline: "Consent signed", subline: detail.when ?? "Thank you", badge: "Signed", caption: "Consent form signed", subcaption: detail.when ?? "Verified", imageTitle: "View your copy" }
        : { headline: "Consent form", subline: "Read it, then sign with Face ID", badge: "10 min", caption: "Informed consent", subcaption: "Read, check, and sign", imageTitle: "Tap to review" };
    case "schedule":
      return done
        ? { headline: "Visit booked", subline: detail.when ?? "See you soon", badge: "Booked", caption: "Screening visit booked", subcaption: detail.when ?? "Added to your calendar", imageTitle: "Visit details" }
        : { headline: "Book your visit", subline: "Pick a time that works for you", badge: "1 min", caption: "Screening visit", subcaption: "Choose a site and time", imageTitle: "Tap to pick a time" };
    case "checkin":
      return done
        ? { headline: "Checked in", subline: detail.when ?? "Thanks for today", badge: "Done", caption: "Daily check-in done", subcaption: "Thank you", imageTitle: "Completed" }
        : { headline: "Daily check-in", subline: "How was today?", badge: "1 min", caption: "Daily check-in", subcaption: "Under a minute", imageTitle: "Tap to check in" };
    case "document":
      return { headline: "Your documents", subline: "Signed forms and visit details", badge: "Face ID", caption: "Your documents", subcaption: "Opens with Face ID", imageTitle: "Tap to open" };
  }
}

export function cardSpec(kind: CardKind, url: string, trialName: string, done = false, detail: Parameters<typeof cardText>[2] = {}): CardSpec {
  const text = cardText(kind, done, detail);
  return { kind, url, trialName, done, ...text, summary: `${text.caption}: ${text.subcaption}. ${url}` };
}
