import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Score {
  name: string;
  /** Seconds, rounded to 0.1. */
  time: number;
  at: string;
}

export interface Submission {
  entry: Score;
  /** 1-based position of this crew on the board. */
  rank: number;
  /** True when this time is a new course record. */
  record: boolean;
  /** True when this beat the crew's previous best (or is their first time). */
  improved: boolean;
}

/** 500 m at the boat's 16 m/s top speed. Anything faster did not come from the game. */
export const MIN_TIME = 31.3;
export const MAX_TIME = 3600;
const KEEP = 200;

export const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Trims, drops control characters and caps at 20 characters. Returns undefined when empty. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 20).trim();
  return name || undefined;
}

export function cleanTime(raw: unknown): number | undefined {
  const t = typeof raw === "string" ? Number(raw) : raw;
  if (typeof t !== "number" || !Number.isFinite(t) || t < MIN_TIME || t > MAX_TIME) return undefined;
  return Math.round(t * 10) / 10;
}

/** Best time per crew name, kept sorted and saved to a JSON file. */
export class Leaderboard {
  private scores: Score[] = [];
  private saving: Promise<void> = Promise.resolve();
  private readonly file: string;

  private constructor(dir: string) {
    this.file = join(dir, "leaderboard.json");
  }

  static async open(dir: string): Promise<Leaderboard> {
    await mkdir(dir, { recursive: true });
    const board = new Leaderboard(dir);
    try {
      const data = JSON.parse(await readFile(board.file, "utf8")) as { scores?: Score[] };
      board.scores = (data.scores ?? []).filter((s) => cleanName(s.name) && cleanTime(s.time)).sort(byTime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return board;
  }

  top(n = 10): Score[] {
    return this.scores.slice(0, n);
  }

  get size(): number {
    return this.scores.length;
  }

  get record(): Score | undefined {
    return this.scores[0];
  }

  /** Where `time` would place, 1-based. */
  rankOf(time: number): number {
    return this.scores.filter((s) => s.time < time).length + 1;
  }

  async submit(name: string, time: number): Promise<Submission> {
    const key = name.toLowerCase();
    const previous = this.scores.find((s) => s.name.toLowerCase() === key);
    const record = !this.record || time < this.record.time;
    const improved = !previous || time < previous.time;
    let entry = previous;
    if (improved) {
      entry = { name, time, at: new Date().toISOString() };
      this.scores = [...this.scores.filter((s) => s !== previous), entry].sort(byTime).slice(0, KEEP);
      await this.save();
    }
    return { entry: entry!, rank: this.rankOf(entry!.time), record, improved };
  }

  /** Writes are serialized and atomic (temp file + rename). */
  private save(): Promise<void> {
    const body = JSON.stringify({ scores: this.scores }, null, 2);
    this.saving = this.saving.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.file);
    });
    return this.saving;
  }
}

const byTime = (a: Score, b: Score) => a.time - b.time || a.at.localeCompare(b.at);
