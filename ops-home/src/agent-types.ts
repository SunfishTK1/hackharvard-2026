// What the Trial Ops API returns (Patient-AI-Agent/src/ops/api.ts), as Agentic mode uses it.

export interface AgentLink {
  view: string;
  title: string;
  url: string;
  /** The view's parameters (study, code, id), when Trial Ops sends them. */
  params?: Record<string, string>;
}

export interface AgentMessage {
  id: string;
  at: string;
  author: "manager" | "agent";
  kind: "text" | "card";
  body: string;
  link: AgentLink | null;
}

export interface Me {
  name: string;
  manager: { name: string };
  studies: { code: string; role: string }[];
  computers: boolean;
  /** Whether they have a passkey for this site, so Face ID can sign them in. */
  faceIdSignIn?: boolean;
}

export type AnalysisPhase = "starting" | "installing" | "loading" | "analyzing" | "saving" | "done" | "failed" | "cancelled";

export interface AnalysisSummary {
  id: string;
  title: string;
  request: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** Where a running analysis is: its computer starting, data loading, the analyst working, the report saving. */
  phase?: AnalysisPhase;
  /** Seconds since it started (or how long it took). */
  elapsedSeconds?: number;
  when: string;
  finished: string | null;
  steps: number;
}

export interface ChatReply {
  reply: { text: string; links: AgentLink[] };
}
