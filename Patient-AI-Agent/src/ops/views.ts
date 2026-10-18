// The view models every Trial Ops surface shows (the iMessage mini-apps, the ops website), by
// name, so they all serve the same data the same way.
import * as data from "./data.ts";
import { ops } from "./db.ts";
import type { Manager } from "./store.ts";

export class ViewError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One view's JSON. `get` reads its parameters (study, code, id, status, severity); `fileUrl` makes
 * the URL an analysis report links its charts and tables to.
 */
export async function viewJson(m: Manager, view: string, get: (name: string) => string | undefined, fileUrl: (analysisId: string, name: string) => string): Promise<unknown> {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new ViewError(404, `No ${what} like that.`);
    return value;
  };
  const id = () => {
    const value = get("id");
    if (!value || !UUID.test(value)) throw new ViewError(400, "That id isn't valid.");
    return value;
  };
  switch (view) {
    case "home": return data.home(ops);
    case "approvals": return data.approvals(ops, get("study"));
    case "alerts": return { alerts: await data.alerts(ops, { study: get("study"), status: get("status"), severity: get("severity") }) };
    case "alert": return need(await data.alertDetail(ops, id()), "alert");
    case "study": return need(await data.study(ops, need(get("code") ?? get("study"), "study")), "study");
    case "participant": return need(await data.participant(ops, need(get("code"), "participant")), "participant");
    case "pipeline": return data.pipeline(ops, get("study"));
    case "quality": return data.quality(ops, get("study"));
    case "analyses": return { analyses: await data.analyses(ops, m.id) };
    case "analysis": {
      const analysisId = id();
      return need(await data.analysis(ops, m.id, analysisId, (name) => fileUrl(analysisId, name)), "analysis");
    }
  }
  throw new ViewError(404, "No such view.");
}

/** A chart or table from one of the manager's analyses. */
export async function analysisFile(m: Manager, analysisId: string, name: string): Promise<{ contentType: string; bytes: Buffer } | undefined> {
  if (!UUID.test(analysisId)) return undefined;
  const [f] = await ops<{ content_type: string; bytes: Buffer }>(
    `select f.content_type, f.bytes from ops.analysis_files f join ops.analyses a on a.id = f.analysis_id
     where f.analysis_id = $1 and f.name = $2 and a.manager_id = $3`, [analysisId, name, m.id]);
  return f && { contentType: f.content_type, bytes: f.bytes };
}

/** Headers for serving an analysis file: images inline, everything else (SVG, HTML too) as a download. */
export function fileHeaders(contentType: string, name: string, length: number): Record<string, string | number> {
  const inline = /^image\/(png|jpeg)$/.test(contentType);
  return {
    "content-type": contentType,
    "content-length": length,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
}
