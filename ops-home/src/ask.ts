// A question from the Classic page for Trial Ops. It's kept until Agentic mode sends it, through a
// sign-in if needed: the texted link may open in another tab, so it lives in localStorage (with an
// in-memory fallback when storage is blocked) and expires after 30 minutes.
const KEY = "trial-ops.ask";
const TTL_MS = 30 * 60_000;
let memory: { text: string; at: number } | null = null;

export function savePending(text: string): void {
  memory = { text, at: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // storage blocked (private mode): the in-memory copy still covers this tab
  }
}

function read(): { text: string; at: number } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to memory
  }
  return memory;
}

/** The question waiting to be sent, if it's still fresh. */
export function peekPending(): string | null {
  const p = read();
  return p && typeof p.text === "string" && Date.now() - p.at < TTL_MS ? p.text : null;
}

/** Takes the waiting question (so it's sent once). */
export function takePending(): string | null {
  const text = peekPending();
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  return text;
}
