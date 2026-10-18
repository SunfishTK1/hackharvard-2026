// Calls to this site's /api/agent/* (the server proxies them to the Trial Ops API).

export interface Result<T> {
  ok: boolean;
  status: number;
  body: T & { error?: string };
}

export async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<Result<T>> {
  try {
    const res = await fetch(`/api/agent/${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      signal: init.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, status: 0, body: { error: "You're offline, or the ops site can't be reached." } as T & { error?: string } };
  }
}

/** Query string from params, skipping empty values. */
export function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** A report file's API path (/v1/analyses/…) as this site serves it (/api/agent/analyses/…). */
export const fileUrl = (url: string) => url.replace(/^\/v1\//, "/api/agent/");
