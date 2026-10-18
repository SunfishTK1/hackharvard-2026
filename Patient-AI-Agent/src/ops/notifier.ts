// Trial Ops reaching out on its own, once a minute: a text when new alerts at or above a manager's
// level come in at their studies (several at once go in one message, with the alert queue card),
// and the morning briefing at their time. ops.notices records each one before it's sent, so a
// restart or a second tick never sends it twice; only alerts raised after the manager was linked
// count, so linking someone doesn't replay history.
import { describeError } from "../agent/brain.ts";
import { config } from "../config.ts";
import type { OpsAgent } from "./agent.ts";
import { ops } from "./db.ts";
import type { Prefs } from "./store.ts";

const LEVELS: Record<Prefs["alerts"], string[]> = {
  all: ["low", "medium", "high", "critical"],
  high: ["high", "critical"],
  critical: ["critical"],
  off: [],
};
const ROLE: Record<string, string> = { principal_investigator: "investigator", coordinator: "coordinator", trial_manager: "trial manager" };
/** How long after its time a briefing still goes out (e.g. after a restart). */
const BRIEFING_WINDOW_MINUTES = 120;

export class Notifier {
  private readonly agent: OpsAgent;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(agent: OpsAgent) {
    this.agent = agent;
  }

  start(everyMs = 60_000): void {
    this.timer ??= setInterval(() => void this.tick(), everyMs);
    console.log(`ops: notifications on (alerts and the morning briefing, checked every ${Math.round(everyMs / 1000)} s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every active manager. Safe to call any time; passes never overlap. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const managers = await ops<{ id: string; prefs: Prefs; created_at: Date }>("select id, prefs, created_at from ops.managers where is_active");
      for (const m of managers) {
        await this.alerts(m.id, m.prefs, m.created_at).catch((error) => console.error("ops: alert notice failed", describeError(error)));
        await this.briefing(m.id, m.prefs, now).catch((error) => console.error("ops: briefing failed", describeError(error)));
      }
    } catch (error) {
      console.error("ops: notifications failed", describeError(error));
    } finally {
      this.running = false;
    }
  }

  private async alerts(managerId: string, prefs: Prefs, linkedAt: Date): Promise<void> {
    const levels = LEVELS[prefs.alerts ?? "high"] ?? LEVELS.high;
    if (!levels.length) return;
    // New, unresolved alerts at their studies, claimed in the same statement so they go once.
    const fresh = await ops<{ id: string; study_code: string; participant_code: string; severity: string; reason: string; assignee: string | null; assignee_role: string | null }>(
      `with mine as (
         select distinct x.study_id from ops.manager_staff ms join ops.staff x on x.staff_user_id = ms.staff_user_id and x.is_active where ms.manager_id = $1
       ), fresh as (
         select a.* from ops.alerts a
         where a.study_id in (select study_id from mine) and a.status <> 'resolved' and a.severity = any($2)
           and a.created_at > greatest($3::timestamptz, now() - interval '2 hours')
           and not exists (select 1 from ops.notices n where n.manager_id = $1 and n.kind = 'alert' and n.ref = a.id::text)
       ), claimed as (
         insert into ops.notices (manager_id, kind, ref) select $1, 'alert', id::text from fresh on conflict do nothing returning ref
       )
       select f.id, f.study_code, f.participant_code, f.severity, f.reason, f.assignee, f.assignee_role
       from fresh f join claimed c on c.ref = f.id::text order by f.created_at`, [managerId, levels, linkedAt]);
    if (!fresh.length) return;
    const who = (a: (typeof fresh)[number]) => (a.assignee ? `${a.assignee} (${ROLE[a.assignee_role ?? ""] ?? a.assignee_role}) has it.` : "No one is assigned.");
    const level = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
    if (fresh.length === 1) {
      const a = fresh[0];
      await this.agent.proactive(managerId, `${level(a.severity)} alert, ${a.participant_code}: ${a.reason.replace(/\.?$/, ".")} ${who(a)}`, { view: "alert", params: { id: a.id } });
    } else {
      const lines = fresh.slice(0, 4).map((a) => `${level(a.severity)}, ${a.participant_code}: ${a.reason.replace(/\.?$/, ".")}`);
      const more = fresh.length > 4 ? `\nAnd ${fresh.length - 4} more.` : "";
      await this.agent.proactive(managerId, `${fresh.length} new alerts:\n${lines.join("\n")}${more}`, { view: "alerts", params: {} });
    }
  }

  private async briefing(managerId: string, prefs: Prefs, now: Date): Promise<void> {
    const at = prefs.briefing ?? "08:00";
    if (at === "off") return;
    const local = now.toLocaleString("en-CA", { timeZone: config.timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const [day, time] = local.split(", ");
    const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const late = minutes(time.replace(/^24/, "00")) - minutes(at);
    if (late < 0 || late > BRIEFING_WINDOW_MINUTES) return;
    const [claimed] = await ops<{ ref: string }>(
      "insert into ops.notices (manager_id, kind, ref) values ($1, 'briefing', $2) on conflict do nothing returning ref", [managerId, day]);
    if (claimed) await this.agent.briefing(managerId);
  }
}
