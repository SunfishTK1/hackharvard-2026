import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// Texts people later ("remind me in 20 minutes to stretch"). Reminders are saved to
// disk, so they survive restarts and redeploys.

export type Reminder = {
  /** Derived from the message that asked for it, so a replayed event can't add a duplicate. */
  id: string;
  dueAt: string;
  to: { spaceId: string; senderId: string };
  handle: string;
  text: string;
  attempts: number;
};

const TICK_MS = 5_000;
const MAX_ATTEMPTS = 5;
export const MAX_PENDING_PER_PERSON = 20;

export function createReminders(file: URL, send: (reminder: Reminder) => Promise<void>) {
  let pending = load(file);
  let ticking = false;

  function save(): void {
    mkdirSync(new URL(".", file), { recursive: true });
    const temp = new URL(`${file.href}.tmp`);
    writeFileSync(temp, JSON.stringify(pending, null, 2));
    renameSync(temp, file);
  }

  /** Adds a reminder; false if this exact one was already added. */
  function add(reminder: Omit<Reminder, "attempts">): boolean {
    if (pending.some((r) => r.id === reminder.id)) return false;
    pending.push({ ...reminder, attempts: 0 });
    save();
    return true;
  }

  function countFor(handle: string): number {
    return pending.filter((r) => r.handle === handle).length;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      for (const reminder of pending.filter((r) => Date.parse(r.dueAt) <= now)) {
        try {
          await send(reminder);
          console.log(`⏰ → ${reminder.handle}: ${reminder.text}`);
          pending = pending.filter((r) => r.id !== reminder.id);
        } catch (error) {
          reminder.attempts++;
          console.error(`Reminder ${reminder.id} failed (attempt ${reminder.attempts}):`, error instanceof Error ? error.message : error);
          if (reminder.attempts >= MAX_ATTEMPTS) pending = pending.filter((r) => r.id !== reminder.id);
        }
        save();
      }
    } finally {
      ticking = false;
    }
  }

  function start(): void {
    setInterval(() => void tick(), TICK_MS).unref();
    if (pending.length) console.log(`${pending.length} reminder(s) scheduled.`);
  }

  return { add, countFor, start };
}

export type Reminders = ReturnType<typeof createReminders>;

function load(file: URL): Reminder[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(value) ? (value as Reminder[]) : [];
  } catch {
    return [];
  }
}
