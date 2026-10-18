// Check-in reminders: every few minutes, active participants whose check-in window has just opened
// hear from Sage with their check-in card. Once per window, only people who agreed to texts from the
// study team, not while they've paused reminders, and not in the first half hour after they start
// (Sage has just welcomed them). The database claims each window (assistant.claim_checkin_reminders).
import { shared } from "../db.ts";
import type { Assistant } from "./assistant.ts";
import { describeError } from "./brain.ts";

export class CheckInReminders {
  private readonly assistant: Assistant;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(assistant: Assistant) {
    this.assistant = assistant;
  }

  start(everyMs = 5 * 60_000): void {
    this.timer ??= setInterval(() => void this.tick(), everyMs);
    console.log(`reminders: check-in reminders on (every ${Math.round(everyMs / 60_000)} min)`);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await shared<{ handle: string; labels: string }>("select handle, labels from assistant.claim_checkin_reminders()");
      for (const d of due) {
        await this.assistant.nudge(d.handle,
          `Their check-in is open now (${d.labels}). Send their check-in card with one short, friendly line. If they already checked in today, say nothing.`);
      }
      if (due.length) console.log(`reminders: ${due.length} check-in reminder(s) sent`);
      return due.length;
    } catch (error) {
      console.error("reminders: failed", describeError(error));
      return 0;
    } finally {
      this.running = false;
    }
  }
}
