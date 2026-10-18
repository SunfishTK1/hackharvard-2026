// Trial Ops' core, independent of any channel. One manager's turn takes their stored chat, runs the
// model with the ops tools, and returns the reply and any mini-app links; it also owns the analyst
// (Daytona computers). The iMessage adapter (agent.ts) and the HTTP API other apps use (api.ts, for
// example the ops website) are thin layers over this, so every surface gets the same agent.
import { Brain, describeError, withoutNotes } from "../agent/brain.ts";
import { config } from "../config.ts";
import { Analyst, type AnalysisDone } from "./analyst.ts";
import { opsCard, type OpsCardText } from "./cards.ts";
import * as computer from "./computer.ts";
import type { View } from "./data.ts";
import { ops } from "./db.ts";
import { opsMessages, opsSystemPrompt } from "./prompt.ts";
import * as store from "./store.ts";
import { opsTools } from "./tools.ts";

export const VIEW_TITLES: Record<View, string> = {
  home: "Portfolio", approvals: "Decisions", alerts: "Alert queue", alert: "Alert", study: "Study", participant: "Participant",
  pipeline: "Pipeline", quality: "Data quality", analysis: "Analysis",
};

/** A mini-app link from a turn: its view, its URL (the token in it is the credential) and its card copy. */
export interface OpsLink {
  cardId: string;
  view: View;
  params: Record<string, string>;
  title: string;
  url: string;
  text: Partial<OpsCardText>;
}

export interface OpsTurn {
  text: string;
  links: OpsLink[];
}

export interface OpsHooks {
  /** Asks Sage to follow up with a participant (their iMessage handle). */
  askSage?(handle: string, note: string): Promise<boolean>;
}

export class OpsCore {
  readonly analyst: Analyst | undefined;
  private readonly brain = new Brain({ model: config.ops.model, effort: config.ops.effort, thinking: true, maxIterations: 12 });
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners: ((done: AnalysisDone) => Promise<void>)[] = [];
  private readonly hooks: OpsHooks;

  constructor(hooks: OpsHooks = {}) {
    this.hooks = hooks;
    this.analyst = computer.computersEnabled() ? new Analyst((done) => this.analysisDone(done)) : undefined;
  }

  /** Called when an analysis finishes, by every surface that wants to tell the manager. */
  onAnalysisDone(listener: (done: AnalysisDone) => Promise<void>): void {
    this.listeners.push(listener);
  }

  /** Runs work for one manager after their earlier work, so their turns never overlap. */
  serial<T>(managerId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(managerId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(managerId, next);
    void next.catch(() => {}).finally(() => {
      if (this.queues.get(managerId) === next) this.queues.delete(managerId);
    });
    return next;
  }

  /** True while a manager has work queued (tests wait on it). */
  busy(managerId?: string): boolean {
    return managerId ? this.queues.has(managerId) : this.queues.size > 0;
  }

  /** Records what the manager said. Undefined for a replay of a message already seen. */
  async hear(m: store.Manager, text: string, options: { externalId?: string; externalSpaceId?: string } = {}): Promise<{ threadId: string } | undefined> {
    const thread = await store.ensureThread(ops, m.id, options.externalSpaceId);
    const id = await store.addMessage(ops, { threadId: thread.id, direction: "inbound", author: "manager", body: text, externalId: options.externalId });
    return id ? { threadId: thread.id } : undefined;
  }

  /** Something that happened outside the chat (a decision in a mini-app), for the model to know. */
  async note(managerId: string, text: string): Promise<void> {
    const thread = await store.ensureThread(ops, managerId);
    await store.addMessage(ops, { threadId: thread.id, direction: "inbound", author: "system", kind: "event", body: text });
  }

  /** One turn: the model reads the chat and answers with text and up to two mini-app links. */
  async reply(m: store.Manager, threadId: string, options: { trailingNote?: string; typing?: <T>(work: () => Promise<T>) => Promise<T> } = {}): Promise<OpsTurn> {
    const typing = options.typing ?? (<T>(work: () => Promise<T>) => work());
    const links: OpsLink[] = [];
    const tools = opsTools({
      manager: m,
      queueCard: async (view, params, text = {}, query) => {
        if (links.length >= 2) return "Two cards are already queued; that's enough for one reply.";
        links.push(await this.link(m, view, params, text, query));
        return `Queued: the ${VIEW_TITLES[view].toLowerCase()} card goes out after your reply. Now write the reply itself in words.`;
      },
      askSage: (code, note) => this.askSage(code, note),
      ...(this.analyst ? {
        startAnalysis: (title: string, request: string) => this.analyst!.start(m.id, title, request),
        shutDownComputer: () => computer.shutDown(m.id),
        computerStatus: () => computer.status(m.id),
      } : {}),
    });
    const studies = await store.managerStudies(ops, m.id);
    const transcript = await store.transcript(ops, threadId, 30);
    const system = opsSystemPrompt(m, studies, { computers: Boolean(this.analyst) });
    let text: string;
    try {
      text = withoutNotes(await typing(() => this.brain.reply(system, opsMessages(transcript, options.trailingNote), tools)));
      if (!text && links.length) {
        // A card alone isn't an answer: ask for the words, without tools this time.
        const queued = links.map((l) => `"${l.title}"`).join(", ");
        text = withoutNotes(await typing(() => this.brain.reply(system,
          opsMessages(transcript, `You queued the ${queued} card but wrote no reply. Write the reply now from what you found: the answer in a sentence, then up to three short lines.`), [])));
      }
    } catch (error) {
      console.error("ops: model failed", describeError(error));
      text = "Sorry, I'm having trouble reaching the data right now. Try again in a minute.";
    }
    if (text) await store.addMessage(ops, { threadId, direction: "outbound", author: "agent", body: text });
    for (const l of links) await store.addMessage(ops, { threadId, direction: "outbound", author: "agent", kind: "card", body: l.title });
    return { text, links };
  }

  /** What the manager says and what Trial Ops answers, in one call (for surfaces without their own transcript handling). */
  chat(m: store.Manager, text: string, options: { externalId?: string } = {}): Promise<OpsTurn | undefined> {
    return this.serial(m.id, async () => {
      const heard = await this.hear(m, text, options);
      return heard ? this.reply(m, heard.threadId) : undefined;
    });
  }

  /** A mini-app link for a manager, with live numbers for its card. */
  async link(m: store.Manager, view: View, params: Record<string, string>, text: Partial<OpsCardText> = {}, query?: string): Promise<OpsLink> {
    const card = await store.createCard(ops, m.id, view, params, text.headline ?? VIEW_TITLES[view]);
    const given = Object.fromEntries(Object.entries(text).filter(([, v]) => v)) as Partial<OpsCardText>;
    return { cardId: card.id, view, params, title: card.title, url: `${config.publicUrl}/o/${card.token}${query ? `?${query}` : ""}`, text: { ...(await this.cardText(view, params)), ...given } };
  }

  /** The iMessage card for a link. */
  card(l: OpsLink) {
    return opsCard(l.view, l.url, l.text);
  }

  private async cardText(view: View, params: Record<string, string>): Promise<Partial<OpsCardText>> {
    const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
    try {
      if (view === "home" || view === "approvals" || view === "alerts") {
        const [c] = await ops<{ open: number; high: number; decisions: number }>(
          `select (select count(*)::int from ops.alerts where status <> 'resolved') open,
                  (select count(*)::int from ops.alerts where status <> 'resolved' and severity in ('high', 'critical')) high,
                  (select count(*)::int from ops.tasks where status in ('pending', 'waiting_review') and action_type in ('confirm_enrollment', 'review_safety'))
                  + (select count(*)::int from ops.participants where status = 'enrolled') decisions`);
        if (view === "home") return { headline: c.high ? `${n(c.high, "high alert")}.` : `${n(c.decisions, "decision")} waiting.`, badge: "Today" };
        if (view === "approvals") return { headline: `${n(c.decisions, "decision")} waiting.`, badge: "Face ID" };
        return { headline: `${n(c.open, "open alert")}.`, badge: c.high ? `${c.high} high` : "Live" };
      }
      if (view === "study" && params.code) {
        const [s] = await ops<{ intervention: string | null; condition: string | null; study_code: string }>(
          "select intervention, condition, study_code from ops.studies where upper(study_code) = upper($1) or intervention ilike $1 || '%' limit 1", [params.code]);
        if (s) return { headline: `${s.intervention ?? s.study_code}.`, subline: `${s.condition ?? ""}. Sites, enrollment, check-ins.`, badge: s.study_code };
      }
      if (view === "participant" && params.code) return { headline: `${params.code.replace(/^STUDY-\d+-/, "")}.`, subline: "Readings, alerts and timeline.", badge: params.code.split("-").slice(0, 2).join("-") };
      if (view === "analysis" && params.id) {
        const [a] = await ops<{ title: string; status: string }>("select title, status from ops.analyses where id = $1", [params.id]);
        if (a) return { headline: a.title.length <= 34 ? a.title : `${a.title.slice(0, 33)}…`, subline: a.status === "done" ? "Summary, findings, charts and tables." : "Running on your computer.", badge: a.status === "done" ? "Report" : "Running" };
      }
    } catch (error) {
      console.error("ops: card text failed", describeError(error));
    }
    return {};
  }

  async askSage(code: string, note: string): Promise<boolean> {
    if (!this.hooks.askSage) return false;
    const [p] = await ops<{ id: string }>("select id from ops.participants where upper(participant_code) = upper($1)", [code.trim()]);
    if (!p) return false;
    const [h] = await ops<{ handle: string | null }>("select ops.sage_handle($1) as handle", [p.id]);
    return h?.handle ? this.hooks.askSage(h.handle, note) : false;
  }

  private async analysisDone(done: AnalysisDone): Promise<void> {
    const status = done.status === "done"
      ? `The analysis "${done.title}" (analysis_id ${done.id}) finished. Summary: ${done.summary}\nFindings: ${done.findings.join(" | ")}\nFiles: ${done.files.join(", ") || "none"}.`
      : `The analysis "${done.title}" (analysis_id ${done.id}) failed: ${done.error}`;
    await this.note(done.managerId, status).catch((error) => console.error("ops: analysis note failed", describeError(error)));
    for (const listener of this.listeners) await listener(done).catch((error) => console.error("ops: analysis listener failed", describeError(error)));
  }
}
