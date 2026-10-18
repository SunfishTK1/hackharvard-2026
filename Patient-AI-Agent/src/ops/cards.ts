// Trial Ops cards: the same black card art as Sage's, with the view's headline and a live number.
import type { CardSpec } from "../cards/spec.ts";
import { config } from "../config.ts";
import type { View } from "./data.ts";

export interface OpsCardText { headline: string; subline: string; badge: string }

const COPY: Record<View, { headline: string; subline: string; badge: string; caption: string }> = {
  home: { headline: "Today in your trials.", subline: "Alerts, decisions and every study.", badge: "Live", caption: "Portfolio" },
  approvals: { headline: "Decisions waiting.", subline: "Enrollments, safety reviews, baselines.", badge: "Face ID", caption: "Decisions" },
  alerts: { headline: "Open alerts.", subline: "By severity, with who has each one.", badge: "Live", caption: "Alert queue" },
  alert: { headline: "An alert.", subline: "What happened and who has it.", badge: "Alert", caption: "Alert" },
  study: { headline: "Your study.", subline: "Sites, enrollment and check-ins.", badge: "Study", caption: "Study" },
  participant: { headline: "A participant.", subline: "Readings, alerts and timeline.", badge: "Record", caption: "Participant" },
  pipeline: { headline: "Enrollment pipeline.", subline: "Invited to active, and who's stuck.", badge: "Funnel", caption: "Pipeline" },
  quality: { headline: "Data quality.", subline: "Check-ins, quiet participants, flags.", badge: "7 days", caption: "Data quality" },
  analysis: { headline: "Your analysis.", subline: "Run on your own cloud computer.", badge: "Report", caption: "Analysis" },
};

export function opsCard(view: View, url: string, text: Partial<OpsCardText> = {}): CardSpec {
  const base = COPY[view];
  const headline = text.headline ?? base.headline;
  const subline = text.subline ?? base.subline;
  return {
    kind: `ops:${view}`, url, trialName: config.ops.name, done: false,
    headline, subline, badge: text.badge ?? base.badge,
    caption: base.caption, subcaption: subline.replace(/\.$/, ""), imageTitle: "",
    summary: `${base.caption}: ${subline} ${url}`,
  };
}
