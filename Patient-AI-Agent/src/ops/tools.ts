// Trial Ops' tools. Reads come from the ops.* views through data.ts; the model can prepare a
// decision but only the manager's Face ID confirms it (approvals.ts), and it can ask Sage to follow
// up with a participant who talks to Sage. Results are compact JSON for the model.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { danceTool } from "../agent/dance.ts";
import { ApprovalError, prepare } from "./approvals.ts";
import * as data from "./data.ts";
import { ops } from "./db.ts";
import type { Manager } from "./store.ts";
import { ALERT_PREFS, APPROVAL_KINDS, prefs, setPrefs, type ApprovalKind } from "./store.ts";

export interface OpsToolContext {
  manager: Manager;
  /** Starts a heavy analysis on the manager's Daytona computer; undefined when computers are off. */
  startAnalysis?(title: string, request: string, machine?: "standard" | "large" | "gpu"): Promise<string>;
  /** Stops a running analysis. */
  stopAnalysis?(id: string): Promise<boolean>;
  /** Deletes the manager's computer now. */
  shutDownComputer?(): Promise<boolean>;
  computerStatus?(): Promise<unknown>;
  /** Queues a mini-app card to send right after the reply. */
  queueCard(view: data.View, params: Record<string, string>, text?: { headline?: string; subline?: string; badge?: string }, query?: string): Promise<string>;
  /** Asks Sage to follow up with a participant. False when Sage doesn't talk to them. */
  askSage(participantCode: string, note: string): Promise<boolean>;
  /** Queues the dancing crab (an easter egg) to go out right after the reply. */
  dance(): string;
}

const json = (value: unknown, max = 12_000) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (truncated; narrow the question)` : text;
};
const study = z.string().optional().describe("Study code, e.g. STUDY-005");

export function opsTools(ctx: OpsToolContext) {
  return [
    betaZodTool({
      name: "portfolio",
      description: "Today across every study: headline, decision and alert counts, each study's lifecycle counts, consent, open alerts, 7-day check-in completion, and what changed in the last day and a half.",
      inputSchema: z.object({}),
      run: async () => {
        const h = await data.home(ops);
        return json({ headline: h.headline, lede: h.lede, tiles: h.tiles.map(({ label, value, note }) => ({ label, value, note })), studies: h.studies, changes: h.changes.map(({ when, text, where, tag }) => ({ when, text, where, tag })) });
      },
    }),
    betaZodTool({
      name: "study_detail",
      description: "One study: lifecycle funnel, each site (investigator, coordinator, completion, overdue, open alerts), check-in completion by measure, every participant with status and open alerts, open alerts, recent changes, and Sage's recruitment funnel.",
      inputSchema: z.object({ study: z.string().describe("Study code (STUDY-005) or the start of its short name (BP-Link)") }),
      run: async ({ study: code }) => json((await data.study(ops, code)) ?? { error: `No study ${code}. Studies: ${(await data.studyCodes(ops)).join(", ")}` }),
    }),
    betaZodTool({
      name: "list_alerts",
      description: "Alerts, most urgent first: severity, status, reason, rule, who has it, age, and whether it came through Sage.",
      inputSchema: z.object({
        study,
        participant: z.string().optional().describe("Full participant code"),
        status: z.enum(["unresolved", "open", "acknowledged", "resolved", "all"]).optional().describe("Default unresolved"),
        severity: z.enum(["critical", "high", "medium", "low"]).optional(),
        since_hours: z.number().int().positive().max(24 * 90).optional(),
      }),
      run: async (f) => {
        const list = await data.alerts(ops, { study: f.study, participant: f.participant, status: f.status, severity: f.severity, sinceHours: f.since_hours, limit: 80 });
        return json({ count: list.length, alerts: list.map(({ id, study: s, participant, site, severity, status, reason, rule, assignee, assigneeRole, when, age, fromSage }) => ({ id, study: s, participant, site, severity, status, reason, rule, assignee, assigneeRole, when, age, fromSage })) });
      },
    }),
    betaZodTool({
      name: "alert_detail",
      description: "One alert in full: recommended action, who acknowledged or resolved it, resolution notes, the investigator's open review task if it's a safety review, and the participant's other alerts.",
      inputSchema: z.object({ alert_id: z.string().uuid() }),
      run: async ({ alert_id }) => json((await data.alertDetail(ops, alert_id)) ?? { error: "No such alert." }),
    }),
    betaZodTool({
      name: "decisions",
      description: "Decisions waiting: enrollments to confirm (signed consent, waiting days, assigned investigator, Sage's prescreen), safety reviews to sign off, and enrolled participants whose baseline visit isn't recorded. Includes the ids prepare_decision needs.",
      inputSchema: z.object({ study }),
      run: async ({ study: s }) => json(await data.approvals(ops, s)),
    }),
    betaZodTool({
      name: "participant_detail",
      description: "One participant: status, arm, consent, 14-day check-in adherence, readings for 21 days (flagged and corrected ones marked), alerts, timeline, message counts and their last message, next visit, and decisions pending for them.",
      inputSchema: z.object({ code: z.string().describe("Participant code, e.g. STUDY-005-P009 (or P009 when the study is clear)") }),
      run: async ({ code }) => json((await data.participant(ops, code)) ?? { error: `No participant ${code}.` }),
    }),
    betaZodTool({
      name: "find_participants",
      description: "Lists participants, filtered by study, status (consent_pending, consented, enrolled, active, completed, withdrawn, screen_failed), site name, or only those needing attention (open alerts or overdue check-ins).",
      inputSchema: z.object({ study, status: z.string().optional(), site: z.string().optional(), needs_attention: z.boolean().optional() }),
      run: async (f) => json(await data.findParticipants(ops, { study: f.study, status: f.status, site: f.site, needsAttention: f.needs_attention })),
    }),
    betaZodTool({
      name: "pipeline",
      description: "Enrollment pipeline: per-study stages (invited, opened, signed, declined, enrolled, active), median days between steps, who is stuck and for how long, and Sage's recruitment funnel.",
      inputSchema: z.object({ study }),
      run: async ({ study: s }) => {
        const p = await data.pipeline(ops, s);
        return json({ ...p, points: undefined, waitingForConfirmation: p.points.filter((x) => x.waiting) });
      },
    }),
    betaZodTool({
      name: "data_quality",
      description: "Data quality for the last 7 days: check-in completion by site and by measure, active participants gone quiet, readings flagged for review, corrected readings, undelivered messages, and device-reading gaps.",
      inputSchema: z.object({ study }),
      run: async ({ study: s }) => json(await data.quality(ops, s)),
    }),
    betaZodTool({
      name: "recent_changes",
      description: "What changed: alerts raised and participant events (consents, enrollments, activations, withdrawals), newest and most urgent first.",
      inputSchema: z.object({ hours: z.number().int().positive().max(24 * 30).optional().describe("Default 24"), study }),
      run: async ({ hours, study: s }) => json((await data.recentChanges(ops, hours ?? 24, s)).map(({ when, text, where, tag }) => ({ when, text, where, tag }))),
    }),
    betaZodTool({
      name: "staff_workload",
      description: "Who on the study teams has open alerts and reviews waiting, and how old the oldest is.",
      inputSchema: z.object({ study }),
      run: async ({ study: s }) => json(await data.workload(ops, s)),
    }),
    betaZodTool({
      name: "send_card",
      description: "Send a mini-app card (opens in iMessage) after your reply: home (portfolio), approvals (decisions), alerts, alert (needs alert_id), study (needs study), participant (needs code), pipeline, quality, analysis (an analysis report, needs analysis_id; without it, the list of analyses). Optionally give the card your own short headline (ends with a period).",
      inputSchema: z.object({
        view: z.enum(["home", "approvals", "alerts", "alert", "study", "participant", "pipeline", "quality", "analysis"]),
        study: z.string().optional(),
        code: z.string().optional().describe("Participant code, for the participant view"),
        alert_id: z.string().uuid().optional(),
        analysis_id: z.string().uuid().optional(),
        headline: z.string().max(40).optional(),
        subline: z.string().max(60).optional(),
      }),
      run: async ({ view, study: s, code, alert_id, analysis_id, headline, subline }) => {
        if (view === "study" && !s) return "The study view needs a study code.";
        if (view === "participant" && !code) return "The participant view needs a participant code.";
        if (view === "alert" && !alert_id) return "The alert view needs alert_id.";
        const params: Record<string, string> = {};
        if (s) params[view === "study" ? "code" : "study"] = s;
        if (code) params.code = code;
        if (alert_id) params.id = alert_id;
        if (analysis_id) params.id = analysis_id;
        return ctx.queueCard(view, params, { headline, subline });
      },
    }),
    ...(ctx.startAnalysis ? [
      betaZodTool({
        name: "start_analysis",
        description:
          "Hand heavy work to an analyst on the manager's own cloud computer (Daytona: Python with pandas, statsmodels, scikit-learn, lifelines, matplotlib) with a fresh snapshot of all the platform data. Use it for anything the other tools can't answer directly: statistics and models, forecasts (e.g. when a study reaches target), cohort and adherence analyses, survival curves, custom charts, data exports, simulations, written reports. It runs in the background for a few minutes; they get a message and a report card when it's done. Write the request as a complete brief: the question, the studies and time window, what to compare, and the charts or tables wanted.",
        inputSchema: z.object({
          title: z.string().min(3).max(80).describe("Short name for the analysis, ends with a period"),
          request: z.string().min(20).max(4000).describe("The full brief for the analyst"),
          machine: z.enum(["standard", "large", "gpu"]).optional().describe("standard (2 CPU, 4 GB) for almost everything; large (4 CPU, 8 GB) for big simulations or many models; gpu (1 NVIDIA GPU, 4 CPU, 16 GB) when they ask for a GPU or the work is deep learning. Default standard."),
        }),
        run: async ({ title, request, machine }) => {
          try {
            const id = await ctx.startAnalysis!(title, request, machine);
            await ctx.queueCard("analysis", { id }, { headline: title, subline: "Running on your computer.", badge: "Running" });
            return json({ started: title, analysis_id: id, next: "Its live status card goes out after your reply and updates itself when it's done. Tell them it's started and roughly what they'll get." });
          } catch (error) {
            return `Couldn't start it: ${(error as Error).message}`;
          }
        },
      }),
      betaZodTool({
        name: "analyses",
        description: "Their analyses (running and finished, newest first) and their computer's state: status, steps, summary, findings, files.",
        inputSchema: z.object({ analysis_id: z.string().uuid().optional() }),
        run: async ({ analysis_id }) => {
          if (analysis_id) return json((await data.analysis(ops, ctx.manager.id, analysis_id, (n) => n)) ?? { error: "No such analysis." });
          return json({ computer: await ctx.computerStatus?.(), analyses: await data.analyses(ops, ctx.manager.id, 10) });
        },
      }),
      betaZodTool({
        name: "stop_analysis",
        description: "Stop the analysis running on their computer (when they ask). The step in progress is cut off; nothing is reported.",
        inputSchema: z.object({ analysis_id: z.string().uuid() }),
        run: async ({ analysis_id }) => ((await ctx.stopAnalysis!(analysis_id)) ? "Stopped." : "That analysis isn't running."),
      }),
      betaZodTool({
        name: "shut_down_computer",
        description: "Delete the manager's cloud computer now (it also stops by itself after 30 idle minutes). Their reports stay.",
        inputSchema: z.object({}),
        run: async () => ((await ctx.shutDownComputer!()) ? "Their computer is shut down. Reports are kept." : "They don't have a computer running."),
      }),
    ] : []),
    betaZodTool({
      name: "prepare_decision",
      description:
        "Set up a decision for the manager to confirm with Face ID; you never make it yourself. Kinds: confirm_enrollment and decline_enrollment (target = the enrollment taskId), activate (record the baseline visit; target = participantId), review_safety (sign off; target = the safety taskId), acknowledge_alert and resolve_alert (target = alert id). decline_enrollment, review_safety and resolve_alert need a note in the manager's own words: ask them for it, never write a clinical judgment yourself. It checks the decision is possible and that they're authorized, then sends the confirm card.",
      inputSchema: z.object({
        kind: z.enum(APPROVAL_KINDS as [ApprovalKind, ...ApprovalKind[]]),
        target_id: z.string().uuid(),
        note: z.string().max(1000).optional().describe("The manager's own words, quoted from the chat"),
      }),
      run: async ({ kind, target_id, note }) => {
        try {
          const a = await prepare(ctx.manager, kind, target_id, note ?? null, "agent");
          await ctx.queueCard("approvals", {}, { headline: a.title, subline: a.lines[0]?.split(" · ")[0] ?? "Confirm with Face ID.", badge: "Face ID" }, `approval=${a.id}`);
          return json({ prepared: a.title, lines: a.lines, needsNote: a.needsNote && !a.note, sageFollowUp: a.sageFollowUp, next: "The confirm card goes out after your reply; they confirm with Face ID." });
        } catch (error) {
          if (error instanceof ApprovalError) return `Can't set that up: ${error.message}`;
          throw error;
        }
      },
    }),
    betaZodTool({
      name: "notifications",
      description: "See or change what Trial Ops texts them about on its own: new alerts at their studies (all, high = high and critical, critical, or off) and the morning briefing (a time HH:MM in the team's time zone, 24-hour, or off). Call with no arguments to see the current settings.",
      inputSchema: z.object({
        alerts: z.enum(ALERT_PREFS).optional(),
        briefing: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|off)$/).optional().describe("e.g. 07:30, or off"),
      }),
      run: async ({ alerts, briefing }) =>
        json(alerts || briefing ? { saved: await setPrefs(ops, ctx.manager.id, { ...(alerts ? { alerts } : {}), ...(briefing ? { briefing } : {}) }) } : await prefs(ops, ctx.manager.id)),
    }),
    betaZodTool({
      name: "ask_sage",
      description: "Ask Sage, the patient assistant, to follow up with a participant who talks to Sage (e.g. remind them to sign consent, or check in). Sage writes the message itself. Only when the manager asks for it.",
      inputSchema: z.object({ participant: z.string(), note: z.string().min(5).max(400).describe("What the study team wants Sage to do") }),
      run: async ({ participant, note }) =>
        (await ctx.askSage(participant, note)) ? "Sage will follow up with them now." : "Sage doesn't talk to this participant (they're on the platform's own messaging), so it can't follow up.",
    }),
    danceTool(() => ctx.dance()),
  ];
}
