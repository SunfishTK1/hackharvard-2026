// The workspace's shared pieces: pages and their routes (kept in the URL), the context views use to
// navigate, ask Trial Ops or show a toast, and a data hook that refreshes while the tab is visible.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AgentLink, Me } from "../agent-types";
import { call } from "./api";

export type Page =
  | "home" | "approvals" | "alerts" | "alert" | "studies" | "study" | "participants" | "participant"
  | "pipeline" | "quality" | "analyses" | "analysis" | "notifications";

export interface Route {
  page: Page;
  params: Record<string, string>;
}

const PAGES: Page[] = ["home", "approvals", "alerts", "alert", "studies", "study", "participants", "participant", "pipeline", "quality", "analyses", "analysis", "notifications"];
const PARAMS = ["code", "study", "id", "status", "severity", "q"];

export function routeFromUrl(): Route {
  const q = new URLSearchParams(location.search);
  const view = q.get("view") as Page | null;
  const page = view && PAGES.includes(view) ? view : "home";
  const params: Record<string, string> = {};
  for (const k of PARAMS) {
    const v = q.get(k);
    if (v) params[k] = v;
  }
  return { page, params };
}

export function urlFor(route: Route): string {
  const url = new URL(location.href);
  for (const k of ["view", ...PARAMS]) url.searchParams.delete(k);
  url.searchParams.set("mode", "agentic");
  if (route.page !== "home") url.searchParams.set("view", route.page);
  for (const [k, v] of Object.entries(route.params)) if (v) url.searchParams.set(k, v);
  url.hash = "";
  return url.toString();
}

/** Where a Trial Ops link (from chat, a card, the data) goes in the workspace. */
export function routeForLink(link: { view: string; params?: Record<string, string> }, title = "", url = ""): Route | null {
  const params: Record<string, string> = { ...(link.params ?? {}) };
  try {
    const u = new URL(url, location.origin);
    for (const k of PARAMS) {
      const v = u.searchParams.get(k);
      if (v && !params[k]) params[k] = v;
    }
  } catch {
    // not a URL
  }
  const participant = title.match(/STUDY-\d+-P\d+/i)?.[0];
  const study = title.match(/STUDY-\d+/i)?.[0];
  switch (link.view) {
    case "home": return { page: "home", params: {} };
    case "approvals": return { page: "approvals", params: params.study ? { study: params.study } : {} };
    case "alerts": return { page: "alerts", params };
    case "alert": return params.id ? { page: "alert", params: { id: params.id } } : { page: "alerts", params: {} };
    case "study": {
      const code = params.code ?? params.study ?? study;
      return code ? { page: "study", params: { code } } : { page: "studies", params: {} };
    }
    case "participant": {
      const code = params.code ?? participant;
      return code ? { page: "participant", params: { code: code.toUpperCase() } } : { page: "participants", params: {} };
    }
    case "pipeline": return { page: "pipeline", params: params.study ? { study: params.study } : {} };
    case "quality": return { page: "quality", params: params.study ? { study: params.study } : {} };
    case "analysis": return params.id ? { page: "analysis", params: { id: params.id } } : { page: "analyses", params: {} };
    case "analyses": return { page: "analyses", params: {} };
  }
  return null;
}

export interface Workspace {
  me: Me;
  go: (route: Route) => void;
  /** Sends a question to Trial Ops (opens the conversation). */
  ask: (question: string) => void;
  toast: (text: string) => void;
  /** Opens a Trial Ops link: natively when the workspace has the view, a decision for Face ID, else its page. */
  open: (link: AgentLink) => void;
  /** Bumps when something changed (a decision went through), so views reload. */
  version: number;
  changed: () => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside the workspace");
  return ws;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  reload: () => void;
}

/** GETs /api/agent/<path>, again every refreshMs while the tab is visible, and when `version` bumps. */
export function useData<T>(path: string | null, refreshMs = 60_000, version = 0): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; updatedAt: number | null }>({ data: null, error: null, loading: Boolean(path), updatedAt: null });
  const [tick, setTick] = useState(0);
  const pathRef = useRef(path);
  useEffect(() => {
    if (!path) return;
    const changedPath = pathRef.current !== path;
    pathRef.current = path;
    const abort = new AbortController();
    if (changedPath) setState({ data: null, error: null, loading: true, updatedAt: null });
    else setState((s) => ({ ...s, loading: true }));
    call<T>(path, { signal: abort.signal }).then((r) => {
      if (abort.signal.aborted) return;
      if (r.ok) setState({ data: r.body, error: null, loading: false, updatedAt: Date.now() });
      else setState((s) => ({ ...s, error: r.body.error ?? "This couldn't load. Try again.", loading: false }));
    }).catch(() => undefined);
    return () => abort.abort();
  }, [path, tick, version]);
  useEffect(() => {
    if (!path || !refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, refreshMs);
    return () => clearInterval(t);
  }, [path, refreshMs]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

/** "Updated 2 min ago" for a screen that refreshes itself. */
export function updatedLabel(at: number | null, now = Date.now()): string | undefined {
  if (!at) return undefined;
  const min = Math.floor((now - at) / 60_000);
  return min < 1 ? "Updated just now" : `Updated ${min} min ago`;
}
