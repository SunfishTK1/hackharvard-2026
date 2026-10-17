// Appointment slots from site hours, in the site's time zone. Pure, so it is easy to test.

export interface SiteHours {
  siteId: string;
  siteCode: string;
  siteName: string;
  city?: string;
  timeZone: string;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  weekday: number;
  opens: string; // "09:00"
  closes: string; // "16:00"
  slotMinutes: number;
}

export interface Slot {
  siteId: string;
  siteCode: string;
  start: string; // ISO instant
  end: string;
  localDate: string; // 2026-10-20, at the site
  localTime: string; // 09:00, at the site
  timeZone: string;
}

export interface SlotQuery {
  hours: SiteHours[];
  booked: { siteId: string; start: string }[];
  now: Date;
  days?: number;
  /** Earliest bookable time, in hours from now. */
  leadHours?: number;
  maxSlots?: number;
}

/** Minutes the time zone is ahead of UTC at an instant. */
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant) / 60_000;
}

/** The instant a wall-clock time happens in a time zone (DST-safe). */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall - offsetMinutes(wall, timeZone) * 60_000;
  const corrected = wall - offsetMinutes(utc, timeZone) * 60_000;
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

const isoWeekday = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
};

const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const toMinutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};
const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Open slots across sites, each in its own site's time zone. */
export function generateSlots({ hours, booked, now, days = 14, leadHours = 20, maxSlots = 80 }: SlotQuery): Slot[] {
  const earliest = now.getTime() + leadHours * 3_600_000;
  const taken = new Set(booked.map((b) => `${b.siteId}|${new Date(b.start).toISOString()}`));
  const slots: Slot[] = [];
  for (const h of hours) {
    const today = localDate(now, h.timeZone);
    for (let i = 0; i <= days; i++) {
      const date = addDays(today, i);
      if (isoWeekday(date) !== h.weekday) continue;
      for (let t = toMinutes(h.opens); t + h.slotMinutes <= toMinutes(h.closes); t += h.slotMinutes) {
        const start = zonedTime(date, toTime(t), h.timeZone);
        if (start.getTime() < earliest) continue;
        if (taken.has(`${h.siteId}|${start.toISOString()}`)) continue;
        const end = new Date(start.getTime() + h.slotMinutes * 60_000);
        slots.push({ siteId: h.siteId, siteCode: h.siteCode, start: start.toISOString(), end: end.toISOString(), localDate: date, localTime: toTime(t), timeZone: h.timeZone });
      }
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start) || a.siteCode.localeCompare(b.siteCode)).slice(0, maxSlots);
}
